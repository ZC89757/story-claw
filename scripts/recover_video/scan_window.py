#!/root/miniconda3/bin/python
# 在 GPU 服务器上运行：单段式版 —— 不依赖 job_history，
# 直接扫 output/pipeline 下某个时间窗内的 desub 成品 + i2v 首帧，
# 适合 job_history 已轮转或 prompt_id 列表不全的情况。
#
# 用法：/root/miniconda3/bin/python /root/ep_dl/scan_window.py \
#          "2026-07-19 01:05:00" "2026-07-19 04:00:00"
# 输出：/root/ep_dl/manifest.json + /root/ep_dl/frames_i2v/<p8>.png
import json, os, glob, subprocess, sys

START, END = sys.argv[1], sys.argv[2]
OUT_DIR = "/root/ComfyUI/output/pipeline"
FRAME_DIR = "/root/ep_dl/frames_i2v"
FFMPEG = "/usr/local/ffmpeg/bin/ffmpeg"
os.makedirs(FRAME_DIR, exist_ok=True)

# 找时间窗内的 desub 纯视频
desubs = []
for f in glob.glob(f"{OUT_DIR}/wrap_*_desub*.mp4"):
    b = os.path.basename(f)
    if "-audio" in b:
        continue
    m = os.path.getmtime(f)
    # m 转 START/END 比较（用 calendar）
    import calendar, time
    s = calendar.timegm(time.strptime(START, "%Y-%m-%d %H:%M:%S")) - time.timezone
    e = calendar.timegm(time.strptime(END, "%Y-%m-%d %H:%M:%S")) - time.timezone
    if s <= m <= e:
        desubs.append(f)

manifest = []
for desub in desubs:
    b = os.path.basename(desub)
    p8 = b.split("_")[1]  # wrap_<p8>_desub...
    i2vs = glob.glob(f"{OUT_DIR}/wrap_{p8}_i2v*.mp4")
    if not i2vs:
        continue
    i2v = sorted(i2vs)[0]
    frame = f"{FRAME_DIR}/{p8}.png"
    subprocess.run([FFMPEG, "-y", "-i", i2v, "-vframes", "1", "-q:v", "2", frame],
                   capture_output=True, timeout=60)
    if not os.path.exists(frame):
        continue
    manifest.append({"prompt_id": p8, "desub": b, "i2v": os.path.basename(i2v), "frame": frame})

json.dump(manifest, open("/root/ep_dl/manifest.json", "w"), ensure_ascii=False)
print("MANIFEST", len(manifest))
