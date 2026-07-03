#!/usr/bin/env python3
"""
pipeline_wrapper.py — 调度型版本 v4 (STTN)

架构：
  i2v PRESUB 提交后立即返回；ComfyUI 自带队列并发执行。
  SubtitleDetector 节点命中时回调 POST /subtitle_record。
  STTN 单线程 runner 串行去字幕。
  无字幕 → i2v 完成即 success；有字幕 → STTN 全部完成后 success。
"""
from __future__ import annotations

import base64
import html
import json
import os
import queue
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
LTX_FRAME_STEP = 8

VSR_PYTHON  = "/root/miniconda3/bin/python"
HELPER      = "/root/video-subtitle-remover/clean_frames_cli.py"
VSR_FFMPEG  = "/root/video-subtitle-remover/backend/ffmpeg/linux_x64/ffmpeg"

for _bin in ("/root/miniconda3/bin", "/usr/local/ffmpeg/bin"):
    if _bin not in os.environ.get("PATH", ""):
        os.environ["PATH"] = f"{_bin}:{os.environ.get('PATH', '')}"

# ─── 状态 ──────────────────────────────────────────────────────────────────────
# status: "queued" | "running" | "queued_sttn" | "sttn" | "success" | "error"
_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()

_sttn_q: queue.Queue = queue.Queue()

_comfy_ready_flag = False
_comfy_ready_lock = threading.Lock()

_history_lock = threading.Lock()


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
    videos = out.get("videos") or out.get("images") or []
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
    wf["320:276"]["inputs"]["noise_seed"]    = int(cfg["base_seed"])
    wf["320:277"]["inputs"]["noise_seed"]    = int(cfg["refine_seed"])
    wf["75"]["inputs"]["filename_prefix"]    = f"pipeline/{cfg['output_name']}_i2v"
    # 注入 job_id 到 SubtitleDetector 节点
    if "sub_det" in wf:
        wf["sub_det"]["inputs"]["job_id"]  = cfg["output_name"]
        wf["sub_det"]["inputs"]["enabled"] = True
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


# ─── 轮询线程（每个 job 一个）─────────────────────────────────────────────────
def _poll_comfy(prompt_id: str, comfy_pid: str, cfg: dict) -> None:
    while True:
        time.sleep(5)
        try:
            entry = poll_comfy_history(comfy_pid)
        except RuntimeError as e:
            _mark_error(prompt_id, str(e), cfg)
            _cleanup_image(cfg)
            return
        if entry is None:
            continue

        # ComfyUI 执行完成
        with _jobs_lock:
            job          = _jobs[prompt_id]
            had_subtitle = job.get("had_subtitle", False)
            t_i2v        = round(time.time() - job.get("started_at", time.time()), 1)

        # ComfyUI 完成后统一走 STTN 检测（auto 模式：gate 无字幕则秒过，有字幕才 STTN）
        try:
            abs_path = video_path_from_outputs(entry["outputs"])
        except Exception as e:
            _mark_error(prompt_id, f"完成后处理失败: {e}", cfg)
            _cleanup_image(cfg)
            return
        with _jobs_lock:
            _jobs[prompt_id]["video_path"]  = abs_path
            _jobs[prompt_id]["status"]      = "queued_sttn"
            _jobs[prompt_id]["t_i2v"]       = t_i2v
        _sttn_q.put(prompt_id)
        log(f"job {prompt_id[:8]} ComfyUI done → STTN gate")
        return


def _start_job(prompt_id: str, cfg: dict) -> None:
    """提交 i2v 到 ComfyUI 并启动轮询线程。"""
    _ensure_comfy_ready()
    with _jobs_lock:
        _jobs[prompt_id]["status"] = "running"
    try:
        comfy_pid = build_and_submit_i2v(cfg)
        log(f"job {prompt_id[:8]} → ComfyUI {comfy_pid[:8]}")
        with _jobs_lock:
            _jobs[prompt_id]["comfy_pid"] = comfy_pid
        threading.Thread(
            target=_poll_comfy,
            args=(prompt_id, comfy_pid, cfg),
            daemon=True,
        ).start()
    except Exception as e:
        _mark_error(prompt_id, str(e), cfg)
        _cleanup_image(cfg)


# ─── STTN 工具函数 ─────────────────────────────────────────────────────────────
VSR_FFPROBE = "/usr/local/ffmpeg/bin/ffprobe"


def _get_video_fps(video_path: str) -> float:
    r = subprocess.run(
        [VSR_FFPROBE, "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=r_frame_rate", "-of", "csv=p=0", video_path],
        capture_output=True, text=True, check=True,
    )
    num, den = r.stdout.strip().split("/")
    return int(num) / int(den)


def _wait_for_file(path: str, max_wait: int = 300, poll: int = 3) -> bool:
    deadline = time.time() + max_wait
    while time.time() < deadline:
        if os.path.exists(path):
            sz = os.path.getsize(path)
            if sz > 0:
                time.sleep(1)
                if os.path.getsize(path) == sz:
                    return True
        time.sleep(poll)
    return False


def run_sttn(video_path: str, output_name: str) -> str:
    """
    对 video_path 跑 STTN 字幕去除。
    返回输出视频绝对路径（在 COMFY_OUTPUT/pipeline/ 下）。
    """
    in_dir  = Path(tempfile.mkdtemp(prefix="sttn_in_"))
    out_dir = Path(tempfile.mkdtemp(prefix="sttn_out_"))
    try:
        fps = _get_video_fps(video_path)
        log(f"  STTN decode {video_path} fps={fps:.3f}")
        subprocess.run([
            VSR_FFMPEG, "-y", "-loglevel", "error",
            "-i", video_path,
            str(in_dir / "%05d.png"),
        ], check=True)

        env = dict(os.environ)
        env["QT_QPA_PLATFORM"]                  = "offscreen"
        env["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"
        proc = subprocess.run(
            [VSR_PYTHON, HELPER,
             "--in-dir", str(in_dir),
             "--out-dir", str(out_dir),
             "--mode", "auto"],
            env=env, capture_output=True, text=True, timeout=3600,
        )
        result = next(
            (l.strip() for l in reversed((proc.stdout or "").splitlines()) if l.startswith("RESULT=")),
            "RESULT=ERROR",
        )
        log(f"  STTN result={result}")
        if proc.returncode != 0 and proc.stderr:
            log("  STTN stderr: " + proc.stderr.strip().splitlines()[-1])

        sttn_out = COMFY_OUTPUT / "pipeline" / f"{output_name}_sttn.mp4"
        sttn_out.parent.mkdir(parents=True, exist_ok=True)

        if result == "RESULT=CLEANED":
            src_frames = str(out_dir / "%05d.png")
        elif result == "RESULT=CLEAN":
            shutil.copy(video_path, sttn_out)
            return str(sttn_out), False
        else:
            raise RuntimeError(f"STTN 失败: {result}")

        enc = subprocess.run([
            VSR_FFMPEG, "-y", "-loglevel", "warning",
            "-framerate", f"{fps:.6f}",
            "-i", src_frames,
            "-i", video_path,
            "-map", "0:v",
            "-map", "1:a?",
            "-c:v", "libx264", "-pix_fmt", "yuv420p",
            "-c:a", "copy",
            str(sttn_out),
        ], capture_output=True, text=True)
        if enc.returncode != 0:
            raise RuntimeError(f"ffmpeg 重编失败 rc={enc.returncode}: {enc.stderr.strip()[-300:]}")
        return str(sttn_out), True
    finally:
        shutil.rmtree(in_dir,  ignore_errors=True)
        shutil.rmtree(out_dir, ignore_errors=True)


# ─── STTN 串行 runner ──────────────────────────────────────────────────────────
def _sttn_runner() -> None:
    log("STTN runner 启动")
    while True:
        prompt_id = _sttn_q.get()
        with _jobs_lock:
            job = _jobs.get(prompt_id)
        if not job:
            log(f"STTN runner: prompt_id={prompt_id[:8]} 不存在，跳过")
            continue
        if job.get("status") == "error":
            log(f"STTN runner: job {prompt_id[:8]} 已错误，跳过")
            continue

        cfg         = job.get("_cfg", {})
        video_path  = job.get("video_path", "")
        output_name = job.get("output_name", "")
        t_i2v       = job.get("t_i2v", 0)

        # 等所有 i2v 任务跑完再占用 GPU 跑 LaMa
        # 同时检查 queued（新提交还没变 running）和 running，避免竞态
        while True:
            with _jobs_lock:
                if prompt_id not in _jobs:          # /clear 后 job 已被删除
                    break
                active_i2v = [p for p, j in _jobs.items()
                              if j.get("status") in ("queued", "running") and p != prompt_id]
            if not active_i2v:
                break
            log(f"job {prompt_id[:8]} 等待 {len(active_i2v)} 个 i2v 完成再运行 LaMa...")
            time.sleep(5)

        with _jobs_lock:
            if prompt_id not in _jobs:              # /clear 后跳过
                log(f"STTN runner: job {prompt_id[:8]} 已被 clear，跳过")
                continue
            _jobs[prompt_id]["status"] = "sttn"
        log(f"job {prompt_id[:8]} [STTN gate] {video_path}")

        t = time.time()
        try:
            sttn_out, had_sub = run_sttn(video_path, output_name)
            _mark_success(prompt_id, sttn_out, had_sub,
                          {"i2v": t_i2v, "sttn": round(time.time() - t, 1)},
                          cfg)
        except Exception as e:
            _mark_error(prompt_id, f"STTN 失败: {e}", cfg)
        finally:
            _cleanup_image(cfg)


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
    return {
        "image":        str(img_path),
        "prompt":       prompt,
        "duration":     duration,
        "aspect":       aspect,
        "base_seed":    base_seed,
        "refine_seed":  refine_seed,
        "output_name":  output_name,
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
    sttn_t  = [r["timings"]["sttn"] for r in sub_yes  if (r.get("timings") or {}).get("sttn") is not None]
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

    running  = sum(1 for j in _jobs.values() if j.get("status") == "running")
    sttn_dep = _sttn_q.qsize()

    if running > 0:
        phase_html = f'<span style="color:#d97706">● i2v 生成中 ×{running}</span>'
    elif sttn_dep > 0:
        phase_html = f'<span style="color:#7c3aed">● STTN 队列 ({sttn_dep})</span>'
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
            f"<td>{tm.get('sttn', '-') or '-'}</td>"
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
        alert('已清空 '+d.cleared_jobs+' 个任务，'+d.cleared_sttn_queue+' 个 STTN 队列项');
        location.reload();
      }});
    }}
  </script>
</head>
<body>
  <h1>Story Claw 视频生成统计</h1>
  <div class="sub">pipeline_wrapper v4 (STTN) · :8190 · 每 10s 刷新</div>
  <div class="card">
    <h3>调度器状态</h3>
    {phase_html} &nbsp;·&nbsp; i2v 并发：{running} &nbsp;·&nbsp; STTN 队列：{sttn_dep}
    &nbsp;&nbsp;
    <button onclick="clearJobs()" style="background:#dc2626;color:#fff;border:none;padding:6px 14px;border-radius:6px;cursor:pointer;font-size:13px;">清空任务</button>
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
    {stat(f"{s['avg_sttn_s']:.0f}", 'STTN（有字幕）')}
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
        <th>i2v(s)</th><th>STTN(s)</th><th>总耗时</th><th>状态</th><th></th>
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

        # ── /subtitle_record —— SubtitleDetector 节点回调 ──────────────────────
        if path == "/subtitle_record":
            try:
                data   = json.loads(body)
                job_id = data.get("job_id", "")
            except Exception:
                return self._json(400, {"error": "bad json"})

            found = None
            with _jobs_lock:
                for pid, job in _jobs.items():
                    if job.get("output_name") == job_id:
                        found = pid
                        if not job.get("had_subtitle"):
                            job["had_subtitle"] = True
                            job["status"]       = "queued_sttn"
                        break

            if found:
                _sttn_q.put(found)
                log(f"subtitle_record job_id={job_id} pid={found[:8]} → _sttn_q")
                return self._json(200, {"ok": True})
            else:
                log(f"subtitle_record job_id={job_id} 未找到对应 job")
                return self._json(404, {"error": "job not found"})

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
            threading.Thread(target=_start_job, args=(prompt_id, cfg), daemon=True).start()
            log(f"job {prompt_id[:8]} queued")
            return self._json(200, {"prompt_id": prompt_id, "number": 0, "node_errors": {}})

        # ── /clear —— 清空所有内存任务和 STTN 队列 ────────────────────────────
        if path == "/clear":
            with _jobs_lock:
                count = len(_jobs)
                _jobs.clear()
            drained = 0
            while not _sttn_q.empty():
                try:
                    _sttn_q.get_nowait()
                    drained += 1
                except Exception:
                    break
            log(f"/clear: 清空 {count} 个 job，{drained} 个 STTN 队列项")
            return self._json(200, {"cleared_jobs": count, "cleared_sttn_queue": drained})

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

        if parsed.path == "/health":
            running  = sum(1 for j in _jobs.values() if j.get("status") == "running")
            return self._json(200, {
                "status":     "ok",
                "jobs":       len(_jobs),
                "running":    running,
                "sttn_queue": _sttn_q.qsize(),
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
    threading.Thread(target=_sttn_runner, daemon=True).start()
    log(f"pipeline_wrapper v4 (STTN) listening on 0.0.0.0:{PORT}")
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
