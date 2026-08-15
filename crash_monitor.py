#!/usr/bin/env python3
"""
ComfyUI 崩溃抓现场监控（持久化版）

- 输出目录 /root/crash_capture/（容器重启持久）
- comfy.log + wrap.log 用 tail -F 实时复制
- 每 3s 采样：时间戳 / ComfyUI PID / RSS / GPU mem+util / HTTP 状态 / wrapper 排队数
- 异常退出/被杀也由 supervisord 自动重启
"""
from __future__ import annotations

import json
import subprocess
import threading
import time
import urllib.request
from pathlib import Path

CAPTURE_DIR = Path("/root/crash_capture")
CAPTURE_DIR.mkdir(parents=True, exist_ok=True)
COMFY_DST   = CAPTURE_DIR / "comfy.log"
WRAP_DST    = CAPTURE_DIR / "wrap.log"
MONITOR_LOG = CAPTURE_DIR / "monitor.log"

COMFY_SRC = "/root/ComfyUI/comfy.log"
WRAP_SRC  = "/tmp/wrap.log"


def write_monitor(line: str) -> None:
    try:
        with MONITOR_LOG.open("a", encoding="utf-8") as f:
            f.write(line)
            if not line.endswith("\n"):
                f.write("\n")
    except Exception:
        pass


def tail_to_file(src: str, dst: Path) -> None:
    """tail -F src 到 dst（append）。子进程意外退出就重试。"""
    while True:
        try:
            with dst.open("ab", buffering=0) as f:
                proc = subprocess.Popen(
                    ["tail", "-F", "-n", "0", src],
                    stdout=f, stderr=subprocess.STDOUT,
                )
                proc.wait()
        except Exception as e:
            write_monitor(f"[tail-{Path(src).name}] 异常: {e}")
        time.sleep(2)


def _run(cmd: list[str], timeout: float = 3) -> str:
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.stdout.strip()
    except Exception:
        return ""


def get_comfy_pid() -> str:
    out = _run(["supervisorctl", "-c", "/usr/supervisor/supervisord.conf", "pid", "comfyui"], timeout=5)
    return out or "-"


def get_rss_kb(pid: str) -> str:
    if not pid or pid in ("-", "0"):
        return "-"
    out = _run(["ps", "-o", "rss=", "-p", pid], timeout=2)
    return out.strip() or "-"


def get_gpu() -> str:
    out = _run(["nvidia-smi", "--query-gpu=memory.used,utilization.gpu",
                "--format=csv,noheader,nounits"])
    return out.replace(" ", "") or "-"


def comfy_http() -> str:
    try:
        r = urllib.request.urlopen("http://127.0.0.1:8188/system_stats", timeout=2)
        return str(r.status)
    except Exception as e:
        return type(e).__name__


def wrap_jobs() -> str:
    try:
        r = urllib.request.urlopen("http://127.0.0.1:8190/health", timeout=2)
        return str(json.loads(r.read()).get("jobs", "?"))
    except Exception:
        return "x"


def sample_loop() -> None:
    write_monitor(f"=== monitor 启动 @ {time.strftime('%Y-%m-%d %H:%M:%S')} ===")
    last_pid = None
    while True:
        try:
            ts   = time.strftime("%H:%M:%S")
            pid  = get_comfy_pid()
            rss  = get_rss_kb(pid)
            gpu  = get_gpu()
            http = comfy_http()
            jobs = wrap_jobs()
            line = f"{ts} pid={pid} rss_kb={rss} gpu={gpu} http={http} wrap_jobs={jobs}"
            # PID 变化（ComfyUI 重启）单独标注
            if last_pid is not None and pid != last_pid:
                line += f"  ** PID CHANGED from {last_pid} **"
            last_pid = pid
            write_monitor(line)
        except Exception as e:
            write_monitor(f"sample 异常: {e}")
        time.sleep(3)


def main() -> None:
    threading.Thread(target=tail_to_file, args=(COMFY_SRC, COMFY_DST), daemon=True).start()
    threading.Thread(target=tail_to_file, args=(WRAP_SRC,  WRAP_DST),  daemon=True).start()
    sample_loop()


if __name__ == "__main__":
    main()
