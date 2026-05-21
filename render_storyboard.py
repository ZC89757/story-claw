"""
render_storyboard.py — 读取分镜 JSONL，每个 panel 生图→生视频，最后拼接为完整视频

视频策略:
  - 每个 panel 独立调用 alibaba/happyhorse-1.0 图生视频
  - 每个 panel 有独立的 LLM 视频提示词，参考上一 panel 上下文保持连贯

用法:
  python render_storyboard.py <jsonl路径>
"""

import os
os.environ.pop("HTTPS_PROXY", None)
os.environ.pop("HTTP_PROXY",  None)
os.environ.pop("https_proxy", None)
os.environ.pop("http_proxy",  None)
os.environ["NO_PROXY"] = "*"
os.environ["no_proxy"] = "*"

import sys
import re
import json
import time
import base64
import subprocess
import asyncio
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from openai import OpenAI
from google import genai
from google.genai import types
import httpx
from openai import AsyncOpenAI

# ── 从 ~/.story-claw/ 读取配置 ────────────────────────────────────────────────

_CONFIG_DIR = Path.home() / ".story-claw"

def _load_config(name: str) -> dict:
    p = _CONFIG_DIR / name
    if not p.exists():
        raise FileNotFoundError(f"配置文件不存在: {p}\n请先创建该文件。")
    return json.loads(p.read_text(encoding="utf-8"))

_img_cfg   = _load_config("image_gen_config.json")
_vid_cfg   = _load_config("video_config.json")
_llm_cfg   = _load_config("config.json")
_tts_cfg   = _load_config("tts_config.json")

# ── 配置 ──────────────────────────────────────────────────────────────────────

IMAGE_API_KEY  = _img_cfg["api_key"]
IMAGE_BASE_URL = _img_cfg.get("base_url", "https://zenmux.ai/api/vertex-ai")
IMAGE_MODEL    = _img_cfg.get("model", "openai/gpt-image-2")

VIDEO_API_KEY  = _vid_cfg["api_key"]
VIDEO_BASE_URL = _vid_cfg.get("base_url", "https://zenmux.ai/api/vertex-ai")

# 视频模型优先级：依次尝试，触发真人检查直接跳到 veo
VIDEO_MODELS = _vid_cfg.get("models", [
    "bytedance/doubao-seedance-2.0",
    "bytedance/doubao-seedance-1.5-pro",
    "google/veo-3.1-generate-001",
])
REAL_PERSON_KEYWORDS = ["real person", "realPerson", "real_person", "human face",
                        "face detection", "真人", "人脸"]

# 各模型支持的时长列表（秒），不在列表里则取最近值
VIDEO_MODEL_DURATIONS: dict[str, list[int]] = {
    "google/veo-3.1-generate-001": [4, 6, 8],
}

def _clamp_duration(model: str, duration: int) -> int:
    supported = VIDEO_MODEL_DURATIONS.get(model)
    if not supported:
        return duration
    return min(supported, key=lambda d: abs(d - duration))

VIDEO_DURATION = _vid_cfg.get("default_duration", 5)

LLM_API_KEY  = _llm_cfg["api_key"]
LLM_BASE_URL = _llm_cfg.get("base_url", "https://zenmux.ai/api/v1")
LLM_MODEL    = _llm_cfg.get("model", "anthropic/claude-sonnet-4.6")

# 并发限制
IMAGE_CONCURRENCY = _img_cfg.get("concurrency", 4)
VIDEO_CONCURRENCY = _vid_cfg.get("concurrency", 4)

# 调试开关：只生图，跳过视频
SKIP_VIDEO = False

# ── MiMo TTS 配置 ─────────────────────────────────────────────────────────────

MIMO_API_KEY    = _tts_cfg["api_key"]
MIMO_BASE_URL   = _tts_cfg.get("base_url", "https://token-plan-cn.xiaomimimo.com/v1")
MIMO_CHAT_MODEL = _tts_cfg.get("chat_model", "mimo-v2.5-pro")
MIMO_TTS_MODEL  = _tts_cfg.get("tts_model", "mimo-v2.5-tts")
MIMO_PROXY      = _tts_cfg.get("proxy", "http://127.0.0.1:7890")

MIMO_VOICES          = _tts_cfg.get("voices", {"冰糖": "女", "茉莉": "女", "苏打": "男", "白桦": "男"})
MIMO_NARRATOR_VOICE  = _tts_cfg.get("narrator_voice", "白桦")
MIMO_TTS_CONCURRENCY = _tts_cfg.get("concurrency", 4)

# 仅全量渲染（无 --only-group）时才启用 TTS
ENABLE_TTS = True

# 重试配置
IMAGE_MAX_RETRIES = 5
IMAGE_RETRY_SLEEP = 3
VIDEO_MAX_RETRIES = 3
VIDEO_RETRY_SLEEP = 5

# ── 客户端 ─────────────────────────────────────────────────────────────────────

image_client = genai.Client(
    api_key=IMAGE_API_KEY,
    vertexai=True,
    http_options=types.HttpOptions(api_version="v1", base_url=IMAGE_BASE_URL),
)

video_client = genai.Client(
    api_key=VIDEO_API_KEY,
    vertexai=True,
    http_options=types.HttpOptions(api_version="v1", base_url=VIDEO_BASE_URL),
)

llm_client = OpenAI(api_key=LLM_API_KEY, base_url=LLM_BASE_URL)

# ── 资源目录构建 ───────────────────────────────────────────────────────────────

def build_resource_catalog(workspace_dir: Path) -> tuple[str, dict]:
    chars_dir  = workspace_dir / "characters"
    scenes_dir = workspace_dir / "scenes"

    lines = []
    path_map: dict[str, Path] = {}

    lines.append("== 可用角色资源 ==")
    for json_path in sorted(chars_dir.glob("*.json")):
        try:
            data = json.loads(json_path.read_text(encoding="utf-8"))
        except Exception:
            continue
        name        = data.get("name", json_path.stem)
        base_prompt = data.get("base_prompt", "")

        proto_png = chars_dir / f"{name}_原型.png"
        if proto_png.exists():
            lines.append(f"路径: {proto_png}")
            lines.append(f"  描述: {name} 原型 — {base_prompt}")
            path_map[str(proto_png)] = proto_png

        for st in data.get("stages", []):
            stage     = st.get("stage", "")
            st_prompt = st.get("prompt", "")
            stage_png = chars_dir / f"{name}_{stage}.png"
            if stage_png.exists():
                lines.append(f"路径: {stage_png}")
                lines.append(f"  描述: {name} 造型/{stage} — {st_prompt}")
                path_map[str(stage_png)] = stage_png

    lines.append("")
    lines.append("== 可用场景资源 ==")
    for json_path in sorted(scenes_dir.glob("*.json")):
        try:
            data = json.loads(json_path.read_text(encoding="utf-8"))
        except Exception:
            continue
        location    = data.get("location", json_path.stem)
        base_prompt = data.get("base_prompt", "")

        base_png = scenes_dir / f"{location}.png"
        if base_png.exists():
            soft_desc = "  ".join(
                f"{k}: {v}" for k, v in data.get("soft_scenes", {}).items()
            )
            lines.append(f"路径: {base_png}")
            lines.append(f"  描述: {location} — {base_prompt}  {soft_desc}")
            path_map[str(base_png)] = base_png

    return "\n".join(lines), path_map


# ── 资源选择 + 图片提示词 LLM ─────────────────────────────────────────────────

RESOURCE_SELECTOR_BASE = """\
你是分镜资源选择专员。根据 panel 信息和可用资源，选出最合适的参考图列表，并微调生图提示词。

规则：
1. 从资源目录中选出与 panel 相关的角色图和场景图
2. 景别决定选图策略：
   - 特写 / 近景：优先选角色图（面部细节重要），场景图可省略
   - 中景：角色图 + 场景图
   - 全景 / 远景：场景图为主，角色图可选
3. 角色造型图优先于原型图（如有与当前剧情匹配的造型阶段）
4. 改写 image_prompt：将原提示词中对人物外貌的文字描述替换为 "the person in image N"，
   对场景/背景的文字描述替换为 "the background in image N"（N 从 1 开始，与 reference_images 顺序一致）
   保留所有动作、姿态、情绪、景别、光影等描述
5. 若无合适资源，reference_images 输出空数组，image_prompt 保持原文不变
6. 只做微调补充，不大幅改写原有 image_prompt 的内容和结构

reference_images 中每项必须包含资源目录里"路径:"后面的完整路径字符串（不得修改）和 role 字段。\
"""

RESOURCE_SELECTOR_CONTINUITY = """
7. 连贯性要求：根据上一 panel 的信息，确保本 panel 图片与上一 panel 在空间布局、人物位置、
   动作方向上自然衔接。如有冲突，在 image_prompt 中补充衔接描述，但不得大幅改写原有内容。\
"""

RESOURCE_SELECTOR_SUFFIX = """
只输出 JSON，不要任何其他文字：
{
  "reference_images": [
    {"path": "完整路径", "role": "主体角色"},
    {"path": "完整路径", "role": "背景场景"}
  ],
  "image_prompt": "改写后的生图提示词"
}\
"""


def select_resources(
    panel: dict,
    resource_catalog: str,
    path_map: dict,
    text: str = "",
    prev_panel_context: dict | None = None,
) -> tuple[list[Path], str]:
    # 组装系统提示
    system = RESOURCE_SELECTOR_BASE
    if prev_panel_context:
        system += RESOURCE_SELECTOR_CONTINUITY
    system += RESOURCE_SELECTOR_SUFFIX

    # 组装用户消息
    parts = [
        "== panel 信息 ==",
        f"shot_type: {panel.get('shot_type', '')}",
        f"trigger: {panel.get('trigger', '')}",
        f"image_prompt: {panel.get('image_prompt', '')}",
    ]
    if text:
        parts.append(f"\n原文: {text}")
    if prev_panel_context:
        parts.append("\n== 上一 panel 上下文 ==")
        parts.append(f"shot_type: {prev_panel_context.get('shot_type', '')}")
        parts.append(f"image_prompt: {prev_panel_context.get('image_prompt', '')}")
        parts.append(f"video_prompt: {prev_panel_context.get('video_prompt', '')}")
    parts.append(f"\n{resource_catalog}")

    user_msg = "\n".join(parts)

    resp = llm_client.chat.completions.create(
        model=LLM_MODEL,
        messages=[
            {"role": "system", "content": system},
            {"role": "user",   "content": user_msg},
        ],
        temperature=0,
    )
    raw = resp.choices[0].message.content.strip()

    if "```" in raw:
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]

    result       = json.loads(raw.strip())
    refs_raw     = result.get("reference_images", [])
    image_prompt = result.get("image_prompt", panel.get("image_prompt", ""))

    ref_paths = []
    for item in refs_raw:
        p_str = item.get("path", "") if isinstance(item, dict) else item
        p = path_map.get(p_str) or path_map.get(str(Path(p_str)))
        if p and p.exists():
            ref_paths.append(p)
        else:
            print(f"    [资源] 找不到: {p_str}，跳过")

    return ref_paths, image_prompt


# ── 视频提示词 LLM（每 panel 独立） ──────────────────────────────────────────

VIDEO_PROMPT_SYSTEM = """\
你是视频分镜提示词专员。根据当前 panel 信息和上一 panel 上下文（若有），生成一段用于图生视频的提示词。

规则：
1. 基于原有 video_prompt 微调补充，不大幅改写其内容和结构
2. 若有上一 panel 上下文：
   - 描述从上一 panel 结束状态自然过渡到本 panel 的镜头运动或人物动作
   - 处理景别变化：上一近景→本全景 = 描述镜头拉远；上一全景→本近景 = 描述镜头推近
   - 去除本 panel 原有 video_prompt 中与上一 panel 矛盾的镜头描述（如"stays fixed"但景别变了）
3. 若无上一 panel 上下文（首帧）：直接微调 video_prompt，无需描述过渡
4. 若 video_prompt 包含台词（引号内的中文），必须原文保留台词
5. 提示词长度控制在 60-100 词（英文）
6. 只输出 JSON，不要其他文字

输出格式：
{"video_prompt": "生成的视频提示词"}
"""


def generate_video_prompt(
    panel: dict,
    text: str = "",
    prev_panel_context: dict | None = None,
) -> str:
    """调用 LLM 为单个 panel 生成视频提示词"""
    parts = [
        "== panel 信息 ==",
        f"shot_type: {panel.get('shot_type', '')}",
        f"trigger: {panel.get('trigger', '')}",
        f"video_prompt (原始): {panel.get('video_prompt', '')}",
    ]
    if text:
        parts.append(f"\n原文: {text}")
    if prev_panel_context:
        parts.append("\n== 上一 panel 上下文 ==")
        parts.append(f"shot_type: {prev_panel_context.get('shot_type', '')}")
        parts.append(f"image_prompt: {prev_panel_context.get('image_prompt', '')}")
        parts.append(f"video_prompt: {prev_panel_context.get('video_prompt', '')}")

    user_msg = "\n".join(parts)

    resp = llm_client.chat.completions.create(
        model=LLM_MODEL,
        messages=[
            {"role": "system", "content": VIDEO_PROMPT_SYSTEM},
            {"role": "user",   "content": user_msg},
        ],
        temperature=0.3,
    )
    raw = resp.choices[0].message.content.strip()

    if "```" in raw:
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]

    result = json.loads(raw.strip())
    return result.get("video_prompt", panel.get("video_prompt", ""))


# ── 图片生成 ───────────────────────────────────────────────────────────────────

def _generate_image_sync(prompt: str, ref_paths: list[Path], output_path: Path) -> Path:
    print(f"    [生图] 提交: {output_path.name}（参考图 {len(ref_paths)} 张）")
    last_err = None
    for attempt in range(1, IMAGE_MAX_RETRIES + 1):
        try:
            if ref_paths:
                reference_images = [
                    types.RawReferenceImage(
                        reference_id=i + 1,
                        reference_image=types.Image(
                            image_bytes=p.read_bytes(), mime_type="image/png"
                        ),
                    )
                    for i, p in enumerate(ref_paths)
                ]
                resp = image_client.models.edit_image(
                    model=IMAGE_MODEL, prompt=prompt,
                    reference_images=reference_images,
                )
            else:
                resp = image_client.models.generate_images(
                    model=IMAGE_MODEL, prompt=prompt,
                )
            images = resp.generated_images
            if not images:
                raise RuntimeError(f"未返回图片: {output_path.name}")
            image_bytes = images[0].image.image_bytes
            if not image_bytes:
                raise RuntimeError(f"无法提取图片数据: {output_path.name}")
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_bytes(image_bytes)
            print(f"    [生图] 已保存: {output_path.name}")
            return output_path
        except Exception as e:
            last_err = e
            if attempt < IMAGE_MAX_RETRIES:
                print(f"    [生图] 第 {attempt} 次失败: {e}，{IMAGE_RETRY_SLEEP}s 后重试...")
                time.sleep(IMAGE_RETRY_SLEEP)
            else:
                print(f"    [生图] 全部 {IMAGE_MAX_RETRIES} 次均失败: {e}")
    raise RuntimeError(f"生图失败（{IMAGE_MAX_RETRIES}次）: {output_path.name}") from last_err


async def generate_image(
    img_sem: asyncio.Semaphore, executor: ThreadPoolExecutor,
    prompt: str, ref_paths: list[Path], output_path: Path,
) -> Path:
    async with img_sem:
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(
            executor, _generate_image_sync, prompt, ref_paths, output_path
        )


# ── 视频生成：单图（happyhorse） ───────────────────────────────────────────────

def _is_real_person_error(err: Exception) -> bool:
    msg = str(err).lower()
    return any(k.lower() in msg for k in REAL_PERSON_KEYWORDS)


def _try_generate_video(model: str, img_bytes: bytes, prompt: str,
                        output_path: Path, duration: int) -> Path:
    """用指定模型尝试生成视频，成功返回路径，失败抛异常。"""
    op = video_client.models.generate_videos(
        model=model,
        prompt=prompt,
        image=types.Image(image_bytes=img_bytes, mime_type="image/png"),
        config=types.GenerateVideosConfig(
            aspectRatio="16:9",
            resolution="1080p",
            durationSeconds=duration,
        ),
    )
    print(f"    [视频] operation={op.name}，轮询中...")
    while op.done is not True:
        time.sleep(15)
        op = video_client.operations.get(op)

    if op.error:
        raise RuntimeError(f"API 错误: {op.error}")

    resp = op.response
    if resp is None:
        raise RuntimeError("resp 为 None")

    videos = getattr(resp, "generated_videos", None)
    if not videos:
        rai = getattr(resp, "rai_media_filtered_reasons", None)
        raise RuntimeError(f"未返回视频，RAI={rai}")

    video       = videos[0].video
    video_bytes = None
    if hasattr(video, "video_bytes") and video.video_bytes:
        video_bytes = video.video_bytes
    elif hasattr(video, "uri") and video.uri:
        import urllib.request
        video_bytes = urllib.request.urlopen(video.uri).read()

    if not video_bytes:
        raise RuntimeError(f"无法提取视频数据: {output_path.name}")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(video_bytes)
    print(f"    [视频] 已保存: {output_path.name}")
    return output_path


def _generate_video_sync(image_path: Path, prompt: str, output_path: Path, duration: int = VIDEO_DURATION) -> Path:
    img_bytes  = image_path.read_bytes()
    models     = list(VIDEO_MODELS)
    last_err   = None
    mi         = 0

    while mi < len(models):
        model = models[mi]
        clamped = _clamp_duration(model, duration)
        if clamped != duration:
            print(f"    [视频] {model} 不支持 {duration}s，调整为 {clamped}s")
        print(f"    [视频] 提交: {output_path.name}（{clamped}s, {model}）")
        for attempt in range(1, VIDEO_MAX_RETRIES + 1):
            try:
                return _try_generate_video(model, img_bytes, prompt, output_path, clamped)
            except Exception as e:
                last_err = e
                if _is_real_person_error(e):
                    print(f"    [视频] 触发真人检查，切换到下一个模型")
                    break
                elif attempt < VIDEO_MAX_RETRIES:
                    print(f"    [视频] 第 {attempt} 次失败: {e}，{VIDEO_RETRY_SLEEP}s 后重试...")
                    time.sleep(VIDEO_RETRY_SLEEP)
                else:
                    print(f"    [视频] {model} 全部失败，尝试下一个模型")
            else:
                break   # 成功则跳出 retry 循环
        mi += 1

    raise RuntimeError(f"所有模型均失败: {output_path.name}") from last_err


async def generate_video(
    vid_sem: asyncio.Semaphore, executor: ThreadPoolExecutor,
    image_path: Path, prompt: str, output_path: Path,
    duration: int = VIDEO_DURATION,
) -> Path:
    async with vid_sem:
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(
            executor, _generate_video_sync, image_path, prompt, output_path, duration
        )


# ── 视频拼接 ──────────────────────────────────────────────────────────────────

def concat_videos(video_paths: list[Path], output: Path) -> None:
    """拼接视频，用 cwd 规避中文路径问题"""
    out_dir     = output.parent
    concat_list = out_dir / f"_concat_{output.stem}.txt"
    with open(concat_list, "w", encoding="utf-8") as f:
        for p in video_paths:
            f.write(f"file '{p.name}'\n")

    cmd = [
        "ffmpeg", "-y",
        "-f", "concat", "-safe", "0",
        "-i", concat_list.name,
        "-c:v", "copy",
        "-c:a", "aac", "-ar", "44100", "-ac", "2",
        output.name,
    ]
    print(f"  拼接 {len(video_paths)} 段 → {output.name}")
    subprocess.run(cmd, check=True, cwd=str(out_dir),
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print(f"  拼接完成: {output.name}")


# ── 提取视频最后一帧 ──────────────────────────────────────────────────────────

def extract_last_frame(video_path: Path, output_path: Path) -> bool:
    """用 ffmpeg 提取视频最后一帧，返回是否成功"""
    try:
        subprocess.run([
            "ffmpeg", "-y",
            "-sseof", "-0.5",
            "-i", video_path.name,
            "-frames:v", "1",
            output_path.name,
        ], check=True, cwd=str(video_path.parent),
           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return output_path.exists()
    except Exception as e:
        print(f"    [提帧] 失败 {video_path.name}: {e}")
        return False


# ── 处理单个 panel：资源选择 + 生图 + 生视频提示词 ────────────────────────────

async def process_panel(
    img_sem: asyncio.Semaphore,
    executor: ThreadPoolExecutor,
    output_dir: Path,
    resource_catalog: str,
    path_map: dict,
    group_idx: int,
    panel_idx: int,
    panel: dict,
    text: str,
    prev_panel_context: dict | None,
) -> tuple[Path | None, str]:
    """返回 (图片路径或None, LLM生成的视频提示词)
    is_continuation=True 时跳过生图，返回 None，由 process_group 负责提取上一帧"""
    is_continuation = panel.get("is_continuation", False)
    prefix   = f"g{group_idx:02d}_p{panel_idx:02d}"
    img_path = output_dir / f"{prefix}.png"

    # ── 生图（continuation panel 跳过）──
    if is_continuation:
        print(f"  [{prefix}] is_continuation=True，跳过生图")
    elif img_path.exists():
        print(f"  [{prefix}] 图片已存在，跳过生图")
    else:
        print(f"  [{prefix}] 资源选择...")
        loop = asyncio.get_event_loop()
        ref_paths, image_prompt = await loop.run_in_executor(
            executor, select_resources, panel, resource_catalog, path_map, text, prev_panel_context
        )
        print(f"  [{prefix}] 参考图: {[p.name for p in ref_paths]}")
        print(f"  [{prefix}] 生成图片...")
        await generate_image(img_sem, executor, image_prompt, ref_paths, img_path)

    # 直接使用 JSON 中的 video_prompt，追加无音乐声明
    video_prompt = panel.get("video_prompt", "").rstrip()
    video_prompt += " No background music or ambient sound."
    print(f"  [{prefix}] 视频提示词: {video_prompt[:80]}...")

    return (None if is_continuation else img_path), video_prompt


# ── 处理单个 group ─────────────────────────────────────────────────────────────

async def process_group(
    img_sem: asyncio.Semaphore,
    vid_sem: asyncio.Semaphore,
    executor: ThreadPoolExecutor,
    output_dir: Path,
    resource_catalog: str,
    path_map: dict,
    group_idx: int,
    group: dict,
    initial_prev_panel_context: dict | None,
    log_entries: list,
    initial_prev_video_key: tuple[int, int] | None = None,
    video_events: dict | None = None,
) -> tuple[Path, dict | None]:
    """返回 (group视频路径, 本group最后一个panel的context)"""
    panels   = group.get("panels", [])
    vid_path = output_dir / f"g{group_idx:02d}.mp4"

    # 解析原文
    full_text = group.get("text", "")
    if "\n" in full_text:
        narrative, storyboard = full_text.split("\n", 1)
    else:
        narrative, storyboard = full_text, ""

    # ── 顺序处理所有 panel（生图 + 视频提示词）──
    print(f"\n[group {group_idx:02d}] {len(panels)} 个 panel，顺序处理...")
    img_paths: list[Path | None] = []
    video_prompts: list[str] = []
    prev_context = initial_prev_panel_context

    for pi, panel in enumerate(panels):
        img_path, video_prompt = await process_panel(
            img_sem, executor, output_dir,
            resource_catalog, path_map,
            group_idx, pi, panel,
            full_text, prev_context,
        )
        img_paths.append(img_path)
        video_prompts.append(video_prompt)
        prev_context = {
            "shot_type":    panel.get("shot_type", ""),
            "image_prompt": panel.get("image_prompt", ""),
            "video_prompt": video_prompt,
        }

    last_panel_context = prev_context

    if SKIP_VIDEO:
        return img_paths[0] or output_dir / f"g{group_idx:02d}_p00.png", last_panel_context

    # ── 每个 panel 并行生视频，continuation panel 通过 asyncio.Event 等待前驱 ──
    if vid_path.exists():
        print(f"\n[group {group_idx:02d}] 视频已存在，跳过")
        # 把本 group 所有 panel 的 event 置位，防止下一 group 的 continuation panel 永久挂起
        if video_events is not None:
            for pi in range(len(panels)):
                video_events.setdefault((group_idx, pi), asyncio.Event()).set()
        return vid_path, last_panel_context

    print(f"  [group {group_idx:02d}] 并行生成 {len(panels)} 个 panel 视频...")

    # 为本 group 所有 panel 预创建 event
    if video_events is not None:
        for pi in range(len(panels)):
            if (group_idx, pi) not in video_events:
                video_events[(group_idx, pi)] = asyncio.Event()

    async def panel_video_task(pi: int, img_path: Path | None, video_prompt: str) -> Path | None:
        panel         = panels[pi]
        current_key   = (group_idx, pi)
        prefix        = f"g{group_idx:02d}_p{pi:02d}"
        panel_vid_path = output_dir / f"{prefix}.mp4"

        try:
            if panel_vid_path.exists():
                print(f"    [视频] {panel_vid_path.name} 已存在，跳过")
                return panel_vid_path

            is_continuation = panel.get("is_continuation", False)
            actual_img      = img_path

            if is_continuation and video_events is not None:
                # 确定前驱 key：同 group 内取上一 panel，否则取跨 group 的传入 key
                prev_key = (group_idx, pi - 1) if pi > 0 else initial_prev_video_key
                if prev_key is not None and prev_key in video_events:
                    print(f"    [{prefix}] continuation: 等待 g{prev_key[0]:02d}_p{prev_key[1]:02d} 视频完成...")
                    await video_events[prev_key].wait()   # 挂起，不占 semaphore
                    pg, pp    = prev_key
                    prev_vid  = output_dir / f"g{pg:02d}_p{pp:02d}.mp4"
                    last_frame = output_dir / f"g{pg:02d}_p{pp:02d}_lastframe.png"
                    if prev_vid.exists() and (last_frame.exists() or extract_last_frame(prev_vid, last_frame)):
                        actual_img = last_frame
                        print(f"    [{prefix}] continuation: 使用 {last_frame.name} 作为参考图")
                    else:
                        print(f"    [{prefix}] continuation: 提帧失败，跳过")
                        return None
                else:
                    print(f"    [{prefix}] continuation: 无前驱 event，跳过")
                    return None

            if actual_img is None or not actual_img.exists():
                print(f"    [{prefix}] 无参考图，跳过")
                return None

            log_entries.append({
                "video":        panel_vid_path.name,
                "narrative":    narrative,
                "storyboard":   storyboard,
                "prompt":       video_prompt,
                "continuation": is_continuation,
            })

            duration = int(panel.get("duration", VIDEO_DURATION))
            await generate_video(vid_sem, executor, actual_img, video_prompt, panel_vid_path, duration)
            return panel_vid_path if panel_vid_path.exists() else None

        except Exception as e:
            print(f"    [视频] {prefix} 失败: {e}")
            return None
        finally:
            # 无论成功/失败/跳过，都置位 event，防止后续 continuation panel 永久挂起
            if video_events is not None:
                video_events.setdefault(current_key, asyncio.Event()).set()

    tasks   = [panel_video_task(pi, img_paths[pi], video_prompts[pi]) for pi in range(len(panels))]
    results = await asyncio.gather(*tasks)

    panel_vid_paths = [r for r in results if isinstance(r, Path) and r.exists()]
    if not panel_vid_paths:
        print(f"  [group {group_idx:02d}] 所有 panel 视频均失败，跳过")
        return output_dir / f"g{group_idx:02d}_FAILED.mp4", last_panel_context

    # ── 拼接 panel 视频 → group 视频 ──
    if len(panel_vid_paths) == 1:
        import shutil
        shutil.copy2(panel_vid_paths[0], vid_path)
    else:
        concat_videos(panel_vid_paths, vid_path)

    return vid_path, last_panel_context


# ── TTS 流水线 ────────────────────────────────────────────────────────────────

def _mimo_sync_client() -> OpenAI:
    return OpenAI(
        api_key=MIMO_API_KEY,
        base_url=MIMO_BASE_URL,
        http_client=httpx.Client(proxy=MIMO_PROXY, timeout=90),
    )

def _mimo_async_client() -> AsyncOpenAI:
    return AsyncOpenAI(
        api_key=MIMO_API_KEY,
        base_url=MIMO_BASE_URL,
        http_client=httpx.AsyncClient(proxy=MIMO_PROXY, timeout=90),
    )


_TTS_ANNOTATE_SYSTEM = """\
你是剧本分析助手。将收到一段小说原文，请拆成连续的语音片段并标注。

规则：
- 旁白（第一/三人称叙述、心理描写、过渡）→ speaker="旁白", gender="男"
- 识别说话人：根据"XXX说：""XXX道：""XXX问："等模式或上下文推断
- 说话人引导语（如"学姐说："）归入紧前的旁白片段，不单独成片段
- style：描述该片段朗读时的情绪、语气、语速、节奏，中文，15～40字

输出严格 JSON 数组，不要任何其他文字：
[
  {"speaker": "旁白", "gender": "男", "text": "...", "style": "..."},
  {"speaker": "学姐", "gender": "女", "text": "...", "style": "..."}
]\
"""

_TTS_ASSIGN_SYSTEM = """\
你是声音分配助手。

规则：
- 旁白固定用"白桦"
- 已有 voice_map 中的角色：直接沿用，不可更改
- 新角色：从同性别声音中选一个，优先选还没被其他角色使用的；若都用过则复用

输出完整的 voice_map JSON 对象（含原有映射 + 新增），不要任何其他文字：
{"旁白": "白桦", "学姐": "冰糖", ...}\
"""

_TTS_AGENT_SYSTEM = """\
你是 TTS 合成助手。你会收到一个文本片段、已分配的声音和风格描述。
请调用 generate_tts 工具合成语音。
style_prompt 参数：根据风格描述，写一句简洁的朗读指令（中文，20字以内）。\
"""

_TTS_TOOL_DEF = {
    "type": "function",
    "function": {
        "name": "generate_tts",
        "description": "调用 MiMo TTS API 合成语音",
        "parameters": {
            "type": "object",
            "properties": {
                "text":         {"type": "string", "description": "要合成的文本"},
                "voice":        {"type": "string", "description": "声音名称"},
                "style_prompt": {"type": "string", "description": "风格提示词（中文，20字以内）"},
            },
            "required": ["text", "voice", "style_prompt"],
        },
    },
}


def _tts_load_clean_text(jsonl_path: Path) -> str:
    lines = []
    with open(jsonl_path, encoding="utf-8") as f:
        for raw in f:
            raw = raw.strip()
            if not raw:
                continue
            group = json.loads(raw)
            text = re.sub(r"【[^】]*】", "", group.get("text", "")).strip()
            if text:
                lines.append(text)
    return "\n".join(lines)


def _tts_phase1_annotate(full_text: str) -> list[dict]:
    print("[TTS Phase 1] LLM 标注文本片段...")
    client = _mimo_sync_client()
    resp = client.chat.completions.create(
        model=MIMO_CHAT_MODEL,
        messages=[
            {"role": "system", "content": _TTS_ANNOTATE_SYSTEM},
            {"role": "user",   "content": full_text},
        ],
        temperature=0.3,
    )
    raw = resp.choices[0].message.content.strip()
    m = re.search(r"\[.*\]", raw, re.DOTALL)
    if m:
        raw = m.group(0)
    segments = json.loads(raw)
    print(f"[TTS Phase 1] 共 {len(segments)} 个片段")
    return segments


def _tts_phase2_assign_voices(segments: list[dict], voice_map: dict) -> dict:
    print("[TTS Phase 2] LLM 分配声音...")
    client = _mimo_sync_client()
    chars = {}
    for seg in segments:
        sp = seg["speaker"]
        if sp not in chars:
            chars[sp] = seg["gender"]
    user_content = (
        f"当前 voice_map：\n{json.dumps(voice_map, ensure_ascii=False, indent=2)}\n\n"
        f"可用声音（名称→性别）：\n{json.dumps(MIMO_VOICES, ensure_ascii=False)}\n\n"
        f"本次出现的角色（名称→性别）：\n{json.dumps(chars, ensure_ascii=False)}"
    )
    resp = client.chat.completions.create(
        model=MIMO_CHAT_MODEL,
        messages=[
            {"role": "system", "content": _TTS_ASSIGN_SYSTEM},
            {"role": "user",   "content": user_content},
        ],
        temperature=0,
    )
    raw = resp.choices[0].message.content.strip()
    m = re.search(r"\{.*\}", raw, re.DOTALL)
    if m:
        raw = m.group(0)
    new_map = json.loads(raw)
    print(f"[TTS Phase 2] voice_map: {new_map}")
    return new_map


def _tts_exec_api(text: str, voice: str, style_prompt: str, output_path: Path) -> Path:
    payload = {
        "model": MIMO_TTS_MODEL,
        "messages": [
            {"role": "user",      "content": style_prompt},
            {"role": "assistant", "content": text},
        ],
        "audio":  {"format": "mp3", "voice": voice},
        "stream": False,
    }
    resp = httpx.post(
        f"{MIMO_BASE_URL}/chat/completions",
        headers={"api-key": MIMO_API_KEY, "Content-Type": "application/json"},
        json=payload,
        proxy=MIMO_PROXY,
        timeout=90,
    )
    data = resp.json()
    if "error" in data:
        raise RuntimeError(f"TTS API 错误: {data['error']}")
    audio_b64 = data["choices"][0]["message"]["audio"]["data"]
    output_path.write_bytes(base64.b64decode(audio_b64))
    return output_path


async def _tts_generate_one(
    sem: asyncio.Semaphore,
    idx: int,
    seg: dict,
    voice: str,
    output_path: Path,
) -> Path:
    async with sem:
        print(f"  [TTS seg {idx:02d}] [{seg['speaker']}→{voice}] {seg['text'][:35]}...")
        client = _mimo_async_client()
        resp = await client.chat.completions.create(
            model=MIMO_CHAT_MODEL,
            messages=[
                {"role": "system", "content": _TTS_AGENT_SYSTEM},
                {"role": "user",   "content": (
                    f"文本：{seg['text']}\n"
                    f"声音：{voice}\n"
                    f"风格描述：{seg['style']}"
                )},
            ],
            tools=[_TTS_TOOL_DEF],
            tool_choice="required",
        )
        msg = resp.choices[0].message
        if not msg.tool_calls:
            raise RuntimeError(f"TTS seg {idx}: LLM 未调用工具")
        args = json.loads(msg.tool_calls[0].function.arguments)
        args["voice"] = voice  # 强制使用预分配声音

        await asyncio.get_event_loop().run_in_executor(
            None, _tts_exec_api, args["text"], args["voice"], args["style_prompt"], output_path
        )
        print(f"  [TTS seg {idx:02d}] 完成 → {output_path.name} ({output_path.stat().st_size // 1024}KB)")
        return output_path


async def _tts_phase3_async(
    segments: list[dict],
    voice_map: dict,
    tmp_dir: Path,
) -> list[Path]:
    print(f"[TTS Phase 3] 并发生成 {len(segments)} 个片段...")
    tmp_dir.mkdir(parents=True, exist_ok=True)
    sem = asyncio.Semaphore(MIMO_TTS_CONCURRENCY)
    tasks = []
    for i, seg in enumerate(segments):
        voice = voice_map.get(seg["speaker"], MIMO_NARRATOR_VOICE)
        out   = tmp_dir / f"seg_{i:03d}.mp3"
        tasks.append(_tts_generate_one(sem, i, seg, voice, out))
    return list(await asyncio.gather(*tasks))


def _tts_concat(audio_files: list[Path], output_path: Path) -> None:
    print(f"[TTS Phase 4] 拼接 {len(audio_files)} 个片段...")
    abs_files  = [p.resolve() for p in sorted(audio_files)]
    abs_output = output_path.resolve()
    list_file  = abs_output.parent / "_tts_concat_list.txt"
    with open(list_file, "w", encoding="utf-8") as f:
        for p in abs_files:
            f.write(f"file '{str(p).replace(chr(92), '/')}'\n")
    result = subprocess.run(
        ["ffmpeg", "-y", "-f", "concat", "-safe", "0",
         "-i", str(list_file.resolve()), "-c:a", "libmp3lame", "-q:a", "2", str(abs_output)],
        capture_output=True,
    )
    list_file.unlink(missing_ok=True)
    if result.returncode != 0:
        raise RuntimeError(f"TTS concat 失败: {result.stderr.decode('utf-8', errors='replace')[-300:]}")
    print(f"[TTS Phase 4] 完成 → {abs_output.name}")


def run_tts_pipeline_sync(
    jsonl_path: Path,
    output_dir: Path,
    voice_map_path: Path,
) -> Path:
    """同步入口，内部跑独立 asyncio 事件循环，供 ThreadPoolExecutor 调用"""
    scene_name = jsonl_path.stem.replace("storyboard_", "")
    tts_mp3    = output_dir / f"tts_agent_{scene_name}.mp3"
    tmp_dir    = output_dir / "tts_segments"

    # 加载已有 voice_map
    voice_map: dict = {}
    if voice_map_path.exists():
        voice_map = json.loads(voice_map_path.read_text(encoding="utf-8"))
        print(f"[TTS] 载入 voice_map: {voice_map}")

    full_text = _tts_load_clean_text(jsonl_path)
    print(f"[TTS] 提取文本 {len(full_text)} 字")

    segments  = _tts_phase1_annotate(full_text)
    voice_map = _tts_phase2_assign_voices(segments, voice_map)
    voice_map_path.write_text(json.dumps(voice_map, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[TTS] voice_map 已保存: {voice_map_path}")

    audio_files = asyncio.run(_tts_phase3_async(segments, voice_map, tmp_dir))
    _tts_concat(audio_files, tts_mp3)
    return tts_mp3


# ── 音视频合并（以音频时长为准，调整视频速度） ───────────────────────────────

def _get_duration(path: Path) -> float:
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", str(path.resolve())],
        capture_output=True, text=True,
    )
    return float(r.stdout.strip())


def merge_with_audio(video_path: Path, audio_path: Path, output_path: Path) -> Path:
    """以音频时长为准，缩放视频播放速度后合并"""
    video_dur = _get_duration(video_path)
    audio_dur = _get_duration(audio_path)
    ratio     = audio_dur / video_dur
    print(f"[合并] 视频 {video_dur:.1f}s  音频 {audio_dur:.1f}s  速度 ×{ratio:.3f}")
    result = subprocess.run(
        ["ffmpeg", "-y",
         "-i", str(video_path.resolve()),
         "-i", str(audio_path.resolve()),
         "-filter:v", f"setpts={ratio:.6f}*PTS",
         "-map", "0:v", "-map", "1:a",
         "-c:v", "libx264", "-preset", "fast", "-crf", "18",
         "-c:a", "aac", "-b:a", "192k",
         "-shortest",
         str(output_path.resolve())],
        capture_output=True,
    )
    if result.returncode != 0:
        err = result.stderr.decode("utf-8", errors="replace")[-400:]
        raise RuntimeError(f"ffmpeg merge 失败: {err}")
    print(f"[合并] 完成 → {output_path.name}")
    return output_path


# ── 主流程 ────────────────────────────────────────────────────────────────────

async def main(jsonl_path: Path, only_group: int | None = None) -> None:
    scene_name    = jsonl_path.stem.replace("storyboard_", "")
    workspace_dir = jsonl_path.parent.parent
    output_dir    = jsonl_path.parent / f"render_{scene_name}"
    output_dir.mkdir(parents=True, exist_ok=True)
    final_output  = output_dir / "final.mp4"

    voice_map_path = workspace_dir / "voice_map.json"
    final_tts      = output_dir / "final_tts.mp4"

    resource_catalog, path_map = build_resource_catalog(workspace_dir)
    print(f"资源目录已构建，共 {len(path_map)} 个资源")

    groups = []
    with open(jsonl_path, encoding="utf-8") as f:
        raw = f.read().strip()
    # 替换中文弯引号，避免 JSON 解析失败
    raw = raw.replace("\u201c", "\uff02").replace("\u201d", "\uff02")

    decoder = json.JSONDecoder()
    pos = 0
    while pos < len(raw):
        while pos < len(raw) and raw[pos] in " \t\n\r":
            pos += 1
        if pos >= len(raw):
            break
        try:
            obj, end = decoder.raw_decode(raw, pos)
            groups.append(obj)
            pos = end
        except json.JSONDecodeError:
            block_end = pos + 1
            depth = 1
            while block_end < len(raw) and depth > 0:
                if raw[block_end] == "{":
                    depth += 1
                elif raw[block_end] == "}":
                    depth -= 1
                block_end += 1
            block = raw[pos:block_end]
            panels_idx = block.find('"panels"')
            if panels_idx != -1:
                try:
                    tail = block[panels_idx:].rstrip().rstrip("}")
                    panels_obj = json.loads("{" + tail + "}")
                    groups.append({"panels": panels_obj["panels"]})
                    print(f"  [警告] 第 {len(groups)} 个 group JSON 有转义问题，已提取 panels 部分")
                except Exception as e:
                    print(f"  [错误] 无法解析第 {len(groups)+1} 个 group: {e}")
            pos = block_end

    total_panels = sum(len(g.get("panels", [])) for g in groups)
    print(f"场景: {scene_name}")
    print(f"共 {len(groups)} 个 group，{total_panels} 个 panel")
    print(f"输出目录: {output_dir}")

    # 确定要处理的 group 范围
    if only_group is not None:
        if only_group >= len(groups):
            print(f"错误：--only-group {only_group} 超出范围（共 {len(groups)} 个 group，索引 0~{len(groups)-1}）")
            return
        groups_to_run = [(only_group, groups[only_group])]
        print(f"仅处理 group {only_group}")
    else:
        groups_to_run = list(enumerate(groups))

    img_sem     = asyncio.Semaphore(IMAGE_CONCURRENCY)
    vid_sem     = asyncio.Semaphore(VIDEO_CONCURRENCY)
    executor    = ThreadPoolExecutor(max_workers=IMAGE_CONCURRENCY + VIDEO_CONCURRENCY + 2)
    log_entries: list = []

    # ── 全量渲染时，TTS 与视频并行启动 ──
    tts_future = None
    if only_group is None and ENABLE_TTS and not SKIP_VIDEO:
        print("[TTS] 与视频并行启动 TTS 流水线...")
        loop = asyncio.get_event_loop()
        tts_future = loop.run_in_executor(
            executor, run_tts_pipeline_sync, jsonl_path, output_dir, voice_map_path
        )

    # groups 顺序处理（panel context 跨 group 传递，video_events 全局共享）
    group_videos: list[Path] = []
    prev_panel_context: dict | None = None
    video_events: dict[tuple[int, int], asyncio.Event] = {}

    for i, g in groups_to_run:
        # 跨 group 的 continuation 前驱 key：上一 group 最后一个 panel
        if i > 0:
            prev_panels_count = len(groups[i - 1].get("panels", []))
            initial_prev_video_key = (i - 1, prev_panels_count - 1) if prev_panels_count > 0 else None
        else:
            initial_prev_video_key = None

        vid_path, prev_panel_context = await process_group(
            img_sem, vid_sem, executor, output_dir,
            resource_catalog, path_map,
            i, g, prev_panel_context, log_entries,
            initial_prev_video_key=initial_prev_video_key,
            video_events=video_events,
        )
        group_videos.append(vid_path)

    if SKIP_VIDEO:
        print(f"\n[调试] SKIP_VIDEO=True，共生成 {len(group_videos)} 张图片")
        return

    all_videos = [p for p in group_videos if p.suffix == ".mp4" and p.exists() and "_FAILED" not in p.name]
    print(f"\n所有 {len(all_videos)} 个 group 视频生成完毕")
    concat_videos(all_videos, final_output)

    # 写日志
    log_path = output_dir / "generation_log.json"
    log_entries.sort(key=lambda e: e["video"])
    log_path.write_text(
        json.dumps(log_entries, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"日志已写出: {log_path}")
    print(f"\n最终视频: {final_output}")

    # ── 等待 TTS 完成，合并音视频 ──
    if tts_future is not None:
        print("\n[TTS] 等待 TTS 流水线完成...")
        try:
            tts_mp3 = await tts_future
            if tts_mp3 and tts_mp3.exists() and final_output.exists():
                merge_with_audio(final_output, tts_mp3, final_tts)
                print(f"最终视频（含TTS）: {final_tts}")
            else:
                print("[TTS] TTS 或视频文件缺失，跳过合并")
        except Exception as e:
            print(f"[TTS] 流水线失败，跳过合并: {e}")


if __name__ == "__main__":
    args = sys.argv[1:]

    # 解析 --only-group N
    only_group: int | None = None
    if "--only-group" in args:
        idx = args.index("--only-group")
        only_group = int(args[idx + 1])
        args = args[:idx] + args[idx + 2:]

    if not args:
        default = Path(r"C:\Users\ZhangChi\Desktop\改写漫剧\story-claw\workspace\规则怪谈 - 副本\ep01\storyboard_新生报到处.jsonl")
        print(f"未指定路径，使用默认: {default}")
        target = default
    else:
        target = Path(args[0])

    if not target.exists():
        print(f"文件不存在: {target}")
        sys.exit(1)

    asyncio.run(main(target, only_group=only_group))
