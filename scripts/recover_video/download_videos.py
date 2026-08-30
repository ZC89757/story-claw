#!/usr/bin/env python
# 在本地运行：按 mapping_final.json 从服务器 scp 下载 desub 成品到
# ep目录/render_<场景>/gXX_pYY.mp4。已存在且>1KB的跳过。
#
# 用法：python download_videos.py <ep目录> <_ep_dl目录>
import json, os, subprocess, sys

EP = sys.argv[1]; DL = sys.argv[2]
m = json.load(open(os.path.join(DL, "mapping_final.json"), encoding="utf-8"))
pairs = m["pairs"]

REMOTE = os.environ["STORY_CLAW_RECOVERY_REMOTE"]
PORT = int(os.environ.get("STORY_CLAW_RECOVERY_PORT", "22"))
PW = os.environ["STORY_CLAW_RECOVERY_PASSWORD"]
HK = os.environ["STORY_CLAW_RECOVERY_HOSTKEY"]
PSCP = os.environ.get("STORY_CLAW_PSCP", r"D:\PuTTY\pscp.exe")
REMOTE_BASE = os.environ.get("STORY_CLAW_RECOVERY_BASE", "/root/ComfyUI/output/pipeline")

ok, fail = 0, []
for p in pairs:
    local_dir = os.path.join(EP, "render_" + p["scene"])
    local_file = os.path.join(local_dir, p["panel"] + ".mp4")
    if os.path.exists(local_file) and os.path.getsize(local_file) > 1000:
        ok += 1; continue
    os.makedirs(local_dir, exist_ok=True)
    src = f"{REMOTE}:{REMOTE_BASE}/{p['desub']}"
    r = subprocess.run([PSCP, "-P", str(PORT), "-pw", PW, "-hostkey", HK,
                        "-batch", src, local_file], capture_output=True, text=True)
    if os.path.exists(local_file) and os.path.getsize(local_file) > 1000:
        ok += 1
        print(f"OK {p['scene']}/{p['panel']}.mp4 <- {p['desub']} ({os.path.getsize(local_file)}B)")
    else:
        fail.append((p["scene"], p["panel"], p["desub"], r.stderr[-300:]))
        print(f"FAIL {p['scene']}/{p['panel']} <- {p['desub']}: {r.stderr[-200:]}")

print(f"\nDONE ok={ok} fail={len(fail)}")
for f in fail: print(" FAIL", f)
