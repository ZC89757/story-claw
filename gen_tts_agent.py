"""
gen_tts_agent.py - 分角色 TTS 音频生成（LLM agent + MiMo API）

用法:
    python gen_tts_agent.py <storyboard.jsonl> [--output OUTPUT] [--voice-map VOICE_MAP]

流程:
    Phase 1: LLM 标注文本片段（说话人、性别、风格）
    Phase 2: LLM 统一分配声音（更新 voice_map.json）
    Phase 3: 并发 LLM agent 调用 TTS 工具生成各片段音频
    Phase 4: ffmpeg 拼接所有片段
"""

import argparse
import asyncio
import base64
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

import httpx
from openai import AsyncOpenAI, OpenAI

# ── 配置（从 ~/.story-claw/tts_config.json 读取）─────────────────────────────

_tts_cfg = json.loads(
    (Path.home() / ".story-claw" / "tts_config.json").read_text(encoding="utf-8")
)

API_KEY   = _tts_cfg["api_key"]
BASE_URL  = _tts_cfg.get("base_url", "https://token-plan-cn.xiaomimimo.com/v1")
CHAT_MODEL = _tts_cfg.get("chat_model", "mimo-v2.5-pro")
TTS_MODEL  = _tts_cfg.get("tts_model", "mimo-v2.5-tts")
PROXY_URL  = _tts_cfg.get("proxy", "http://127.0.0.1:7890")

AVAILABLE_VOICES = _tts_cfg.get("voices", {"冰糖": "女", "茉莉": "女", "苏打": "男", "白桦": "男"})
NARRATOR_VOICE   = _tts_cfg.get("narrator_voice", "白桦")

MAX_CONCURRENT = _tts_cfg.get("concurrency", 4)


def _sync_client() -> OpenAI:
    return OpenAI(
        api_key=API_KEY,
        base_url=BASE_URL,
        http_client=httpx.Client(proxy=PROXY_URL, timeout=90),
    )


def _async_client() -> AsyncOpenAI:
    return AsyncOpenAI(
        api_key=API_KEY,
        base_url=BASE_URL,
        http_client=httpx.AsyncClient(proxy=PROXY_URL, timeout=90),
    )


# ── Phase 0: 读取并清理文本 ────────────────────────────────────────────────────

def load_clean_text(jsonl_path: Path) -> str:
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


# ── Phase 1: LLM 标注片段 ──────────────────────────────────────────────────────

ANNOTATE_SYSTEM = """\
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


def phase1_annotate(full_text: str) -> list[dict]:
    print("[Phase 1] LLM 标注文本片段...")
    client = _sync_client()
    resp = client.chat.completions.create(
        model=CHAT_MODEL,
        messages=[
            {"role": "system", "content": ANNOTATE_SYSTEM},
            {"role": "user",   "content": full_text},
        ],
        temperature=0.3,
    )
    raw = resp.choices[0].message.content.strip()
    m = re.search(r"\[.*\]", raw, re.DOTALL)
    if m:
        raw = m.group(0)
    segments = json.loads(raw)
    print(f"[Phase 1] 共 {len(segments)} 个片段")
    for i, s in enumerate(segments):
        print(f"  [{i:02d}] [{s['speaker']}] {s['text'][:40]}...")
    return segments


# ── Phase 2: LLM 统一分配声音 ──────────────────────────────────────────────────

ASSIGN_SYSTEM = """\
你是声音分配助手。

规则：
- 旁白固定用"白桦"
- 已有 voice_map 中的角色：直接沿用，不可更改
- 新角色：从同性别声音中选一个，优先选还没被其他角色使用的；若都用过则复用

输出完整的 voice_map JSON 对象（含原有映射 + 新增），不要任何其他文字：
{"旁白": "白桦", "学姐": "冰糖", ...}\
"""


def phase2_assign_voices(segments: list[dict], voice_map: dict) -> dict:
    print("[Phase 2] LLM 分配声音...")
    client = _sync_client()

    chars = {}
    for seg in segments:
        sp = seg["speaker"]
        if sp not in chars:
            chars[sp] = seg["gender"]

    user_content = (
        f"当前 voice_map：\n{json.dumps(voice_map, ensure_ascii=False, indent=2)}\n\n"
        f"可用声音（名称→性别）：\n{json.dumps(AVAILABLE_VOICES, ensure_ascii=False)}\n\n"
        f"本次出现的角色（名称→性别）：\n{json.dumps(chars, ensure_ascii=False)}"
    )
    resp = client.chat.completions.create(
        model=CHAT_MODEL,
        messages=[
            {"role": "system", "content": ASSIGN_SYSTEM},
            {"role": "user",   "content": user_content},
        ],
        temperature=0,
    )
    raw = resp.choices[0].message.content.strip()
    m = re.search(r"\{.*\}", raw, re.DOTALL)
    if m:
        raw = m.group(0)
    new_map = json.loads(raw)
    print(f"[Phase 2] voice_map: {new_map}")
    return new_map


# ── Phase 3: 并发 LLM agent → TTS 工具 ────────────────────────────────────────

TTS_AGENT_SYSTEM = """\
你是 TTS 合成助手。你会收到一个文本片段、已分配的声音和风格描述。
请调用 generate_tts 工具合成语音。
style_prompt 参数：根据风格描述，写一句简洁的朗读指令（中文，20字以内）。\
"""

TTS_TOOL_DEF = {
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


def _exec_tts(text: str, voice: str, style_prompt: str, output_path: Path) -> Path:
    """实际调用 MiMo TTS API 并保存文件"""
    payload = {
        "model": TTS_MODEL,
        "messages": [
            {"role": "user",      "content": style_prompt},
            {"role": "assistant", "content": text},
        ],
        "audio":  {"format": "mp3", "voice": voice},
        "stream": False,
    }
    resp = httpx.post(
        f"{BASE_URL}/chat/completions",
        headers={"api-key": API_KEY, "Content-Type": "application/json"},
        json=payload,
        proxy=PROXY_URL,
        timeout=90,
    )
    data = resp.json()
    if "error" in data:
        raise RuntimeError(f"TTS API 错误: {data['error']}")
    audio_b64 = data["choices"][0]["message"]["audio"]["data"]
    output_path.write_bytes(base64.b64decode(audio_b64))
    return output_path


async def _generate_one(
    sem: asyncio.Semaphore,
    idx: int,
    seg: dict,
    voice: str,
    output_path: Path,
) -> Path:
    async with sem:
        speaker = seg["speaker"]
        print(f"  [seg {idx:02d}] [{speaker}→{voice}] {seg['text'][:35]}...")

        client = _async_client()
        resp = await client.chat.completions.create(
            model=CHAT_MODEL,
            messages=[
                {"role": "system", "content": TTS_AGENT_SYSTEM},
                {"role": "user",   "content": (
                    f"文本：{seg['text']}\n"
                    f"声音：{voice}\n"
                    f"风格描述：{seg['style']}"
                )},
            ],
            tools=[TTS_TOOL_DEF],
            tool_choice="required",
        )

        msg = resp.choices[0].message
        if not msg.tool_calls:
            raise RuntimeError(f"seg {idx}: LLM 未调用工具，回复: {msg.content}")

        args = json.loads(msg.tool_calls[0].function.arguments)

        # 强制使用预分配的声音，防止 LLM 乱改
        args["voice"] = voice

        result = await asyncio.get_event_loop().run_in_executor(
            None, _exec_tts, args["text"], args["voice"], args["style_prompt"], output_path
        )
        print(f"  [seg {idx:02d}] 完成 → {output_path.name} ({output_path.stat().st_size // 1024}KB)")
        return result


async def phase3_generate_all(
    segments: list[dict],
    voice_map: dict,
    tmp_dir: Path,
) -> list[Path]:
    print(f"[Phase 3] 并发生成 {len(segments)} 个片段（最大并发 {MAX_CONCURRENT}）...")
    tmp_dir.mkdir(parents=True, exist_ok=True)

    sem = asyncio.Semaphore(MAX_CONCURRENT)
    tasks = []
    for i, seg in enumerate(segments):
        voice = voice_map.get(seg["speaker"], NARRATOR_VOICE)
        out = tmp_dir / f"seg_{i:03d}.mp3"
        tasks.append(_generate_one(sem, i, seg, voice, out))

    results = await asyncio.gather(*tasks)
    return list(results)


# ── Phase 4: ffmpeg 拼接 ───────────────────────────────────────────────────────

def phase4_concat(audio_files: list[Path], output_path: Path):
    print(f"[Phase 4] 拼接 {len(audio_files)} 个片段 → {output_path.name}")
    # 全部转绝对路径，避免 Windows 中文路径问题
    abs_files = [p.resolve() for p in sorted(audio_files)]
    abs_output = output_path.resolve()
    list_file = abs_output.parent / "_concat_list.txt"

    with open(list_file, "w", encoding="utf-8") as f:
        for p in abs_files:
            # ffmpeg concat list 用单引号包裹，反斜杠转义
            escaped = str(p).replace("\\", "/")
            f.write(f"file '{escaped}'\n")

    result = subprocess.run(
        ["ffmpeg", "-y", "-f", "concat", "-safe", "0",
         "-i", str(list_file.resolve()), "-c:a", "libmp3lame", "-q:a", "2", str(abs_output)],
        capture_output=True,
    )
    list_file.unlink(missing_ok=True)
    if result.returncode != 0:
        print("ffmpeg stderr:", result.stderr.decode("utf-8", errors="replace")[-500:])
        raise RuntimeError("ffmpeg concat 失败")
    print(f"[Phase 4] 完成 → {abs_output}")


# ── 主流程 ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="分角色 TTS 音频生成")
    parser.add_argument("jsonl",       help="storyboard JSONL 文件路径")
    parser.add_argument("--output",    help="输出 MP3 路径")
    parser.add_argument("--voice-map", help="voice_map.json 路径（默认：小说根目录）")
    args = parser.parse_args()

    jsonl_path = Path(args.jsonl)
    if not jsonl_path.exists():
        print(f"错误: 文件不存在: {jsonl_path}", file=sys.stderr)
        sys.exit(1)

    # voice_map 存在小说根目录（ep01 的上一层）
    voice_map_path = (
        Path(args.voice_map) if args.voice_map
        else jsonl_path.parent.parent / "voice_map.json"
    )
    output_path = (
        Path(args.output) if args.output
        else jsonl_path.parent / (jsonl_path.stem.replace("storyboard_", "tts_agent_") + ".mp3")
    )
    tmp_dir = output_path.parent / "tts_segments"

    # 读取已有 voice_map
    voice_map = {}
    if voice_map_path.exists():
        voice_map = json.loads(voice_map_path.read_text(encoding="utf-8"))
        print(f"[载入] voice_map ({voice_map_path}): {voice_map}")

    # Phase 0
    full_text = load_clean_text(jsonl_path)
    print(f"[Phase 0] 提取文本 {len(full_text)} 字\n")

    # Phase 1
    segments = phase1_annotate(full_text)
    print()

    # Phase 2
    voice_map = phase2_assign_voices(segments, voice_map)
    voice_map_path.write_text(
        json.dumps(voice_map, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"[Phase 2] voice_map 已保存: {voice_map_path}\n")

    # Phase 3
    audio_files = asyncio.run(phase3_generate_all(segments, voice_map, tmp_dir))
    print()

    # Phase 4
    phase4_concat(audio_files, output_path)
    print(f"\n完成！输出: {output_path}")


if __name__ == "__main__":
    main()
