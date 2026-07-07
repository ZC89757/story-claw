"""
title_watermark_gui.py — 视频标题水印工具

给定视频文件夹 + 标题文字 + 原文 txt，生成标题图（参考原文风格）、
抠除背景后贴到该文件夹下所有视频的左上角（直接覆盖原视频）。

用法：
  python scripts/title_watermark_gui.py                                    # 打开 GUI
  python scripts/title_watermark_gui.py --folder <dir> --title <标题> --txt <原文路径>  [--apply] [--videos-folder <dir>] [--no-intro] [--id-text <文字>] [--speed <倍速>]
"""
import argparse
import concurrent.futures
import io
import json
import os
import queue
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

# 禁用系统代理（避免 requests 经代理时 TLS 握手失败，与 utils/gpt-image-gen.py 一致）
os.environ["NO_PROXY"] = "*"
os.environ["no_proxy"] = "*"

import numpy as np
import requests
from google import genai
from google.genai import types
from PIL import Image, ImageFilter, ImageTk

SCRIPT_DIR = Path(__file__).resolve().parent
CONFIG_DIR = Path.home() / ".story-claw"
TEXT_LLM_CONFIG = CONFIG_DIR / "config.json"
IMAGE_GEN_CONFIG = CONFIG_DIR / "image_gen_config.json"

VIDEO_EXTS = {".mp4", ".mov", ".mkv", ".avi", ".flv", ".webm", ".m4v", ".ts"}

# 都走同一个 ZenMux 中转站，直接换 model id 即可，不用调用单独的 utils/gpt-image-gen.py
IMAGE_GEN_MODEL = "openai/gpt-image-2:openai"
IMAGE_GEN_TIMEOUT_MS = 300_000
MAX_IMAGE_GEN_RETRIES = 3
BG_QUANTIZE_STEP = 8
CUTOUT_T1 = 30
CUTOUT_T2 = 70
CROP_ALPHA_THRESHOLD = 150
CROP_PADDING = 8
OVERLAY_WIDTH_RATIO = 0.32
MARGIN_RATIO = 0.03
PREVIEW_MAX_SIZE = 260
OVERLAY_CONCURRENCY = min(4, os.cpu_count() or 4)
DESIGN_MODEL = "anthropic/claude-sonnet-5"
DESIGN_LLM_TIMEOUT = 240
DESIGN_LLM_RETRIES = 3
LLM_RETRY_SLEEP = 5  # 网络抖动（Server disconnected / Read timed out）重试前的等待

# 片头生成（独立于标题图，并行跑）
INTRO_CREATIVE_MODEL = "anthropic/claude-sonnet-5"
INTRO_LLM_TIMEOUT = 240
INTRO_LLM_RETRIES = 3
INTRO_VIDEO_MODELS = ["alibaba/happyhorse-1.0", "google/veo-3.1-fast-generate-001"]  # 按顺序尝试，前面失败才降级到后面
INTRO_VIDEO_DURATION = 8  # 秒，四宫格每格 2 秒
INTRO_VIDEO_POLL_INTERVAL = 15
INTRO_VIDEO_MAX_WAIT = 300
INTRO_VIDEO_MAX_RETRIES = 2  # 每个模型各自的重试次数

# ID 水印（防盗用，定时跳位到画面四角+居中，循环播放）
ID_WATERMARK_SLOT_SECONDS = 10
ID_FONT_CANDIDATES = [
    "C:/Windows/Fonts/msyh.ttc",
    "C:/Windows/Fonts/simhei.ttf",
    "C:/Windows/Fonts/simsun.ttc",
]

# 右下角固定小字（不透明，每个视频都会加）
CREDIT_TEXT = "所有内容由story-claw一键生成。"
CREDIT_FONT_RATIO = 0.03
CREDIT_MARGIN_RATIO = 0.02

DEFAULT_SPEED = 1.1
SPEED_MIN = 0.5
SPEED_MAX = 3.0
SPEED_STEP = 0.1

DESIGN_PROMPT_TEMPLATE = (
    "以下是一篇小说原文全文。请根据其题材和氛围，为短剧标题卡设计一套具体的文字视觉方案，"
    "用一段中文描述（不超过100字）说明：字体风格（如手写体/黑体/衬线体/书法体等）、"
    "文字颜色（必须与背景色不同，不能选跟背景相近或相同的颜色）、"
    "文字边缘或描边效果（如是否有描边、光晕、破损、金属质感、阴影等）、"
    "整体氛围基调。只输出这段描述本身，不要解释、不要分点、不要输出与设计无关的内容：\n\n{content}"
)

IMAGE_PROMPT_TEMPLATE = (
    "电影感短剧标题卡设计。{design_clause}"
    "纯色背景（整张画布背景为单一纯色，无渐变、无纹理、无阴影、无装饰图案），"
    "画面正中是标题文字：\"{title}\"，文字颜色必须与背景颜色不同，"
    "不允许文字颜色与背景颜色相近或相同，"
    "除标题文字外画面中不得出现任何其他文字、图案、logo、水印、边框或装饰元素，横版构图"
)

INTRO_CREATIVE_SYSTEM = (
    "你是短剧片头策划。以下是一篇小说原文全文。你要为这一集设计一个几秒钟的悬念片头，"
    "目的是从全文中挑出一个场景里的一个瞬间（不是整集），抓这个瞬间里最有钩子感的画面"
    "（冲突爆发前一刻、悬而未决的表情、危险逼近等），"
    "绝不能剧透结局或关键真相，只制造\"不看完受不了\"的悬念感，用于提升完播率。\n\n"
    "严格输出如下 JSON（不要输出任何其他文字、不要用代码块包裹）：\n"
    "{\"ref_image_prompt\": \"...\", \"video_prompt\": \"...\", \"reference_images\": [\"文件名1.png\", ...]}\n\n"
    "ref_image_prompt 要求（中文，用于生成一张静态参考图）：\n"
    "- 必须是「2x2 四宫格漫画分镜图」，画面分四格：左上、右上、左下、右下，格间有细黑色分隔线\n"
    "- 四格必须都在同一个场景、同一个瞬间内，只是从不同角度/景别/局部拆解这同一刻发生的事"
    "（比如同一个动作的不同景别：环境全景/人物中景/表情特写/关键道具特写），禁止时间跨度大、"
    "禁止出现不同场景，不得是「整集剧情的四个不同片段」这种跨度\n"
    "- 不得出现结局或关键真相\n"
    "- 每一格都要具体描述：场景、人物、动作/表情、镜头景别，电影感光影，写实插画风格，横版构图\n"
    "- 格式示例（照此结构填内容）：\"四宫格漫画分镜图，2x2 网格布局，每格之间有细黑色分隔线。"
    "第一格：[画面描述]。第二格：[画面描述]。第三格：[画面描述]。第四格：[画面描述]。电影感光影，写实插画风格，横版构图\"\n\n"
    "video_prompt 要求（必须用英文，用于驱动图生视频模型把这张四宫格图变成一段 8 秒短片）：\n"
    "- 必须是「一镜到底」（one continuous single shot / oner）：镜头连续运动依次带过四格内容，"
    "格与格之间靠镜头运动本身自然过渡（缓慢的 pan / push / tilt），不能是硬切、擦除或跳切\n"
    "- 必须按 0-2s / 2-4s / 4-6s / 6-8s 四个时间段分别描述该时段镜头在看哪一格、画面里发生什么动作，"
    "以及到下一时间段镜头如何连续运动过去\n"
    "- 要求全程人物/场景一致、氛围统一、悬念感逐步升级\n"
    "- 格式示例（照此结构填内容，保留时间戳与运镜衔接的写法）：\n"
    "\"This is a 2x2 grid image with four panels: top-left, top-right, bottom-left, bottom-right. "
    "Turn it into one continuous N-second video, following this exact timeline: "
    "0-2s: [top-left 画面与动作]. Camera [运镜方式]. "
    "[Transition Ns: 连续镜头运动过渡到下一格，不是硬切]. "
    "2-4s: [top-right 画面与动作]. ... "
    "Maintain consistent character identity and atmosphere throughout. "
    "No dialogue or voiceover, no text overlays.\"\n\n"
    "reference_images 要求（数组，可以为空）：\n"
    "- 系统消息末尾会给你一份「可用参考图」清单（角色/场景现有图片的文件名），四宫格里出现的角色/场景形象"
    "必须与这些参考图保持一致，禁止凭空想象外观\n"
    "- 只挑你四格内容里真正用得上的：这一格画的是哪个已建档角色/哪个已建档场景，才选对应的那一张，"
    "按你打算在 ref_image_prompt 中引用的顺序排列——第 1 个就是 image 1，第 2 个是 image 2，以此类推\n"
    "- 禁止不管三七二十一把清单里的图全选进去；跟本次四格内容无关的资源、清单里没有合适的"
    "（比如某格是纯环境空镜、某格角色未建档、某格场景是一次性无需复用的地方）一律不选\n"
    "- 同一角色/场景有多张图（如 `_原型.png` 与 `_某阶段.png`）时只选其中最贴合当前情境的一张，不要重复都选\n"
    "- 只能填清单中已存在的文件名，逐字照抄，不得自创或改写\n"
    "- 对应地，在 ref_image_prompt 描述某一格里的角色/场景时，不要重新描述外观细节，改用"
    "「the character in image N」「the location in image N」这种指代方式，直接引用参考图\n\n"
    "输出 JSON 增加 reference_images 字段：\n"
    "{\"ref_image_prompt\": \"...\", \"video_prompt\": \"...\", \"reference_images\": [\"文件名1.png\", \"文件名2.png\"]}\n\n"
    "只输出 JSON 本身。"
)


def read_txt_content(path: str) -> str:
    raw = Path(path).read_bytes()
    text = None
    for enc in ("utf-8", "gbk"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    if text is None:
        text = raw.decode("utf-8", errors="ignore")
    return text.strip()


def read_text_llm_config() -> dict:
    cfg = json.loads(TEXT_LLM_CONFIG.read_text(encoding="utf-8"))
    if not cfg.get("model") or not cfg.get("api_key"):
        raise ValueError("config.json 缺少 model 或 api_key")
    return cfg


def infer_title_design(txt_path: str, log) -> str:
    content = read_txt_content(txt_path)
    if not content:
        log("原文内容为空，跳过风格推测")
        return ""

    for attempt in range(1, DESIGN_LLM_RETRIES + 1):
        try:
            cfg = read_text_llm_config()
            base_url = (cfg.get("base_url") or "https://api.openai.com/v1").rstrip("/")
            resp = requests.post(
                f"{base_url}/chat/completions",
                headers={
                    "Authorization": f"Bearer {cfg['api_key']}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": DESIGN_MODEL,
                    "messages": [{"role": "user", "content": DESIGN_PROMPT_TEMPLATE.format(content=content)}],
                },
                timeout=DESIGN_LLM_TIMEOUT,
                proxies={"http": None, "https": None},
            )
            resp.raise_for_status()
            return resp.json()["choices"][0]["message"]["content"].strip()
        except Exception as e:
            log(f"[{attempt}/{DESIGN_LLM_RETRIES}] 风格推测失败：{e}")
            if attempt < DESIGN_LLM_RETRIES:
                time.sleep(LLM_RETRY_SLEEP)

    log("风格推测重试后仍失败，将不使用风格提示继续")
    return ""


def build_image_prompt(title: str, design: str) -> str:
    design_clause = f"文字设计要求：{design} " if design else ""
    return IMAGE_PROMPT_TEMPLATE.format(title=title, design_clause=design_clause)


def scan_reference_resources(episode_folder: str) -> dict:
    """扫描 episode 目录上一级的 characters/ 和 scenes/，返回 {文件名: 完整路径}（跨集共享资源）。"""
    parent = os.path.dirname(os.path.normpath(episode_folder))
    resources = {}
    for sub in ("characters", "scenes"):
        d = os.path.join(parent, sub)
        if os.path.isdir(d):
            for f in os.listdir(d):
                if f.lower().endswith(".png"):
                    resources[f] = os.path.join(d, f)
    return resources


def infer_intro_creative(txt_path: str, resource_names: list, log) -> dict:
    """一次 LLM 调用拿到片头的参考图 prompt + 视频 prompt + 要用的参考图文件名，失败返回 None。"""
    content = read_txt_content(txt_path)
    if not content:
        log("[片头] 原文内容为空，跳过片头生成")
        return None

    resource_text = (
        "\n".join(f"- {name}" for name in resource_names) if resource_names else "（无可用参考图）"
    )
    user_content = f"{content}\n\n== 可用参考图（角色/场景现有图片文件名）==\n{resource_text}"

    for attempt in range(1, INTRO_LLM_RETRIES + 1):
        try:
            cfg = read_text_llm_config()
            base_url = (cfg.get("base_url") or "https://api.openai.com/v1").rstrip("/")
            resp = requests.post(
                f"{base_url}/chat/completions",
                headers={
                    "Authorization": f"Bearer {cfg['api_key']}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": INTRO_CREATIVE_MODEL,
                    "messages": [
                        {"role": "system", "content": INTRO_CREATIVE_SYSTEM},
                        {"role": "user", "content": user_content},
                    ],
                },
                timeout=INTRO_LLM_TIMEOUT,
                proxies={"http": None, "https": None},
            )
            resp.raise_for_status()
            raw = resp.json()["choices"][0]["message"]["content"].strip()
            m = re.search(r"\{[\s\S]*\}", raw)
            if not m:
                raise ValueError(f"未找到 JSON: {raw[:200]}")
            data = json.loads(m.group(0))
            if not data.get("ref_image_prompt") or not data.get("video_prompt"):
                raise ValueError(f"JSON 缺少必要字段: {data}")
            # 只保留清单里真实存在的文件名，防止 LLM 编造
            picked = [
                name for name in data.get("reference_images", []) or []
                if isinstance(name, str) and name in (resource_names or [])
            ]
            data["reference_images"] = picked
            return data
        except Exception as e:
            log(f"[片头] [{attempt}/{INTRO_LLM_RETRIES}] 创意生成失败：{e}")
            if attempt < INTRO_LLM_RETRIES:
                time.sleep(LLM_RETRY_SLEEP)

    log("[片头] 创意生成重试后仍失败，跳过片头")
    return None


REFERENCE_IMAGE_COMPRESS_MAX_PX = 512


def compress_reference_image(img_path: str) -> bytes:
    """把参考图压缩到短边不超过 REFERENCE_IMAGE_COMPRESS_MAX_PX，返回 PNG bytes。"""
    with Image.open(img_path) as img:
        img = img.convert("RGBA")
        w, h = img.size
        short = min(w, h)
        if short > REFERENCE_IMAGE_COMPRESS_MAX_PX:
            scale = REFERENCE_IMAGE_COMPRESS_MAX_PX / short
            img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return buf.getvalue()


def generate_raw_image(prompt: str, output_path: str, log, image_paths: list = None) -> bool:
    """image_paths 给了参考图就走图生图（edit_image，按顺序 image 1/2/3...），否则纯文生图。"""
    cfg = json.loads(IMAGE_GEN_CONFIG.read_text(encoding="utf-8"))

    for attempt in range(1, MAX_IMAGE_GEN_RETRIES + 1):
        try:
            client = genai.Client(
                api_key=cfg["api_key"],
                vertexai=True,
                http_options=types.HttpOptions(
                    api_version="v1",
                    base_url="https://zenmux.ai/api/vertex-ai",
                    timeout=IMAGE_GEN_TIMEOUT_MS,
                ),
            )
            if image_paths:
                refs = [
                    types.RawReferenceImage(
                        reference_id=i,
                        reference_image=types.Image(
                            image_bytes=compress_reference_image(p), mime_type="image/png"
                        ),
                    )
                    for i, p in enumerate(image_paths, start=1)
                ]
                resp = client.models.edit_image(
                    model=IMAGE_GEN_MODEL,
                    prompt=prompt,
                    reference_images=refs,
                    config=types.EditImageConfig(
                        output_mime_type="image/png",
                        http_options=types.HttpOptions(
                            extra_body={"imageSize": "1536x1024"},
                            timeout=IMAGE_GEN_TIMEOUT_MS,
                        ),
                    ),
                )
            else:
                resp = client.models.generate_images(
                    model=IMAGE_GEN_MODEL,
                    prompt=prompt,
                    config=types.GenerateImagesConfig(
                        number_of_images=1,
                        output_mime_type="image/png",
                        http_options=types.HttpOptions(
                            extra_body={"imageSize": "1536x1024"},
                            timeout=IMAGE_GEN_TIMEOUT_MS,
                        ),
                    ),
                )
            generated = getattr(resp, "generated_images", None)
            if not generated:
                raise RuntimeError("响应中没有 generated_images")

            img_obj = generated[0].image
            img_bytes = None
            if hasattr(img_obj, "image_bytes") and img_obj.image_bytes:
                img_bytes = img_obj.image_bytes
            elif hasattr(img_obj, "save"):
                buf = io.BytesIO()
                img_obj.save(buf)
                img_bytes = buf.getvalue()
            if not img_bytes:
                raise RuntimeError("响应中图片数据为空")

            Path(output_path).parent.mkdir(parents=True, exist_ok=True)
            Path(output_path).write_bytes(img_bytes)
            log(f"[{IMAGE_GEN_MODEL}] 生成成功")
            return True
        except Exception as e:
            log(f"[{attempt}/{MAX_IMAGE_GEN_RETRIES}] 生图失败: {e}")
            if attempt < MAX_IMAGE_GEN_RETRIES:
                time.sleep(LLM_RETRY_SLEEP)
    return False


def _try_generate_intro_video(model: str, image_path: str, video_prompt: str, output_path: str, log) -> bool:
    """单个模型的图生视频尝试，内部按 INTRO_VIDEO_MAX_RETRIES 重试。"""
    cfg = json.loads(IMAGE_GEN_CONFIG.read_text(encoding="utf-8"))

    for attempt in range(1, INTRO_VIDEO_MAX_RETRIES + 1):
        try:
            client = genai.Client(
                api_key=cfg["api_key"],
                vertexai=True,
                http_options=types.HttpOptions(
                    api_version="v1",
                    base_url="https://zenmux.ai/api/vertex-ai",
                ),
            )
            img_bytes = Path(image_path).read_bytes()
            op = client.models.generate_videos(
                model=model,
                prompt=video_prompt,
                image=types.Image(image_bytes=img_bytes, mime_type="image/png"),
                config=types.GenerateVideosConfig(
                    duration_seconds=INTRO_VIDEO_DURATION,
                    generate_audio=True,
                ),
            )
            log(f"[片头] [{model}] 视频任务已提交，轮询中...")

            # 轮询单次失败大多是网络抖动（Server disconnected 等），不代表任务本身失败，
            # 不应白白扔掉已提交的任务重新生成——记日志后继续轮询同一个 op，直到总等待超时。
            waited = 0
            while not op.done:
                time.sleep(INTRO_VIDEO_POLL_INTERVAL)
                waited += INTRO_VIDEO_POLL_INTERVAL
                try:
                    op = client.operations.get(operation=op)
                except Exception as poll_err:
                    log(f"[片头] 轮询失败（继续重试）: {poll_err}")
                if waited > INTRO_VIDEO_MAX_WAIT:
                    raise TimeoutError(f"等待超过 {INTRO_VIDEO_MAX_WAIT}s 仍未完成")

            if op.error:
                raise RuntimeError(f"生成失败: {op.error}")
            generated = op.response.generated_videos if op.response else None
            if not generated:
                reasons = op.response.rai_media_filtered_reasons if op.response else None
                raise RuntimeError(f"响应中没有视频（可能被内容安全过滤）: {reasons}")

            video = generated[0].video
            data = video.video_bytes
            if not data and video.uri:
                dl = requests.get(video.uri, timeout=60, proxies={"http": None, "https": None})
                dl.raise_for_status()
                data = dl.content
            if not data:
                raise RuntimeError("响应中视频数据为空（既无 video_bytes 也无 uri）")

            Path(output_path).parent.mkdir(parents=True, exist_ok=True)
            Path(output_path).write_bytes(data)
            log(f"[片头] [{model}] 生成成功: {os.path.basename(output_path)}")
            return True
        except Exception as e:
            log(f"[片头] [{model}] [{attempt}/{INTRO_VIDEO_MAX_RETRIES}] 视频生成失败: {e}")
            if attempt < INTRO_VIDEO_MAX_RETRIES:
                time.sleep(LLM_RETRY_SLEEP)
    return False


def generate_intro_video(image_path: str, video_prompt: str, output_path: str, log) -> bool:
    """依次尝试 INTRO_VIDEO_MODELS 里的模型，前一个所有重试都失败才降级到下一个。"""
    for i, model in enumerate(INTRO_VIDEO_MODELS):
        if i > 0:
            log(f"[片头] 降级到下一个视频模型：{model}")
        if _try_generate_intro_video(model, image_path, video_prompt, output_path, log):
            return True
    return False


def extract_poster_frame(video_path: str, output_png: str) -> bool:
    """抽一帧当片头预览缩略图（Tkinter 放不了视频）。"""
    try:
        result = subprocess.run(
            ["ffmpeg", "-y", "-ss", "1", "-i", video_path, "-frames:v", "1", output_png],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30,
        )
        return result.returncode == 0 and os.path.isfile(output_png)
    except Exception:
        return False


def get_video_fps(video_path: str) -> float:
    result = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=r_frame_rate", "-of", "csv=p=0",
            video_path,
        ],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30,
    )
    if result.returncode != 0:
        raise RuntimeError(f"ffprobe 失败: {summarize_ffmpeg_error(result.stderr)}")
    num, den = result.stdout.strip().split("/")
    return float(num) / float(den)


def prepend_intro(video_path: Path, intro_path: str) -> None:
    """把片头拼到目标视频最前面（就地覆盖）。片头按目标视频的实际宽高/帧率缩放对齐。"""
    w, h = get_video_dimensions(str(video_path))
    fps = get_video_fps(str(video_path))
    tmp_out = str(video_path) + ".tmp_intro.mp4"
    filter_complex = (
        f"[0:v]scale={w}:{h}:force_original_aspect_ratio=decrease,"
        f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,setsar=1[v0];"
        f"[0:a]aformat=sample_rates=44100:channel_layouts=stereo[a0];"
        f"[1:a]aformat=sample_rates=44100:channel_layouts=stereo[a1];"
        f"[v0][a0][1:v][a1]concat=n=2:v=1:a=1[outv][outa]"
    )
    result = subprocess.run(
        [
            "ffmpeg", "-y",
            "-i", intro_path, "-i", str(video_path),
            "-filter_complex", filter_complex,
            "-map", "[outv]", "-map", "[outa]",
            "-r", str(fps),
            "-c:v", "libx264", "-preset", "medium", "-crf", "14",
            "-c:a", "aac", "-b:a", "192k",
            tmp_out,
        ],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=1800,
    )
    if result.returncode != 0:
        try:
            os.remove(tmp_out)
        except OSError:
            pass
        raise RuntimeError(summarize_ffmpeg_error(result.stderr))
    os.replace(tmp_out, str(video_path))


def cutout_dominant_color(raw_path: str, cutout_path: str, log) -> Image.Image:
    img = Image.open(raw_path).convert("RGB")
    arr = np.array(img).astype(np.int32)

    quant = (arr // BG_QUANTIZE_STEP) * BG_QUANTIZE_STEP
    codes = (quant[..., 0] << 16) | (quant[..., 1] << 8) | quant[..., 2]
    vals, counts = np.unique(codes.reshape(-1), return_counts=True)
    bg_code = int(vals[np.argmax(counts)])
    bg_color = np.array(
        [(bg_code >> 16) & 0xFF, (bg_code >> 8) & 0xFF, bg_code & 0xFF], dtype=np.float64
    )

    dist = np.sqrt(np.sum((arr.astype(np.float64) - bg_color) ** 2, axis=2))
    alpha = np.zeros(dist.shape, dtype=np.float64)
    alpha[dist >= CUTOUT_T2] = 255.0
    ramp = (dist > CUTOUT_T1) & (dist < CUTOUT_T2)
    alpha[ramp] = (dist[ramp] - CUTOUT_T1) / (CUTOUT_T2 - CUTOUT_T1) * 255.0

    alpha_img = Image.fromarray(np.clip(alpha, 0, 255).astype(np.uint8), mode="L")
    alpha_img = alpha_img.filter(ImageFilter.GaussianBlur(radius=1))

    rgba = img.convert("RGBA")
    rgba.putalpha(alpha_img)

    # 裁剪范围只看明显不透明的像素，避免背景渐变/噪点产生的零星低alpha像素把裁剪框撑到全图
    ys, xs = np.where(np.array(alpha_img) > CROP_ALPHA_THRESHOLD)
    if len(xs) == 0 or len(ys) == 0:
        log("警告：抠图后未检测到前景内容（生成图片可能不是纯色背景），使用整张图")
        cropped = rgba
    else:
        x0 = max(0, int(xs.min()) - CROP_PADDING)
        x1 = min(rgba.width, int(xs.max()) + CROP_PADDING + 1)
        y0 = max(0, int(ys.min()) - CROP_PADDING)
        y1 = min(rgba.height, int(ys.max()) + CROP_PADDING + 1)
        cropped = rgba.crop((x0, y0, x1, y1))

    cropped.save(cutout_path)
    return cropped


def scan_videos(folder: str) -> list:
    videos = []
    for entry in os.scandir(folder):
        if entry.is_file() and os.path.splitext(entry.name)[1].lower() in VIDEO_EXTS:
            videos.append(Path(entry.path))
    videos.sort()
    return videos


def summarize_ffmpeg_error(stderr: str) -> str:
    """ffmpeg 失败时日志很长，libx264/aac 的收尾统计行会挤掉真正的报错原因，
    优先摘取含 error/failed/no space 等关键字的行，找不到再退回看原始尾部。"""
    lines = stderr.strip().splitlines()
    hits = [l for l in lines if re.search(r"error|failed|no space|permission denied", l, re.IGNORECASE)]
    if hits:
        return "\n".join(hits[-10:])
    return stderr.strip()[-1500:]


def get_video_dimensions(video_path: str) -> tuple:
    result = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x",
            video_path,
        ],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30,
    )
    if result.returncode != 0:
        raise RuntimeError(f"ffprobe 失败: {summarize_ffmpeg_error(result.stderr)}")
    w_str, h_str = result.stdout.strip().split("x")
    return int(w_str), int(h_str)


_cjk_font_path = None


def find_cjk_font() -> str:
    global _cjk_font_path
    if _cjk_font_path is None:
        for candidate in ID_FONT_CANDIDATES:
            if os.path.isfile(candidate):
                _cjk_font_path = candidate
                break
        else:
            raise RuntimeError("未找到可用的中文字体文件（msyh/simhei/simsun），无法添加ID水印文字")
    return _cjk_font_path


def escape_ffmpeg_path(path: str) -> str:
    return path.replace("\\", "/").replace(":", "\\:")


def escape_drawtext(text: str) -> str:
    return text.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")


def build_id_drawtext_chain(
    id_text: str,
    w: int,
    h: int,
    in_label: str,
    out_label: str,
    title_bottom_y: int = None,
    bottom_right_reserve: int = 0,
) -> str:
    """生成"定时跳位"ID水印的 drawtext 滤镜链：每隔 ID_WATERMARK_SLOT_SECONDS 秒
    循环跳到四角+居中五个位置之一，只在自己的时间窗口内 enable，其余时间原样透传。
    若 title_bottom_y 给定（标题图占了左上角），左上角这个位置改放到标题图下方，避免遮挡。
    bottom_right_reserve 用于把右下角这个位置往上抬，给固定的右下角小字留出空间。"""
    font_path = escape_ffmpeg_path(find_cjk_font())
    text_escaped = escape_drawtext(id_text)
    margin = max(10, round(w * 0.03))
    fontsize = max(14, round(w * 0.035))

    top_left_y = f"{title_bottom_y + margin}" if title_bottom_y is not None else f"{margin}"
    positions = [
        (f"{margin}", top_left_y),
        (f"w-text_w-{margin}", f"{margin}"),
        (f"{margin}", f"h-text_h-{margin}"),
        (f"w-text_w-{margin}", f"h-text_h-{margin}-{bottom_right_reserve}"),
        ("(w-text_w)/2", "(h-text_h)/2"),
    ]
    n = len(positions)
    cycle = ID_WATERMARK_SLOT_SECONDS * n

    parts = []
    cur_in = in_label
    for i, (x_expr, y_expr) in enumerate(positions):
        seg_out = out_label if i == n - 1 else f"idwm{i}"
        slot_start = i * ID_WATERMARK_SLOT_SECONDS
        slot_end = (i + 1) * ID_WATERMARK_SLOT_SECONDS
        enable_expr = f"between(mod(t\\,{cycle})\\,{slot_start}\\,{slot_end})"
        parts.append(
            f"[{cur_in}]drawtext=fontfile='{font_path}':text='{text_escaped}':"
            f"fontsize={fontsize}:fontcolor=white@0.55:"
            f"x={x_expr}:y={y_expr}:enable='{enable_expr}'[{seg_out}]"
        )
        cur_in = seg_out
    return ";".join(parts)


def credit_reserve_height(w: int) -> int:
    """右下角固定小字大致占用的高度（含上下留白），供 ID 水印避让使用。"""
    margin = max(6, round(w * CREDIT_MARGIN_RATIO))
    fontsize = max(10, round(w * CREDIT_FONT_RATIO))
    return fontsize + margin * 2


def build_credit_drawtext(w: int, h: int, in_label: str, out_label: str) -> str:
    """右下角固定不透明小字（每个视频都会加，不受 ID 水印开关影响）。"""
    font_path = escape_ffmpeg_path(find_cjk_font())
    text_escaped = escape_drawtext(CREDIT_TEXT)
    margin = max(6, round(w * CREDIT_MARGIN_RATIO))
    fontsize = max(10, round(w * CREDIT_FONT_RATIO))

    return (
        f"[{in_label}]drawtext=fontfile='{font_path}':text='{text_escaped}':"
        f"fontsize={fontsize}:fontcolor=white:borderw=2:bordercolor=black:"
        f"x=w-text_w-{margin}:y=h-text_h-{margin}[{out_label}]"
    )


def get_or_create_overlay_png(
    cutout_img: Image.Image, target_w: int, overlay_cache: dict, cache_lock: threading.Lock, tmp_dir: str
) -> tuple:
    cached = overlay_cache.get(target_w)
    if cached is not None:
        return cached
    with cache_lock:
        cached = overlay_cache.get(target_w)
        if cached is None:
            ratio = target_w / cutout_img.width
            target_h = max(1, round(cutout_img.height * ratio))
            resized = cutout_img.resize((target_w, target_h), Image.LANCZOS)
            overlay_path = os.path.join(tmp_dir, f"overlay_{target_w}.png")
            resized.save(overlay_path)
            cached = (overlay_path, target_h)
            overlay_cache[target_w] = cached
    return cached


def build_atempo_chain(speed: float) -> str:
    """atempo 单级只支持 0.5~2.0，超出范围时拆成多级串联。"""
    factors = []
    s = speed
    while s > 2.0:
        factors.append(2.0)
        s /= 2.0
    while s < 0.5:
        factors.append(0.5)
        s /= 0.5
    factors.append(s)
    return ",".join(f"atempo={f:.6f}" for f in factors)


def overlay_on_video(
    video_path: Path,
    cutout_img: Image.Image,
    id_text: str,
    speed: float,
    overlay_cache: dict,
    tmp_dir: str,
    cache_lock: threading.Lock,
    intro_path: str = None,
) -> None:
    # 先拼片头（若有），再处理标题贴图/水印/倍速——保证片头也带上片尾这些处理
    if intro_path:
        prepend_intro(video_path, intro_path)

    w, h = get_video_dimensions(str(video_path))
    inputs = ["-i", str(video_path)]
    filter_parts = []
    cur_label = "0:v"
    title_bottom_y = None

    if cutout_img is not None:
        target_w = max(1, round(w * OVERLAY_WIDTH_RATIO))
        overlay_path, target_h = get_or_create_overlay_png(cutout_img, target_w, overlay_cache, cache_lock, tmp_dir)
        inputs += ["-loop", "1", "-i", overlay_path]
        margin_x = round(w * MARGIN_RATIO)
        margin_y = round(h * MARGIN_RATIO)
        title_bottom_y = margin_y + target_h
        out_label = "titled"
        filter_parts.append(f"[0:v][1:v]overlay=x={margin_x}:y={margin_y}:shortest=1[{out_label}]")
        cur_label = out_label

    if id_text:
        filter_parts.append(
            build_id_drawtext_chain(id_text, w, h, cur_label, "idwm", title_bottom_y, credit_reserve_height(w))
        )
        cur_label = "idwm"

    filter_parts.append(build_credit_drawtext(w, h, cur_label, "out"))
    cur_label = "out"

    if speed != 1.0:
        filter_parts.append(f"[{cur_label}]setpts=PTS/{speed:.6f}[sped]")
        cur_label = "sped"

    audio_args = (
        ["-filter:a", build_atempo_chain(speed), "-c:a", "aac", "-b:a", "192k"]
        if speed != 1.0
        else ["-c:a", "copy"]
    )

    tmp_out = str(video_path) + ".tmp_overlay.mp4"
    result = subprocess.run(
        [
            "ffmpeg", "-y",
            *inputs,
            "-filter_complex", ";".join(filter_parts),
            "-map", f"[{cur_label}]", "-map", "0:a?",
            "-c:v", "libx264", "-preset", "medium", "-crf", "14",
            *audio_args,
            tmp_out,
        ],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=1800,
    )
    if result.returncode != 0:
        try:
            os.remove(tmp_out)
        except OSError:
            pass
        raise RuntimeError(summarize_ffmpeg_error(result.stderr))

    os.replace(tmp_out, str(video_path))


class TitleWatermarkApp:
    def __init__(self, root: tk.Tk):
        self.root = root
        root.title("视频标题水印工具")
        self.cutout_image = None
        self.preview_photo = None
        self.intro_video_path = None
        self.intro_preview_photo = None
        self.log_queue = queue.Queue()
        self._build_widgets()
        self.root.after(150, self._poll_queue)

    def _build_widgets(self):
        frm = ttk.Frame(self.root, padding=10)
        frm.grid(row=0, column=0, sticky="nsew")

        ttk.Label(frm, text="视频文件夹:").grid(row=0, column=0, sticky="w", pady=3)
        self.folder_var = tk.StringVar()
        ttk.Entry(frm, textvariable=self.folder_var, width=48).grid(row=0, column=1, padx=4, sticky="w")
        ttk.Button(frm, text="浏览", command=self._browse_folder).grid(row=0, column=2, sticky="w")

        ttk.Label(frm, text="原文txt路径:").grid(row=1, column=0, sticky="w", pady=3)
        self.txt_var = tk.StringVar()
        ttk.Entry(frm, textvariable=self.txt_var, width=48).grid(row=1, column=1, padx=4, sticky="w")
        ttk.Button(frm, text="浏览", command=self._browse_txt).grid(row=1, column=2, sticky="w")

        ttk.Label(frm, text="标题文字:").grid(row=2, column=0, sticky="w", pady=3)
        self.title_var = tk.StringVar()
        ttk.Entry(frm, textvariable=self.title_var, width=48).grid(row=2, column=1, columnspan=2, padx=4, sticky="w")

        self.intro_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(frm, text="生成片头", variable=self.intro_var).grid(row=3, column=0, sticky="w", pady=3)
        ttk.Label(frm, text="ID水印文字(可选):").grid(row=3, column=1, sticky="e", padx=(0, 4))
        self.id_var = tk.StringVar()
        ttk.Entry(frm, textvariable=self.id_var, width=22).grid(row=3, column=2, sticky="w")

        ttk.Label(frm, text="视频倍速:").grid(row=4, column=0, sticky="w", pady=3)
        self.speed_var = tk.StringVar(value=f"{DEFAULT_SPEED:.1f}")
        ttk.Spinbox(
            frm, from_=SPEED_MIN, to=SPEED_MAX, increment=SPEED_STEP,
            textvariable=self.speed_var, width=6, format="%.1f",
        ).grid(row=4, column=1, padx=4, sticky="w")

        btn_row = ttk.Frame(frm)
        btn_row.grid(row=5, column=0, columnspan=3, pady=6, sticky="w")
        self.gen_btn = ttk.Button(btn_row, text="生成标题图", command=self._on_generate_click)
        self.gen_btn.grid(row=0, column=0, padx=(0, 6))
        self.regen_btn = ttk.Button(btn_row, text="重新生成", command=self._on_generate_click, state="disabled")
        self.regen_btn.grid(row=0, column=1, padx=(0, 6))
        self.apply_btn = ttk.Button(btn_row, text="应用到所有视频", command=self._on_apply_click)
        self.apply_btn.grid(row=0, column=2)

        previews_frame = ttk.Frame(frm)
        previews_frame.grid(row=6, column=0, columnspan=3, pady=4, sticky="w")

        title_col = ttk.Frame(previews_frame)
        title_col.grid(row=0, column=0, sticky="nw", padx=(0, 16))
        ttk.Label(title_col, text="标题图预览:").grid(row=0, column=0, sticky="w")
        self.preview_label = tk.Label(
            title_col, text="（预览）", width=36, height=10, relief="groove", bg="#dddddd"
        )
        self.preview_label.grid(row=1, column=0, pady=4, sticky="w")

        intro_col = ttk.Frame(previews_frame)
        intro_col.grid(row=0, column=1, sticky="nw")
        ttk.Label(intro_col, text="片头预览:").grid(row=0, column=0, sticky="w")
        self.intro_preview_label = tk.Label(
            intro_col, text="（无）", width=24, height=10, relief="groove", bg="#dddddd"
        )
        self.intro_preview_label.grid(row=1, column=0, pady=4, sticky="w")
        self.play_intro_btn = ttk.Button(
            intro_col, text="播放片头", command=self._on_play_intro_click, state="disabled"
        )
        self.play_intro_btn.grid(row=2, column=0, sticky="w")

        ttk.Label(frm, text="日志:").grid(row=7, column=0, sticky="w")
        self.log_text = tk.Text(frm, width=76, height=9, state="disabled")
        self.log_text.grid(row=8, column=0, columnspan=3, pady=4, sticky="w")

    def _browse_folder(self):
        path = filedialog.askdirectory()
        if path:
            self.folder_var.set(path)

    def _browse_txt(self):
        path = filedialog.askopenfilename(filetypes=[("Text files", "*.txt")])
        if path:
            self.txt_var.set(path)

    def _log(self, msg: str):
        self.log_queue.put(msg)

    def _append_log(self, text: str):
        self.log_text.config(state="normal")
        self.log_text.insert("end", text + "\n")
        self.log_text.see("end")
        self.log_text.config(state="disabled")

    def _poll_queue(self):
        while True:
            try:
                msg = self.log_queue.get_nowait()
            except queue.Empty:
                break
            if isinstance(msg, tuple) and msg[0] == "__preview__":
                self._set_preview(msg[1])
            elif isinstance(msg, tuple) and msg[0] == "__intro_preview__":
                self.intro_video_path = msg[1]
                self._set_intro_preview(msg[2])
            elif isinstance(msg, tuple) and msg[0] == "__done_generate__":
                self.gen_btn.config(state="normal")
                if self.cutout_image is not None or self.intro_video_path is not None:
                    self.regen_btn.config(state="normal")
            elif isinstance(msg, tuple) and msg[0] == "__done_apply__":
                self.apply_btn.config(state="normal")
            else:
                self._append_log(str(msg))
        self.root.after(150, self._poll_queue)

    def _set_preview(self, cutout_path: str):
        img = Image.open(cutout_path).convert("RGBA")
        img.thumbnail((PREVIEW_MAX_SIZE, PREVIEW_MAX_SIZE), Image.LANCZOS)
        bg = Image.new("RGBA", img.size, (221, 221, 221, 255))
        bg.alpha_composite(img)
        self.preview_photo = ImageTk.PhotoImage(bg.convert("RGB"))
        # width/height 在挂了图片之后单位从"字符数"变成"像素"，必须显式设成图片实际像素尺寸，
        # 不能用 0（不同 Tk 版本对 0 的处理不一致，可能导致控件塌缩成几乎看不见）
        self.preview_label.config(image=self.preview_photo, text="", width=bg.width, height=bg.height)

    def _set_intro_preview(self, poster_path: str):
        img = Image.open(poster_path).convert("RGB")
        img.thumbnail((PREVIEW_MAX_SIZE, PREVIEW_MAX_SIZE), Image.LANCZOS)
        self.intro_preview_photo = ImageTk.PhotoImage(img)
        self.intro_preview_label.config(image=self.intro_preview_photo, text="", width=img.width, height=img.height)
        self.play_intro_btn.config(state="normal")

    def _on_play_intro_click(self):
        if self.intro_video_path and os.path.isfile(self.intro_video_path):
            os.startfile(self.intro_video_path)

    def _on_generate_click(self):
        folder = self.folder_var.get().strip()
        title = self.title_var.get().strip()
        txt_path = self.txt_var.get().strip()
        gen_intro = self.intro_var.get()

        if not folder or not os.path.isdir(folder):
            messagebox.showerror("错误", "请先选择有效的视频文件夹")
            return
        if not title:
            messagebox.showerror("错误", "请输入标题文字")
            return
        if txt_path and not os.path.isfile(txt_path):
            messagebox.showerror("错误", "原文txt路径无效")
            return
        if gen_intro and not txt_path:
            messagebox.showerror("错误", "生成片头需要先提供原文txt路径")
            return

        self.gen_btn.config(state="disabled")
        self.regen_btn.config(state="disabled")
        self._append_log("=== 开始生成标题图" + ("与片头" if gen_intro else "") + " ===")
        threading.Thread(
            target=self._generate_worker, args=(folder, title, txt_path, gen_intro), daemon=True
        ).start()

    def _generate_worker(self, folder: str, title: str, txt_path: str, gen_intro: bool):
        threads = [threading.Thread(target=self._generate_title_worker, args=(folder, title, txt_path), daemon=True)]
        if gen_intro:
            threads.append(threading.Thread(target=self._generate_intro_worker, args=(folder, txt_path), daemon=True))
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.log_queue.put(("__done_generate__",))

    def _generate_title_worker(self, folder: str, title: str, txt_path: str):
        try:
            design = ""
            if txt_path:
                self._log(f"读取原文并推测标题设计方案：{txt_path}")
                design = infer_title_design(txt_path, self._log)
                if design:
                    self._log(f"推测设计方案：{design}")

            prompt = build_image_prompt(title, design)
            raw_path = os.path.join(folder, "_title_raw.png")
            cutout_path = os.path.join(folder, "_title_cutout.png")

            self._log("调用生图接口...")
            if not generate_raw_image(prompt, raw_path, self._log):
                self._log("生成失败，已中止")
                return
            self._log(f"原图已保存：{raw_path}")

            self._log("开始抠图...")
            self.cutout_image = cutout_dominant_color(raw_path, cutout_path, self._log)
            self._log(f"抠图完成：{cutout_path}")
            self.log_queue.put(("__preview__", cutout_path))
        except Exception as e:
            self._log(f"生成过程出错：{e}")

    def _generate_intro_worker(self, folder: str, txt_path: str):
        try:
            resources = scan_reference_resources(folder)
            self._log(f"[片头] 扫描到 {len(resources)} 张角色/场景参考图")

            self._log("[片头] 生成创意（参考图 prompt + 视频 prompt）...")
            creative = infer_intro_creative(txt_path, list(resources.keys()), self._log)
            if not creative:
                return

            self._log(f"[片头] LLM 原始输出：{json.dumps(creative, ensure_ascii=False, indent=2)}")

            ref_image_paths = [resources[n] for n in creative.get("reference_images", [])]
            if ref_image_paths:
                numbered = ", ".join(f"image{i}={n}" for i, n in enumerate(creative["reference_images"], start=1))
                self._log(f"[片头] 参考图顺序（对应 ref_image_prompt 里的 image N）：{numbered}")

            ref_path = os.path.join(folder, "_intro_ref.png")
            intro_path = os.path.join(folder, "_intro.mp4")

            self._log("[片头] 生成参考图...")
            if not generate_raw_image(creative["ref_image_prompt"], ref_path, self._log, ref_image_paths):
                self._log("[片头] 参考图生成失败，已中止")
                return
            self._log(f"[片头] 参考图已保存：{ref_path}")

            self._log("[片头] 调用视频生成接口（happyhorse）...")
            if not generate_intro_video(ref_path, creative["video_prompt"], intro_path, self._log):
                self._log("[片头] 视频生成失败，已中止")
                return

            poster_path = os.path.join(folder, "_intro_poster.png")
            if extract_poster_frame(intro_path, poster_path):
                self.log_queue.put(("__intro_preview__", intro_path, poster_path))
            else:
                self._log("[片头] 抽帧预览失败（视频已生成，可直接打开文件查看）")
        except Exception as e:
            self._log(f"[片头] 生成过程出错：{e}")

    def _on_apply_click(self):
        folder = self.folder_var.get().strip()
        if not folder or not os.path.isdir(folder):
            messagebox.showerror("错误", "请先选择有效的视频文件夹")
            return

        id_text = self.id_var.get().strip()
        cutout_path = os.path.join(folder, "_title_cutout.png")
        has_title = os.path.isfile(cutout_path)
        intro_path = os.path.join(folder, "_intro.mp4")
        has_intro = os.path.isfile(intro_path)

        try:
            speed = round(float(self.speed_var.get()), 1)
        except ValueError:
            messagebox.showerror("错误", "倍速必须是数字")
            return
        if not (SPEED_MIN <= speed <= SPEED_MAX):
            messagebox.showerror("错误", f"倍速必须在 {SPEED_MIN}~{SPEED_MAX} 之间")
            return

        videos = scan_videos(folder)
        if not videos:
            messagebox.showinfo("提示", "该文件夹下没有找到视频文件")
            return

        parts = []
        if has_intro:
            parts.append("片头")
        if has_title:
            parts.append("标题图")
        if id_text:
            parts.append(f"ID水印「{id_text}」")
        parts.append("右下角固定小字")
        parts.append(f"{speed}倍速")
        if not messagebox.askyesno(
            "确认覆盖",
            f"即将直接覆盖 {len(videos)} 个视频文件（贴上{'+'.join(parts)}），此操作不可撤销，是否继续？",
        ):
            return

        self.apply_btn.config(state="disabled")
        self._append_log(f"=== 开始批量处理 {len(videos)} 个视频 ===")
        threading.Thread(
            target=self._apply_worker,
            args=(videos, cutout_path if has_title else None, id_text, speed, intro_path if has_intro else None),
            daemon=True,
        ).start()

    def _apply_worker(self, videos: list, cutout_path, id_text: str, speed: float, intro_path: str = None):
        tmp_dir = tempfile.mkdtemp(prefix="title_wm_")
        cutout_img = Image.open(cutout_path).convert("RGBA") if cutout_path else None
        overlay_cache = {}
        cache_lock = threading.Lock()
        ok_count = 0
        fail_count = 0
        total = len(videos)
        self._log(f"并发数：{OVERLAY_CONCURRENCY}")
        try:
            with concurrent.futures.ThreadPoolExecutor(max_workers=OVERLAY_CONCURRENCY) as executor:
                future_to_video = {
                    executor.submit(
                        overlay_on_video, video, cutout_img, id_text, speed, overlay_cache, tmp_dir, cache_lock,
                        intro_path,
                    ): video
                    for video in videos
                }
                for done, future in enumerate(concurrent.futures.as_completed(future_to_video), 1):
                    video = future_to_video[future]
                    try:
                        future.result()
                        self._log(f"[{done}/{total}] 完成: {video.name}")
                        ok_count += 1
                    except Exception as e:
                        self._log(f"[{done}/{total}] 失败: {video.name} — {e}")
                        fail_count += 1
            self._log(f"=== 批量处理完成：成功 {ok_count}，失败 {fail_count} ===")
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)
            self.log_queue.put(("__done_apply__",))


def parse_cli_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="视频标题水印/片头工具（命令行模式，不传参数则打开 GUI）")
    parser.add_argument("--folder", required=True, help="生成产物落地的目录（标题图/片头也在这里找角色场景资源）")
    parser.add_argument("--title", required=True, help="标题文字")
    parser.add_argument("--txt", default="", help="原文txt路径（推测标题风格 + 生成片头都要用）")
    parser.add_argument("--no-intro", action="store_true", help="不生成片头")
    parser.add_argument("--apply", action="store_true", help="生成完直接应用到视频（贴标题/片头/水印，直接覆盖视频）")
    parser.add_argument("--videos-folder", default="", help="应用步骤扫描视频的目录，默认等于 --folder")
    parser.add_argument("--id-text", default="", help="ID水印文字（可选）")
    parser.add_argument("--speed", type=float, default=DEFAULT_SPEED, help="视频倍速")
    return parser.parse_args()


def run_cli(args: argparse.Namespace) -> None:
    def log(msg: str) -> None:
        print(msg, flush=True)

    folder = args.folder
    title = args.title
    txt_path = args.txt
    gen_intro = not args.no_intro

    if not os.path.isdir(folder):
        log(f"错误：文件夹不存在 {folder}")
        return
    if txt_path and not os.path.isfile(txt_path):
        log(f"错误：原文txt路径无效 {txt_path}")
        return

    log(f"=== 开始生成标题图{'与片头' if gen_intro else ''} ===")

    design = ""
    if txt_path:
        log(f"读取原文并推测标题设计方案：{txt_path}")
        design = infer_title_design(txt_path, log)
        if design:
            log(f"推测设计方案：{design}")

    prompt = build_image_prompt(title, design)
    raw_path = os.path.join(folder, "_title_raw.png")
    cutout_path = os.path.join(folder, "_title_cutout.png")

    log("调用生图接口...")
    if generate_raw_image(prompt, raw_path, log):
        log(f"原图已保存：{raw_path}")
        log("开始抠图...")
        cutout_dominant_color(raw_path, cutout_path, log)
        log(f"抠图完成：{cutout_path}")
    else:
        log("标题图生成失败")

    if gen_intro:
        if not txt_path:
            log("[片头] 没有提供 --txt，跳过片头生成")
        else:
            resources = scan_reference_resources(folder)
            log(f"[片头] 扫描到 {len(resources)} 张角色/场景参考图")
            log("[片头] 生成创意（参考图 prompt + 视频 prompt）...")
            creative = infer_intro_creative(txt_path, list(resources.keys()), log)
            if not creative:
                log("[片头] 创意生成失败，跳过片头")
            else:
                log(f"[片头] LLM 原始输出：{json.dumps(creative, ensure_ascii=False, indent=2)}")
                ref_image_paths = [resources[n] for n in creative.get("reference_images", [])]
                if ref_image_paths:
                    numbered = ", ".join(
                        f"image{i}={n}" for i, n in enumerate(creative["reference_images"], start=1)
                    )
                    log(f"[片头] 参考图顺序（对应 ref_image_prompt 里的 image N）：{numbered}")

                ref_path = os.path.join(folder, "_intro_ref.png")
                intro_path = os.path.join(folder, "_intro.mp4")

                log("[片头] 生成参考图...")
                if not generate_raw_image(creative["ref_image_prompt"], ref_path, log, ref_image_paths):
                    log("[片头] 参考图生成失败，已中止")
                else:
                    log(f"[片头] 参考图已保存：{ref_path}")
                    log("[片头] 调用视频生成接口...")
                    if generate_intro_video(ref_path, creative["video_prompt"], intro_path, log):
                        log(f"[片头] 视频已生成：{intro_path}")
                    else:
                        log("[片头] 视频生成失败")

    if args.apply:
        videos_folder = args.videos_folder or folder
        if not os.path.isdir(videos_folder):
            log(f"错误：--videos-folder 不存在 {videos_folder}")
            return
        videos = scan_videos(videos_folder)
        if not videos:
            log(f"应用步骤：{videos_folder} 下没有找到视频文件，跳过")
            return

        intro_path = os.path.join(folder, "_intro.mp4")
        has_intro = os.path.isfile(intro_path)
        cutout_path = os.path.join(folder, "_title_cutout.png")
        has_title = os.path.isfile(cutout_path)
        cutout_img = Image.open(cutout_path).convert("RGBA") if has_title else None

        log(f"=== 应用到 {len(videos)} 个视频（{videos_folder}），片头={has_intro}，标题图={has_title} ===")
        tmp_dir = tempfile.mkdtemp(prefix="title_wm_cli_")
        overlay_cache = {}
        cache_lock = threading.Lock()
        ok_count = fail_count = 0
        try:
            for video in videos:
                try:
                    overlay_on_video(
                        video, cutout_img, args.id_text, args.speed, overlay_cache, tmp_dir, cache_lock,
                        intro_path if has_intro else None,
                    )
                    log(f"完成: {video.name}")
                    ok_count += 1
                except Exception as e:
                    log(f"失败: {video.name} — {e}")
                    fail_count += 1
            log(f"=== 应用完成：成功 {ok_count}，失败 {fail_count} ===")
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)


def main():
    if len(sys.argv) > 1:
        run_cli(parse_cli_args())
    else:
        root = tk.Tk()
        TitleWatermarkApp(root)
        root.mainloop()


if __name__ == "__main__":
    main()
