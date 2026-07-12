#!/usr/bin/env python3
"""
pipeline_wrapper.py — 调度型版本 v6（双队列互斥轮转，去字幕改用 LTX2.3 工作流）

架构：
  /prompt 只登记 + 塞进 i2v_pending，不立即提交给 ComfyUI。
  _scheduler_loop 是唯一的后台线程，死循环交替跑两个阶段：
    i2v 阶段：耗尽 i2v_pending（一个提交、等它跑完、再提交下一个，直到队列空
              且没有 job 卡在 queued/running），PersonFaceGate 节点（Gate1/2）
              在这一步的 ComfyUI 图里回调 POST /gate_verdict。
    去字幕阶段：耗尽 sttn_pending，每个 job 先跑 check_subtitle_presence 前置
              探测（VLM 判断有没有字幕/水印），无字幕直接短路成功；有字幕才跑
              run_ltx_subtitle_removal，完成即成功（不再做去字幕后的残留检测）。
  两阶段互斥由代码结构保证，不存在"猜时机"的等待逻辑，详见
  STTN_SCHEDULER_REWRITE_PLAN.md。
  无字幕 → i2v 完成即 success；有字幕 → 去字幕全部完成后 success。

  v6 变化：去字幕方法从外部 video-subtitle-remover（STTN+LaMa 子进程）换成
  LTX2.3 IC-LoRA 去水印/去字幕 ComfyUI 工作流（video_ltx2_3_subtitle_remove.json）。
  该工作流没有内置的廉价字幕探测（不像旧工具会先 OCR 探测再决定要不要跑），
  所以新增 check_subtitle_presence 作为前置 Gate，复用"抽中间3帧喂 VLM"的机制
  （_vlm_subtitle_probe）。去字幕后不再做残留检测（原 Gate3 已移除）。
  与 i2v 共用同一个 ComfyUI 进程和同一份底模，不再需要在两阶段之间主动腾显存
  （见 run_ltx_subtitle_removal 与已删除的 _free_comfy_vram）。队列/调度结构、
  Gate1/2、dashboard、history 全部不变，只是"去字幕"这一步换了引擎并加了前置探测。
"""
from __future__ import annotations

import base64
import hashlib
import html
import json
import os
import queue
import random
import re
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
import urllib.request
import urllib.parse
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# ─── 配置 ──────────────────────────────────────────────────────────────────────
PORT           = 8191
COMFY_BASE     = "http://127.0.0.1:8188"
IMAGE_TMP_DIR  = Path("/tmp/wrap_imgs"); IMAGE_TMP_DIR.mkdir(exist_ok=True)
HISTORY_PATH   = Path("/root/job_history.jsonl")
COMFY_INPUT    = Path("/root/ComfyUI/input")
COMFY_OUTPUT   = Path("/root/ComfyUI/output")
WF_I2V         = "/root/video_ltx2_3_i2v_PRESUB.json"
WF_SUBTITLE_REMOVE = "/root/video_ltx2_3_subtitle_remove.json"
LTX_FRAME_STEP = 8

VSR_FFMPEG  = "/root/video-subtitle-remover/backend/ffmpeg/linux_x64/ffmpeg"

for _bin in ("/root/miniconda3/bin", "/usr/local/ffmpeg/bin"):
    if _bin not in os.environ.get("PATH", ""):
        os.environ["PATH"] = f"{_bin}:{os.environ.get('PATH', '')}"

# ─── 画面质检 Gate 配置（Gate1/2/3 共用同一个多模态模型，重试阈值各自独立）─────
VISION_BASE_URL   = "https://zenmux.ai/api/anthropic"
VISION_API_KEY    = "xxxxx"

# 以下三项可在 dashboard 页面上改，持久化到 GATE_CONFIG_PATH，重启进程不丢、改完立即生效：
#   - VISION_MODEL：comfy_person_face_gate_node.py（Gate1/2）每次调用前会来 GET /vision_model 取值；
#     Gate3（本进程内）调用 call_vision_llm 时直接读这个全局变量，天然实时生效。
#   - GATE12_RETRY_LIMIT / GATE3_RETRY_LIMIT：gate_decide() 每次调用时读全局变量判断，无需重启。
GATE_CONFIG_PATH   = Path("/root/gate_config.json")
_DEFAULT_VISION_MODEL       = "stepfun/step-3.7-flash"
_DEFAULT_GATE12_RETRY_LIMIT = 5
_DEFAULT_GATE3_RETRY_LIMIT  = 5
_gate_config_lock = threading.Lock()


def _load_gate_config() -> dict:
    try:
        return json.loads(GATE_CONFIG_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_gate_config() -> None:
    GATE_CONFIG_PATH.write_text(json.dumps({
        "vision_model":       VISION_MODEL,
        "gate12_retry_limit": GATE12_RETRY_LIMIT,
        "gate3_retry_limit":  GATE3_RETRY_LIMIT,
    }, ensure_ascii=False), encoding="utf-8")


_loaded_cfg        = _load_gate_config()
VISION_MODEL       = _loaded_cfg.get("vision_model") or _DEFAULT_VISION_MODEL
GATE12_RETRY_LIMIT = int(_loaded_cfg.get("gate12_retry_limit") or _DEFAULT_GATE12_RETRY_LIMIT)
GATE3_RETRY_LIMIT  = int(_loaded_cfg.get("gate3_retry_limit")  or _DEFAULT_GATE3_RETRY_LIMIT)


def set_vision_model(model: str) -> None:
    global VISION_MODEL
    with _gate_config_lock:
        VISION_MODEL = model
        _save_gate_config()


def set_gate_retry_limits(gate12: int, gate3: int) -> None:
    global GATE12_RETRY_LIMIT, GATE3_RETRY_LIMIT
    with _gate_config_lock:
        GATE12_RETRY_LIMIT = gate12
        GATE3_RETRY_LIMIT  = gate3
        _save_gate_config()

# 去字幕前置探测用的 prompt：共用同一套"抽中间3帧
# 喂 VLM"机制（见 _vlm_subtitle_probe），只是问的问题反过来——判断有没有字幕
# 需要处理，而不是处理完有没有残留。LTX2.3 去字幕工作流本身没有内置的廉价
# 探测能力，靠这个前置 Gate 决定要不要跑（没字幕就跳过，省下整段生成式修复）。
SUBTITLE_PRESENCE_PROMPT = """这三张图片是同一段视频的画面（已排除首尾帧）。请判断这三张图里有没有任意一张存在明显的字幕/水印文字——这类文字的典型特征是像贴在画面表层的一层叠加物，不随镜头透视、光影、景深变化，跟所在位置的场景明显不融合，一眼就能看出是后期加上去的，可能出现在画面任意位置，不限于画面底部。
注意排除：画面场景里原本就存在的文字，比如门牌号、招牌、路牌、书本封面、屏幕显示内容等——只要这些文字符合所在物体的透视、光影、景深，看起来是场景里真实存在的东西，即使能看清内容也不算，不需要标记。
只输出如下 JSON：
{"has_subtitle": true/false, "which_frame": 1/2/3/null, "reason": "一句话说明"}"""

# 去字幕阶段并发度：v6 起去字幕本身也是提交给 ComfyUI 的一次生成任务，跟 i2v
# 共用同一个 GPU/ComfyUI 进程，不存在真正的并行空间，固定为 1（串行）。
STTN_CONCURRENCY = 1

# ─── 状态 ──────────────────────────────────────────────────────────────────────
# status: "queued" | "running" | "queued_sttn" | "sttn" | "success" | "error"
_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()

# 双队列：i2v_pending 存"已接单等提交给 ComfyUI"的 prompt_id，sttn_pending 存
# "i2v 已完成等跑 STTN"的 prompt_id。调度循环保证两个队列互斥消费，见 _scheduler_loop。
i2v_pending: queue.Queue = queue.Queue()
sttn_pending: queue.Queue = queue.Queue()

_comfy_ready_flag = False
_comfy_ready_lock = threading.Lock()

_history_lock = threading.Lock()

# (job_key, gate) -> 该 gate 自己的连续失败次数。Gate1/2（gate="person_face"）和
# Gate3（gate="subtitle"）分开计数、互不影响——同一条视频重试时 Gate1/2 通常一直通过，
# 如果共用一个计数器，Gate1/2 每次"通过"都会把计数器清零，导致 Gate3 的失败永远
# 攒不到阈值、无限重试（曾经踩过这个坑）。分开后各自独立累积到自己的阈值才放行。
_gate_attempts: dict[tuple[str, str], int] = {}
_gate_lock = threading.Lock()


def gate_decide(job_key: str, gate: str, passed: bool) -> str:
    """返回 'continue'（通过）| 'reject'（未达上限，拦下重来）| 'accept_anyway'（达到上限，放行）"""
    limit = GATE12_RETRY_LIMIT if gate == "person_face" else GATE3_RETRY_LIMIT
    key = (job_key, gate)
    with _gate_lock:
        if passed:
            _gate_attempts.pop(key, None)
            return "continue"
        attempts = _gate_attempts.get(key, 0) + 1
        if attempts >= limit:
            _gate_attempts.pop(key, None)
            return "accept_anyway"
        _gate_attempts[key] = attempts
        return "reject"


def call_vision_llm(images_png: list[bytes], prompt: str) -> dict | None:
    content = [
        {"type": "image", "source": {"type": "base64", "media_type": "image/png",
                                      "data": base64.b64encode(p).decode()}}
        for p in images_png
    ] + [{"type": "text", "text": prompt}]
    body = json.dumps({
        "model": VISION_MODEL, "max_tokens": 2048,
        "messages": [{"role": "user", "content": content}],
    }).encode()
    req = urllib.request.Request(
        f"{VISION_BASE_URL}/v1/messages", data=body,
        headers={"x-api-key": VISION_API_KEY, "anthropic-version": "2023-06-01",
                 "Content-Type": "application/json"},
        method="POST",
    )
    t0 = time.time()
    try:
        resp = json.loads(urllib.request.urlopen(req, timeout=30).read())
        # 推理模型 content 里第一块常是 thinking，要找 type=="text" 的那块
        text = next((b["text"] for b in resp["content"] if b.get("type") == "text"), "")
        m = re.search(r"\{.*\}", text, re.S)
        verdict = json.loads(m.group(0)) if m else None
        elapsed = round(time.time() - t0, 1)
        log(f"[vision_llm] {elapsed}s → {verdict}")
        return verdict
    except Exception as e:
        elapsed = round(time.time() - t0, 1)
        log(f"[vision_llm] {elapsed}s 调用/解析失败: {e}")
        return None


def log(msg: str) -> None:
    print(f"[wrap {time.strftime('%H:%M:%S')}] {msg}", flush=True)


# ─── 历史持久化 ────────────────────────────────────────────────────────────────
def append_history(record: dict) -> None:
    try:
        with _history_lock, HISTORY_PATH.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
    except Exception as e:
        log(f"append_history: {e}")


def load_history() -> list[dict]:
    if not HISTORY_PATH.exists():
        return []
    rows: list[dict] = []
    with _history_lock, HISTORY_PATH.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return rows


# ─── ComfyUI 交互 ──────────────────────────────────────────────────────────────
def submit_to_comfy(wf_dict: dict) -> str:
    """提交 workflow 到 ComfyUI，立即返回 comfy_prompt_id（不等待执行完成）。"""
    req = urllib.request.Request(
        f"{COMFY_BASE}/prompt",
        data=json.dumps({"prompt": wf_dict}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        resp = json.loads(urllib.request.urlopen(req, timeout=30).read())
        return resp["prompt_id"]
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        raise RuntimeError(f"ComfyUI 提交失败 HTTP {e.code}: {body[:500]}")


def poll_comfy_history(comfy_pid: str) -> dict | None:
    """单次轮询 ComfyUI /history/{comfy_pid}，未完成返回 None，完成返回 entry。"""
    try:
        hist = json.loads(urllib.request.urlopen(
            f"{COMFY_BASE}/history/{comfy_pid}", timeout=15).read())
    except Exception:
        return None
    entry = hist.get(comfy_pid)
    if not entry:
        return None
    st = entry.get("status", {})
    if st.get("status_str") == "error":
        raise RuntimeError(f"ComfyUI 执行失败: {json.dumps(st)[:300]}")
    if st.get("status_str") == "success" or st.get("completed"):
        return entry
    return None


def video_path_from_outputs(outputs: dict, node_id: str = "75") -> str:
    out    = outputs.get(node_id, {})
    # "gifs" 是 VHS_VideoCombine 节点的输出键（去字幕工作流用的是它，i2v 用的
    # SaveVideo 节点是 "videos"/"images"）。
    videos = out.get("gifs") or out.get("videos") or out.get("images") or []
    if not videos:
        raise RuntimeError(f"节点 {node_id} 无视频输出: {out}")
    v   = videos[0]
    sub = v.get("subfolder") or ""
    return str(COMFY_OUTPUT / sub / v["filename"]) if sub else str(COMFY_OUTPUT / v["filename"])


def video_rel(abs_path: str) -> tuple[str, str]:
    rel = Path(abs_path).relative_to(COMFY_OUTPUT)
    subfolder = str(rel.parent) if str(rel.parent) != "." else ""
    return rel.name, subfolder


# ─── i2v 提交 ─────────────────────────────────────────────────────────────────
def build_and_submit_i2v(cfg: dict) -> str:
    """构造 PRESUB workflow，注入参数，提交到 ComfyUI，返回 comfy_pid。"""
    wf = json.loads(Path(WF_I2V).read_text(encoding="utf-8"))
    # 把图片复制到 ComfyUI input 目录，用标准 LoadImage 节点（无需 easy loadImageBase64）
    img_name = f"{cfg['output_name']}.png"
    img_dest = COMFY_INPUT / img_name
    shutil.copy(cfg["image"], img_dest)
    cfg["comfy_input_image"] = str(img_dest)
    wf["324"] = {
        "class_type": "LoadImage",
        "inputs": {"image": img_name, "upload": "image"},
    }
    W, H    = (720, 1280) if cfg["aspect"] == "9:16" else (1280, 720)
    frames  = max(1, round((cfg["duration"] * 25 - 1) / LTX_FRAME_STEP)) * LTX_FRAME_STEP + 1
    wf["320:319"]["inputs"]["value"]         = cfg["prompt"]
    wf["320:312"]["inputs"]["value"]         = W
    wf["320:299"]["inputs"]["value"]         = H
    wf["320:295"]["inputs"]["length"]        = frames
    wf["320:305"]["inputs"]["frames_number"] = frames
    # 种子由服务器随机生成，不用客户端传来的固定值——render.ts 每次提交（含 gate/OOM
    # 触发的重试）都用同一份 workflow 模板，种子若不变，参考图+prompt+种子完全相同，
    # LTX 扩散大概率复现一模一样的缺陷（多余人物/编造正脸等），重试等于白跑。
    cfg["base_seed"]   = random.randint(1, 2**48)
    cfg["refine_seed"] = random.randint(1, 2**48)
    wf["320:276"]["inputs"]["noise_seed"]    = cfg["base_seed"]
    wf["320:277"]["inputs"]["noise_seed"]    = cfg["refine_seed"]
    wf["75"]["inputs"]["filename_prefix"]    = f"pipeline/{cfg['output_name']}_i2v"
    # 注入 job_key 到 PersonFaceGate 节点（Gate1/2）
    if "gate12" in wf:
        wf["gate12"]["inputs"]["job_key"] = cfg["job_key"]
        wf["gate12"]["inputs"]["enabled"] = True
    log(f"  i2v {W}x{H} {frames}f dur={cfg['duration']}s seeds=({cfg['base_seed']},{cfg['refine_seed']})")
    prompt_preview = cfg['prompt'][:80].replace('\n', ' ')
    log(f"  prompt: {prompt_preview}...")
    return submit_to_comfy(wf)


# ─── 任务完成标记 ──────────────────────────────────────────────────────────────
def _mark_success(prompt_id: str, abs_path: str, had_subtitle: bool,
                  timings: dict, cfg: dict) -> None:
    filename, subfolder = video_rel(abs_path)
    total_s = round(sum(timings.values()), 1)
    with _jobs_lock:
        _jobs[prompt_id].update(
            status="success", filename=filename, subfolder=subfolder,
            had_subtitle=had_subtitle, timings=timings,
        )
    log(f"job {prompt_id[:8]} OK total={total_s}s sub={had_subtitle}: {filename}")
    append_history({
        "prompt_id":    prompt_id,
        "started_at":   _jobs[prompt_id].get("started_at", 0),
        "status":       "success",
        "finished_at":  time.time(),
        "had_subtitle": had_subtitle,
        "timings":      timings,
        "total_s":      total_s,
        "filename":     filename,
        "duration_target": cfg.get("duration"),
        "aspect":       cfg.get("aspect"),
    })


def _mark_error(prompt_id: str, err: str, cfg: dict) -> None:
    with _jobs_lock:
        _jobs[prompt_id].update(status="error", error=err)
    log(f"job {prompt_id[:8]} FAIL: {err[:200]}")
    append_history({
        "prompt_id":   prompt_id,
        "started_at":  _jobs[prompt_id].get("started_at", 0),
        "status":      "error",
        "finished_at": time.time(),
        "error":       err,
        "duration_target": cfg.get("duration"),
        "aspect":      cfg.get("aspect"),
    })


def _cleanup_image(cfg: dict) -> None:
    for key in ("image", "comfy_input_image"):
        try:
            Path(cfg[key]).unlink()
        except Exception:
            pass


# ─── ComfyUI 就绪等待 ──────────────────────────────────────────────────────────
def _wait_for_comfy(max_wait: int = 600, poll: int = 5) -> None:
    deadline = time.time() + max_wait
    warned   = False
    while time.time() < deadline:
        try:
            urllib.request.urlopen(f"{COMFY_BASE}/system_stats", timeout=4).read()
            if warned:
                log("ComfyUI 已就绪")
            return
        except Exception:
            if not warned:
                log(f"等待 ComfyUI 就绪（最多 {max_wait}s）...")
                warned = True
            time.sleep(poll)
    log("警告：ComfyUI 超时未就绪")


def _ensure_comfy_ready() -> None:
    global _comfy_ready_flag
    if _comfy_ready_flag:
        return
    with _comfy_ready_lock:
        if _comfy_ready_flag:
            return
        _wait_for_comfy()
        _comfy_ready_flag = True


# ─── i2v 阶段（调度循环消费 i2v_pending）───────────────────────────────────────
def _submit_and_wait_i2v(prompt_id: str) -> None:
    """提交单个 i2v 到 ComfyUI，同步轮询直到跑完/报错才返回（阶段内串行，见 STTN_SCHEDULER_REWRITE_PLAN.md）。"""
    with _jobs_lock:
        job = _jobs.get(prompt_id)
    if job is None:                      # /clear 之后 job 已被删掉
        return
    cfg = job["_cfg"]
    with _jobs_lock:
        _jobs[prompt_id]["status"] = "running"
    try:
        comfy_pid = build_and_submit_i2v(cfg)   # 含随机种子、job_key 注入，跟之前完全一样
        log(f"job {prompt_id[:8]} → ComfyUI {comfy_pid[:8]}")
        with _jobs_lock:
            _jobs[prompt_id]["comfy_pid"] = comfy_pid

        entry = None
        while entry is None:
            time.sleep(5)
            entry = poll_comfy_history(comfy_pid)   # ComfyUI 报错（含 Gate1/2 raise）这里会抛异常

        with _jobs_lock:
            t_i2v = round(time.time() - _jobs[prompt_id].get("started_at", time.time()), 1)
        abs_path = video_path_from_outputs(entry["outputs"])
        with _jobs_lock:
            _jobs[prompt_id]["video_path"] = abs_path
            _jobs[prompt_id]["status"]     = "queued_sttn"
            _jobs[prompt_id]["t_i2v"]      = t_i2v
        sttn_pending.put(prompt_id)
        log(f"job {prompt_id[:8]} ComfyUI done → 去字幕 gate")
    except Exception as e:
        _mark_error(prompt_id, str(e), cfg)
        _cleanup_image(cfg)


def _run_i2v_phase() -> None:
    """耗尽 i2v_pending：一个提交、等它跑完、再提交下一个，直到队列空且没有 job 卡在 queued/running。"""
    while True:
        try:
            prompt_id = i2v_pending.get_nowait()
        except queue.Empty:
            with _jobs_lock:
                active = [p for p, j in _jobs.items() if j.get("status") in ("queued", "running")]
            if not active:
                return
            time.sleep(2)
            continue
        _submit_and_wait_i2v(prompt_id)


# ─── 抽帧工具（去字幕前置探测 + Gate3 残留检测共用）────────────────────────────
VSR_FFPROBE = "/usr/local/ffmpeg/bin/ffprobe"


def _get_video_fps(video_path: str) -> float:
    r = subprocess.run(
        [VSR_FFPROBE, "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=r_frame_rate", "-of", "csv=p=0", video_path],
        capture_output=True, text=True, check=True,
    )
    num, den = r.stdout.strip().split("/")
    return int(num) / int(den)


def run_ltx_subtitle_removal(video_path: str, output_name: str) -> tuple[str, bool]:
    """
    用 LTX2.3 IC-LoRA 去水印/去字幕 ComfyUI 工作流对 video_path 做生成式修复，
    取代原先的外部 video-subtitle-remover（STTN+LaMa 子进程）。

    与 i2v 共用同一个 ComfyUI 进程、同一份底模+蒸馏 LoRA（仅去水印/去字幕两个
    IC-LoRA 不同），ComfyUI 自己的模型缓存能免掉大部分重新加载，因此不再需要
    像旧流程那样在阶段之间调 /free 腾显存。

    走到这里说明 check_subtitle_presence 前置探测已经判定有字幕，一定会做一次
    真实生成，第二个返回值恒为 True（保留 run_sttn 原来 (path, had_sub) 的
    返回约定，方便 _run_sttn_and_gate3 无缝调用）。
    返回输出视频绝对路径（在 COMFY_OUTPUT/pipeline/ 下）。
    """
    wf = json.loads(Path(WF_SUBTITLE_REMOVE).read_text(encoding="utf-8"))
    video_name = f"{output_name}_desub_in.mp4"
    dest = COMFY_INPUT / video_name
    shutil.copy(video_path, dest)
    wf["5099"]["inputs"]["video"]             = video_name
    wf["5069"]["inputs"]["filename_prefix"]   = f"pipeline/{output_name}_desub"

    try:
        comfy_pid = submit_to_comfy(wf)
        log(f"  去字幕(LTX2.3) → ComfyUI {comfy_pid[:8]}")

        entry = None
        while entry is None:
            time.sleep(5)
            entry = poll_comfy_history(comfy_pid)   # ComfyUI 报错这里会抛异常

        abs_path = video_path_from_outputs(entry["outputs"], node_id="5069")
        return abs_path, True
    finally:
        try:
            dest.unlink()
        except Exception:
            pass


def _extract_middle_frames(video_path: str, n: int = 3) -> list[bytes]:
    """从视频中间部分（排除首尾帧）均匀抽 n 帧，返回 PNG bytes 列表。"""
    dur = float(subprocess.run(
        [VSR_FFPROBE, "-v", "error", "-show_entries",
         "format=duration", "-of", "csv=p=0", video_path],
        capture_output=True, text=True, check=True,
    ).stdout.strip())
    fps = _get_video_fps(video_path)
    frame_dur = 1.0 / fps
    lo, hi = frame_dur, max(frame_dur, dur - frame_dur)  # 排除首尾各一帧
    out: list[bytes] = []
    with tempfile.TemporaryDirectory(prefix="gate3_") as tmp:
        for i in range(n):
            t = lo + (hi - lo) * (i + 1) / (n + 1)
            png_path = os.path.join(tmp, f"{i}.png")
            subprocess.run([
                VSR_FFMPEG, "-y", "-loglevel", "error",
                "-ss", f"{t:.3f}", "-i", video_path, "-frames:v", "1", png_path,
            ], check=True)
            with open(png_path, "rb") as f:
                out.append(f.read())
    return out


def _vlm_subtitle_probe(video_path: str, prompt: str, key: str) -> tuple[bool | None, str]:
    """抽视频中间 3 帧（排除首尾）喂 VLM，返回 (verdict[key]，reason)；
    抽帧或 LLM 调用失败时第一项返回 None，由调用方决定 fail-open 的方向。"""
    try:
        frames_png = _extract_middle_frames(video_path, n=3)
    except Exception as e:
        return None, f"抽帧失败: {e}"
    verdict = call_vision_llm(frames_png, prompt)
    if verdict is None:
        return None, "LLM 调用失败"
    return bool(verdict.get(key, False)), verdict.get("reason", "")


def check_subtitle_presence(video_path: str) -> tuple[bool, str]:
    """去字幕前置 Gate：判断 i2v 输出视频里是不是真的有字幕/水印需要处理。
    判不出来时保守当作"有"，交给去字幕工作流兜底处理（漏判比误判代价更高）。"""
    has_sub, reason = _vlm_subtitle_probe(video_path, SUBTITLE_PRESENCE_PROMPT, "has_subtitle")
    return (True if has_sub is None else has_sub), reason


# ─── STTN 阶段（调度循环消费 sttn_pending）─────────────────────────────────────
def _run_sttn_and_gate3(prompt_id: str) -> None:
    with _jobs_lock:
        job = _jobs.get(prompt_id)
    if not job:
        return
    if job.get("status") == "error":
        return

    cfg         = job.get("_cfg", {})
    video_path  = job.get("video_path", "")
    output_name = job.get("output_name", "")
    t_i2v       = job.get("t_i2v", 0)

    with _jobs_lock:
        if prompt_id not in _jobs:              # /clear 后跳过
            return
        _jobs[prompt_id]["status"] = "sttn"
    log(f"job {prompt_id[:8]} [去字幕 gate] {video_path}")

    t = time.time()
    try:
        has_sub, pre_reason = check_subtitle_presence(video_path)
        log(f"job {prompt_id[:8]} 字幕预检 has_subtitle={has_sub} ({pre_reason})")
        if has_sub:
            sttn_out, had_sub = run_ltx_subtitle_removal(video_path, output_name)
        else:
            # 预检判定无字幕：LTX2.3 去字幕工作流本身没有廉价的内置探测，靠这个
            # 前置 Gate 短路掉，省下一整段生成式修复。
            sttn_out = str(COMFY_OUTPUT / "pipeline" / f"{output_name}_desub.mp4")
            Path(sttn_out).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy(video_path, sttn_out)
            had_sub = False
        _mark_success(prompt_id, sttn_out, had_sub,
                      {"i2v": t_i2v, "desub": round(time.time() - t, 1)},
                      cfg)
    except Exception as e:
        _mark_error(prompt_id, f"去字幕失败: {e}", cfg)
    finally:
        _cleanup_image(cfg)


def _run_sttn_phase() -> None:
    """耗尽 sttn_pending。STTN_CONCURRENCY 个 worker 一起抢队列，默认 1 等于串行。"""
    def worker() -> None:
        while True:
            try:
                prompt_id = sttn_pending.get_nowait()
            except queue.Empty:
                return
            _run_sttn_and_gate3(prompt_id)

    n = max(1, STTN_CONCURRENCY)
    threads = [threading.Thread(target=worker, daemon=True) for _ in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()


# ─── 调度循环：i2v 阶段和去字幕阶段互斥轮转，取代之前"猜时机"的等待逻辑 ────────
# v6 起去字幕也在 ComfyUI 进程内跑（LTX2.3 工作流），跟 i2v 共用同一份底模权重，
# 阶段之间不再需要主动腾显存——旧版这里调 _free_comfy_vram() 是为了给外部
# STTN(EasyOCR+LaMa) 子进程腾出显存，现在两阶段都在 ComfyUI 里，腾了反而会
# 逼 ComfyUI 把还能复用的权重卸载掉，白白增加下一轮的冷加载时间。
def _scheduler_loop() -> None:
    _ensure_comfy_ready()
    log("调度器启动（双队列互斥轮转：i2v_pending ⇄ sttn_pending）")
    while True:
        _run_i2v_phase()
        _run_sttn_phase()
        if i2v_pending.empty() and sttn_pending.empty():
            time.sleep(1)


# ─── 参数解析 ──────────────────────────────────────────────────────────────────
def extract_panel_params(wf: dict, prompt_id: str) -> dict:
    img_b64    = wf["324"]["inputs"]["base64_data"]
    prompt     = wf["320:319"]["inputs"]["value"]
    width      = int(wf["320:312"]["inputs"]["value"])
    height     = int(wf["320:299"]["inputs"]["value"])
    frames     = int(wf["320:295"]["inputs"]["length"])
    base_seed  = int(wf["320:276"]["inputs"]["noise_seed"])
    refine_seed= int(wf["320:277"]["inputs"]["noise_seed"])
    fps        = 25
    duration   = round(frames / fps, 3)
    aspect     = "9:16" if height >= width else "16:9"
    img_path   = IMAGE_TMP_DIR / f"{prompt_id}.png"
    img_path.write_bytes(base64.b64decode(img_b64))
    output_name = f"wrap_{prompt_id[:8]}"
    # job_key：同一条视频每次重试时参考图/prompt/时长/宽高比字节级不变，用哈希
    # 识别"这是第几次重试同一条视频"，驱动 Gate1/2/3 共享的重试上限，不用改 render.ts。
    job_key = hashlib.sha256(
        (img_b64 + "|" + prompt + "|" + str(duration) + "|" + aspect).encode()
    ).hexdigest()[:16]
    return {
        "image":        str(img_path),
        "prompt":       prompt,
        "duration":     duration,
        "aspect":       aspect,
        "base_seed":    base_seed,
        "refine_seed":  refine_seed,
        "output_name":  output_name,
        "job_key":      job_key,
    }


# ─── 统计 ──────────────────────────────────────────────────────────────────────
def _avg(xs: list) -> float:
    return sum(xs) / len(xs) if xs else 0.0


def _pct(xs: list, p: float) -> float:
    if not xs:
        return 0.0
    s = sorted(xs)
    k = max(0, min(len(s) - 1, int(round(p * (len(s) - 1)))))
    return s[k]


def compute_stats(rows: list[dict]) -> dict:
    success = [r for r in rows if r.get("status") == "success"]
    errors  = [r for r in rows if r.get("status") == "error"]
    sub_yes = [r for r in success if r.get("had_subtitle")]
    sub_no  = [r for r in success if r.get("had_subtitle") is False]
    i2v_t   = [r["timings"]["i2v"]  for r in success if (r.get("timings") or {}).get("i2v") is not None]
    sttn_t  = [r["timings"]["desub"] for r in sub_yes  if (r.get("timings") or {}).get("desub") is not None]
    tot_sub = [r["total_s"] for r in sub_yes if r.get("total_s") is not None]
    tot_no  = [r["total_s"] for r in sub_no  if r.get("total_s") is not None]
    tot_all = [r["total_s"] for r in success if r.get("total_s") is not None]
    return {
        "total":                 len(rows),
        "success":               len(success),
        "error":                 len(errors),
        "subtitle_count":        len(sub_yes),
        "no_subtitle_count":     len(sub_no),
        "subtitle_trigger_rate": len(sub_yes) / len(success) if success else 0.0,
        "avg_i2v_s":             round(_avg(i2v_t),   1),
        "avg_sttn_s":            round(_avg(sttn_t),  1),
        "avg_total_subtitle":    round(_avg(tot_sub), 1),
        "avg_total_no_subtitle": round(_avg(tot_no),  1),
        "p50_total":             round(_pct(tot_all, 0.5),  1),
        "p95_total":             round(_pct(tot_all, 0.95), 1),
    }


# ─── Dashboard ─────────────────────────────────────────────────────────────────
LOG_PATH = Path("/tmp/wrap.log")


def _read_log_tail(n: int = 100) -> str:
    try:
        text  = LOG_PATH.read_text(encoding="utf-8", errors="replace")
        lines = text.split("\n")
        return html.escape("\n".join(lines[-n:]))
    except Exception:
        return "(日志文件不存在)"


def _fmt_ts(ts) -> str:
    return time.strftime("%m-%d %H:%M:%S", time.localtime(ts)) if ts else "-"


def render_dashboard() -> str:
    rows   = load_history()
    s      = compute_stats(rows)
    recent = sorted(rows, key=lambda r: r.get("started_at", 0), reverse=True)[:30]

    running   = sum(1 for j in _jobs.values() if j.get("status") == "running")
    i2v_dep   = i2v_pending.qsize()
    sttn_dep  = sttn_pending.qsize()

    if running > 0 or i2v_dep > 0:
        phase_html = f'<span style="color:#d97706">● i2v 阶段（运行中 {running} / 排队 {i2v_dep}）</span>'
    elif sttn_dep > 0:
        phase_html = f'<span style="color:#7c3aed">● 去字幕阶段（排队 {sttn_dep}）</span>'
    else:
        phase_html = '<span style="color:#16a34a">● 空闲</span>'

    def stat(num, lbl):
        return f'<div class="stat"><div class="num">{num}</div><div class="lbl">{lbl}</div></div>'

    sub_pct  = s["subtitle_trigger_rate"] * 100
    bar_html = (
        f'<div class="bar-wrap"><div class="bar-fill" style="width:{sub_pct:.1f}%"></div></div>'
        f'<div class="bar-lbl">有字幕 {s["subtitle_count"]} / 无字幕 {s["no_subtitle_count"]}</div>'
    )

    body_rows = []
    for r in recent:
        sub = r.get("had_subtitle")
        if r.get("status") == "error":
            sub_cell = '<span class="err">×</span>'
        elif sub:
            sub_cell = '<span class="yes">有</span>'
        else:
            sub_cell = '<span class="no">无</span>'
        tm = r.get("timings") or {}
        sc = '✓' if r.get('status') == 'success' else '✗ ' + html.escape((r.get('error') or '')[:60])
        dj = html.escape(json.dumps(r, ensure_ascii=False, indent=2))
        body_rows.append(
            "<tr>"
            f"<td>{_fmt_ts(r.get('started_at', 0))}</td>"
            f"<td>{r.get('duration_target', '-')}s</td>"
            f"<td>{html.escape(r.get('aspect', '-'))}</td>"
            f"<td>{sub_cell}</td>"
            f"<td>{tm.get('i2v', '-')}</td>"
            f"<td>{tm.get('desub', '-') or '-'}</td>"
            f"<td>{r.get('total_s', '-') if r.get('status') == 'success' else '-'}</td>"
            f"<td>{sc}</td>"
            f'<td><button class="expbtn" onclick="toggleDetail(this)">▼</button></td>'
            "</tr>"
            f'<tr class="detail-row" style="display:none">'
            f'<td colspan="9"><pre class="detail-pre">{dj}</pre></td>'
            f'</tr>'
        )
    rows_html = "".join(body_rows) or (
        '<tr><td colspan="9" style="text-align:center;color:#999;padding:30px">暂无任务记录</td></tr>'
    )
    log_tail = _read_log_tail(100)

    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>Story Claw 视频生成统计</title>
  <meta http-equiv="refresh" content="10">
  <style>
    *{{box-sizing:border-box}}
    body{{font-family:-apple-system,"Segoe UI","PingFang SC",sans-serif;max-width:1100px;margin:20px auto;padding:0 20px;color:#222}}
    h1{{margin:0 0 8px}}
    .sub{{color:#888;margin-bottom:24px;font-size:14px}}
    .card{{background:#fafafa;border:1px solid #eee;padding:18px 22px;border-radius:10px;margin:14px 0}}
    .card h3{{margin:0 0 14px;font-size:16px;color:#444}}
    .stat{{display:inline-block;margin:6px 28px 6px 0;vertical-align:top}}
    .stat .num{{font-size:26px;font-weight:600;color:#1d4ed8;line-height:1.2}}
    .stat .lbl{{font-size:13px;color:#777}}
    .bar-wrap{{width:100%;background:#e5e7eb;height:22px;border-radius:4px;overflow:hidden;margin-top:4px}}
    .bar-fill{{background:linear-gradient(90deg,#f59e0b,#dc2626);height:100%;transition:width .4s}}
    .bar-lbl{{font-size:13px;color:#777;margin-top:4px}}
    table{{width:100%;border-collapse:collapse;font-size:13px}}
    th,td{{padding:7px 10px;text-align:left;border-bottom:1px solid #eee}}
    th{{background:#f3f4f6;font-weight:600;color:#555}}
    .yes{{color:#dc2626;font-weight:600}}.no{{color:#16a34a}}.err{{color:#999}}
    .expbtn{{cursor:pointer;background:none;border:none;font-size:13px;color:#888;padding:0 4px}}
    .detail-row td{{background:#f8f8f8!important;padding:0}}
    .detail-pre{{margin:0;padding:10px 16px;font-size:11px;white-space:pre-wrap;word-break:break-all;color:#333;max-height:300px;overflow-y:auto}}
    .logbox{{font-size:11px;max-height:320px;overflow-y:auto;background:#111;color:#9f9;padding:12px;border-radius:6px;margin:0;white-space:pre-wrap;word-break:break-all}}
    .foot{{text-align:center;color:#999;font-size:12px;margin:20px 0}}
    .foot a{{color:#1d4ed8;margin:0 6px}}
  </style>
  <script>
    function toggleDetail(btn){{
      const det=btn.closest('tr').nextElementSibling;
      if(det&&det.classList.contains('detail-row')){{
        const show=det.style.display==='none';
        det.style.display=show?'':'none';
        btn.textContent=show?'▲':'▼';
      }}
    }}
    window.addEventListener('load',function(){{
      const lb=document.querySelector('.logbox');
      if(lb)lb.scrollTop=lb.scrollHeight;
    }});
    function clearJobs(){{
      if(!confirm('清空所有任务？（ComfyUI 队列不受影响）'))return;
      fetch('/clear',{{method:'POST'}}).then(r=>r.json()).then(d=>{{
        alert('已清空 '+d.cleared_jobs+' 个任务，'+d.cleared_pending+' 个排队项（i2v+去字幕）');
        location.reload();
      }});
    }}
    function saveVisionModel(){{
      const v = document.getElementById('visionModelInput').value.trim();
      const msg = document.getElementById('visionModelMsg');
      if(!v) return;
      fetch('/vision_model', {{
        method: 'POST',
        headers: {{'Content-Type': 'application/json'}},
        body: JSON.stringify({{model: v}}),
      }}).then(r=>r.json()).then(d=>{{
        msg.style.color = d.ok ? '#16a34a' : '#dc2626';
        msg.textContent = d.ok ? ('已保存 → ' + d.model) : ('保存失败：' + (d.error || ''));
        setTimeout(()=>{{msg.textContent='';}}, 4000);
      }}).catch(e=>{{ msg.style.color = '#dc2626'; msg.textContent = '请求失败：' + e; }});
    }}
    function saveGateRetryLimit(){{
      const gate12 = parseInt(document.getElementById('gate12LimitInput').value, 10);
      const gate3  = parseInt(document.getElementById('gate3LimitInput').value, 10);
      const msg = document.getElementById('gateLimitMsg');
      if(!gate12 || !gate3 || gate12 < 1 || gate3 < 1) {{
        msg.style.color = '#dc2626'; msg.textContent = '阈值必须是 >=1 的整数';
        return;
      }}
      fetch('/gate_retry_limit', {{
        method: 'POST',
        headers: {{'Content-Type': 'application/json'}},
        body: JSON.stringify({{gate12: gate12, gate3: gate3}}),
      }}).then(r=>r.json()).then(d=>{{
        msg.style.color = d.ok ? '#16a34a' : '#dc2626';
        msg.textContent = d.ok ? ('已保存 → Gate1/2='+d.gate12+' Gate3='+d.gate3) : ('保存失败：' + (d.error || ''));
        setTimeout(()=>{{msg.textContent='';}}, 4000);
      }}).catch(e=>{{ msg.style.color = '#dc2626'; msg.textContent = '请求失败：' + e; }});
    }}
  </script>
</head>
<body>
  <h1>Story Claw 视频生成统计</h1>
  <div class="sub">pipeline_wrapper v6（双队列调度） · :8190 · 每 10s 刷新</div>
  <div class="card">
    <h3>调度器状态</h3>
    {phase_html} &nbsp;·&nbsp; i2v 排队：{i2v_dep} &nbsp;·&nbsp; 去字幕排队：{sttn_dep}
    &nbsp;&nbsp;
    <button onclick="clearJobs()" style="background:#dc2626;color:#fff;border:none;padding:6px 14px;border-radius:6px;cursor:pointer;font-size:13px;">清空任务</button>
  </div>
  <div class="card">
    <h3>Gate 视觉模型（Gate1/2/3 共用）</h3>
    <input type="text" id="visionModelInput" value="{html.escape(VISION_MODEL)}"
      placeholder="例如 stepfun/step-3.7-flash"
      style="width:320px;padding:6px 10px;border:1px solid #ddd;border-radius:6px;font-size:13px">
    <button onclick="saveVisionModel()" style="background:#1d4ed8;color:#fff;border:none;padding:6px 14px;border-radius:6px;cursor:pointer;font-size:13px;margin-left:8px">保存</button>
    <span id="visionModelMsg" style="margin-left:10px;font-size:12px"></span>
  </div>
  <div class="card">
    <h3>Gate 重试阈值（Gate1/2、Gate3 各自独立计数，互不影响）</h3>
    Gate1/2（人物一致性）：
    <input type="number" id="gate12LimitInput" value="{GATE12_RETRY_LIMIT}" min="1"
      style="width:70px;padding:6px 10px;border:1px solid #ddd;border-radius:6px;font-size:13px">
    &nbsp;&nbsp;Gate3（残留字幕）：
    <input type="number" id="gate3LimitInput" value="{GATE3_RETRY_LIMIT}" min="1"
      style="width:70px;padding:6px 10px;border:1px solid #ddd;border-radius:6px;font-size:13px">
    <button onclick="saveGateRetryLimit()" style="background:#1d4ed8;color:#fff;border:none;padding:6px 14px;border-radius:6px;cursor:pointer;font-size:13px;margin-left:8px">保存</button>
    <span id="gateLimitMsg" style="margin-left:10px;font-size:12px"></span>
  </div>
  <div class="card">
    <h3>总览</h3>
    {stat(str(s['total']), '总任务')}
    {stat(str(s['success']), '成功')}
    {stat(str(s['error']), '失败')}
    {stat(f"{sub_pct:.1f}%", '字幕触发率')}
  </div>
  <div class="card">
    <h3>字幕触发分布</h3>
    {bar_html}
  </div>
  <div class="card">
    <h3>平均耗时（秒）</h3>
    {stat(f"{s['avg_i2v_s']:.0f}", 'i2v PRESUB')}
    {stat(f"{s['avg_sttn_s']:.0f}", '去字幕（有字幕，LTX2.3）')}
    {stat(f"{s['avg_total_no_subtitle']:.0f}", '无字幕 panel 总耗时')}
    {stat(f"{s['avg_total_subtitle']:.0f}", '有字幕 panel 总耗时')}
    {stat(f"{s['p50_total']:.0f}", 'P50 总耗时')}
    {stat(f"{s['p95_total']:.0f}", 'P95 总耗时')}
  </div>
  <div class="card">
    <h3>最近 30 个任务</h3>
    <table>
      <thead><tr>
        <th>开始时间</th><th>目标</th><th>比例</th><th>字幕</th>
        <th>i2v(s)</th><th>去字幕(s)</th><th>总耗时</th><th>状态</th><th></th>
      </tr></thead>
      <tbody>{rows_html}</tbody>
    </table>
  </div>
  <div class="card">
    <h3>实时日志</h3>
    <pre class="logbox">{log_tail}</pre>
  </div>
  <div class="foot">
    <a href="/stats.json">stats.json</a> ·
    <a href="/history.jsonl">history.jsonl</a> ·
    <a href="/health">health</a>
  </div>
</body>
</html>"""


# ─── HTTP Handler ──────────────────────────────────────────────────────────────
class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        return

    def _json(self, code: int, obj) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _html(self, body_html: str) -> None:
        body = body_html.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:
        path   = self.path.rstrip("/")
        length = int(self.headers.get("Content-Length", "0"))
        body   = self.rfile.read(length) if length else b""

        # ── /gate_verdict —— PersonFaceGate 节点回调（Gate1/2）──────────────────
        if path == "/gate_verdict":
            try:
                data     = json.loads(body)
                job_key  = str(data["job_key"])
                gate     = str(data.get("gate", ""))
                passed   = bool(data["passed"])
                reason   = str(data.get("reason", ""))
            except Exception:
                return self._json(400, {"error": "bad json"})

            action = gate_decide(job_key, gate, passed)
            log(f"gate_verdict job_key={job_key[:8]} gate={gate} passed={passed} → {action} ({reason[:120]})")
            return self._json(200, {"action": action})

        # ── /prompt —— render.ts 提交视频生成任务 ──────────────────────────────
        if path == "/prompt":
            try:
                payload   = json.loads(body)
                wf        = payload["prompt"]
                prompt_id = str(uuid.uuid4())
                cfg       = extract_panel_params(wf, prompt_id)
            except Exception as e:
                return self._json(400, {"error": f"bad request: {e}"})

            video_path = str(
                COMFY_OUTPUT / "pipeline" / f"{cfg['output_name']}_i2v_00001_.mp4"
            )
            with _jobs_lock:
                _jobs[prompt_id] = {
                    "status":       "queued",
                    "started_at":   time.time(),
                    "output_name":  cfg["output_name"],
                    "video_path":   video_path,
                    "had_subtitle": False,
                    "_cfg":         cfg,
                }
            i2v_pending.put(prompt_id)   # 只登记+排队，真正提交给 ComfyUI 由调度循环决定时机
            log(f"job {prompt_id[:8]} queued")
            return self._json(200, {"prompt_id": prompt_id, "number": 0, "node_errors": {}})

        # ── /vision_model —— 更新 Gate1/2/3 共用的视觉模型 id ──────────────────
        if path == "/vision_model":
            try:
                data  = json.loads(body)
                model = str(data["model"]).strip()
                if not model:
                    raise ValueError("model 不能为空")
            except Exception as e:
                return self._json(400, {"error": f"bad request: {e}"})
            set_vision_model(model)
            log(f"/vision_model 更新为 {model}")
            return self._json(200, {"ok": True, "model": model})

        # ── /gate_retry_limit —— 更新 Gate1/2、Gate3 各自独立的重试阈值 ─────────
        if path == "/gate_retry_limit":
            try:
                data   = json.loads(body)
                gate12 = int(data["gate12"])
                gate3  = int(data["gate3"])
                if gate12 < 1 or gate3 < 1:
                    raise ValueError("阈值必须 >= 1")
            except Exception as e:
                return self._json(400, {"error": f"bad request: {e}"})
            set_gate_retry_limits(gate12, gate3)
            log(f"/gate_retry_limit 更新为 gate12={gate12} gate3={gate3}")
            return self._json(200, {"ok": True, "gate12": gate12, "gate3": gate3})

        # ── /clear —— 清空所有内存任务和两个队列 ──────────────────────────────
        if path == "/clear":
            with _jobs_lock:
                count = len(_jobs)
                _jobs.clear()
            drained = 0
            for q in (i2v_pending, sttn_pending):
                while not q.empty():
                    try:
                        q.get_nowait()
                        drained += 1
                    except Exception:
                        break
            log(f"/clear: 清空 {count} 个 job，{drained} 个排队项（i2v+去字幕）")
            return self._json(200, {"cleared_jobs": count, "cleared_pending": drained})

        return self._json(404, {"error": "not found"})

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)

        if parsed.path.startswith("/history/"):
            pid = parsed.path.split("/", 2)[2]
            with _jobs_lock:
                job = _jobs.get(pid)
            if not job:
                return self._json(200, {})
            st = job["status"]
            if st == "success":
                return self._json(200, {pid: {
                    "status":  {"status_str": "success", "completed": True},
                    "outputs": {"75": {"videos": [{
                        "filename":  job["filename"],
                        "subfolder": job["subfolder"],
                        "type":      "output",
                    }]}},
                }})
            if st == "error":
                return self._json(200, {pid: {
                    "status": {
                        "status_str": "error",
                        "completed":  False,
                        "messages":   [["error", {"message": job.get("error", "")}]],
                    },
                    "outputs": {},
                }})
            return self._json(200, {pid: {
                "status":  {"status_str": "running", "completed": False},
                "outputs": {},
            }})

        if parsed.path == "/view":
            url = f"{COMFY_BASE}/view?{parsed.query}"
            try:
                with urllib.request.urlopen(url, timeout=60) as resp:
                    body = resp.read()
                    self.send_response(resp.status)
                    for h in ("Content-Type", "Content-Length", "Content-Disposition"):
                        v = resp.headers.get(h)
                        if v:
                            self.send_header(h, v)
                    self.end_headers()
                    self.wfile.write(body)
                return
            except urllib.error.HTTPError as e:
                self.send_response(e.code); self.end_headers(); return
            except Exception as e:
                return self._json(502, {"error": f"upstream: {e}"})

        if parsed.path == "/vision_model":
            return self._json(200, {"model": VISION_MODEL})

        if parsed.path == "/health":
            running  = sum(1 for j in _jobs.values() if j.get("status") == "running")
            return self._json(200, {
                "status":      "ok",
                "jobs":        len(_jobs),
                "running":     running,
                "i2v_pending": i2v_pending.qsize(),
                "desub_queue": sttn_pending.qsize(),
            })

        if parsed.path in ("/", "/index.html", "/dashboard"):
            return self._html(render_dashboard())

        if parsed.path == "/stats.json":
            return self._json(200, compute_stats(load_history()))

        if parsed.path == "/history.jsonl":
            try:
                body = HISTORY_PATH.read_bytes() if HISTORY_PATH.exists() else b""
            except Exception as e:
                return self._json(500, {"error": str(e)})
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if parsed.path == "/logs":
            qs = urllib.parse.parse_qs(parsed.query)
            n  = int(qs.get("n", ["1000"])[0])
            try:
                text = LOG_PATH.read_text(encoding="utf-8", errors="replace")
                body = "\n".join(text.split("\n")[-n:]).encode("utf-8")
            except Exception:
                body = b"(no log)"
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        return self._json(404, {"error": "not found"})


# ─── 启动 ──────────────────────────────────────────────────────────────────────
def main() -> None:
    threading.Thread(target=_scheduler_loop, daemon=True).start()
    log(f"pipeline_wrapper v6（双队列调度） listening on 0.0.0.0:{PORT}")
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
