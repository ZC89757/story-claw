#!/root/miniconda3/bin/python
# 在 GPU 服务器上运行：从 render.log 提取的 prompt_id 列表 + job_history，
# 为每个成功任务抽取 i2v 首帧（≈输入参考图），输出 manifest（含 desub 文件名供下载）。
#
# 用法（服务器侧）：
#   /root/miniconda3/bin/python /root/ep_dl/extract.py
# 依赖文件：
#   /root/ep_dl/pids.txt        —— 每行一个 prompt_id（本地从 render.log 提取后上传）
#   /root/job_history.jsonl     —— wrapper 自动写的任务记录
# 输出：
#   /root/ep_dl/manifest.json   —— [{prompt_id, desub, i2v, frame}]
#   /root/ep_dl/frames_i2v/<p8>.png
import json, os, glob, subprocess

PIDS = set(l.strip() for l in open("/root/ep_dl/pids.txt") if l.strip())
OUT_DIR = "/root/ComfyUI/output/pipeline"
FRAME_DIR = "/root/ep_dl/frames_i2v"
FFMPEG = "/usr/local/ffmpeg/bin/ffmpeg"
os.makedirs(FRAME_DIR, exist_ok=True)

hist = {}
for line in open("/root/job_history.jsonl"):
    try:
        d = json.loads(line)
    except Exception:
        continue
    hist[d["prompt_id"]] = d

manifest, missing = [], []
for pid in PIDS:
    rec = hist.get(pid)
    if not rec or rec.get("status") != "success":
        continue
    p8 = pid[:8]
    # 下载用：desub 纯视频（去掉 -audio 配音轨）
    desubs = [f for f in glob.glob(f"{OUT_DIR}/wrap_{p8}_desub*.mp4")
              if "-audio" not in os.path.basename(f)]
    if not desubs:
        missing.append(pid + "(no_desub)")
        continue
    desub = sorted([c for c in desubs if "_00001" in c] or desubs)[0]
    # 配对用：i2v 首帧（≈输入参考图本身，desub 工作流会重写首帧不可用）
    i2vs = glob.glob(f"{OUT_DIR}/wrap_{p8}_i2v*.mp4")
    if not i2vs:
        missing.append(pid + "(no_i2v)")
        continue
    i2v = sorted(i2vs)[0]
    frame = f"{FRAME_DIR}/{p8}.png"
    subprocess.run([FFMPEG, "-y", "-i", i2v, "-vframes", "1", "-q:v", "2", frame],
                   capture_output=True, timeout=60)
    if not os.path.exists(frame):
        missing.append(pid + "(frame_fail)")
        continue
    manifest.append({"prompt_id": pid, "desub": os.path.basename(desub),
                     "i2v": os.path.basename(i2v), "frame": frame})

json.dump(manifest, open("/root/ep_dl/manifest.json", "w"), ensure_ascii=False)
print("MANIFEST", len(manifest), "MISSING", len(missing), missing[:10])
