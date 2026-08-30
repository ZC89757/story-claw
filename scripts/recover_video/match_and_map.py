#!/usr/bin/env python
# 在本地运行：用 i2v 首帧 vs 本地 panel.png 的三哈希(dHash+aHash+pHash)匈牙利全局最优
# 配对，把每个服务器成品视频精确映射回 (场景, gXX_pYY)，输出 mapping_final.json。
#
# 用法：python match_and_map.py <ep目录> <_ep_dl目录>
#   ep目录   = .../workspace/<小说>/epXX
#   _ep_dl目录 = 含 manifest.json 和 frames/ 子目录（已下载的 i2v 首帧）
# 例：python scripts/recover_video/match_and_map.py \
#       "workspace/work 东方快车谋杀案/ep02" _ep02_dl
import json, os, glob, re, sys
import numpy as np
from PIL import Image
from scipy.optimize import linear_sum_assignment

PANEL_RE = re.compile(r"^g\d+_p\d+$")  # 只匹配标准 panel，排除 *_lastframe 等
from numpy.fft import fft

EP = sys.argv[1] if len(sys.argv) > 1 else None
DL = sys.argv[2] if len(sys.argv) > 2 else None
assert EP and DL, "用法: python match_and_map.py <ep目录> <_ep_dl目录>"
FRAMES = os.path.join(DL, "frames")


def gray(im): return im.convert("L")

def dhash(im):
    p = np.array(gray(im).resize((9, 8), Image.LANCZOS), dtype=np.int16)
    return (p[:, :-1] > p[:, 1:]).flatten()

def ahash(im):
    p = np.array(gray(im).resize((8, 8), Image.LANCZOS))
    return (p > p.mean()).flatten()

def phash(im):
    p = np.array(gray(im).resize((32, 32), Image.LANCZOS), dtype=np.float64)
    n = 32
    M = np.zeros((n, n))
    for k in range(n):
        for j in range(n):
            M[k, j] = np.cos(np.pi * (2*j+1) * k / (2*n))
    M *= np.sqrt(2/n); M[0] /= np.sqrt(2)
    d = M @ p @ M.T
    low = d[:8, :8].flatten()
    return (low > np.median(low)).flatten()

def ham(a, b): return int(np.count_nonzero(a != b))

# 本地 panel
locals_ = []
for d in sorted(os.listdir(EP)):
    if not d.startswith("render_"):
        continue
    scene = d[len("render_"):]
    for f in glob.glob(os.path.join(EP, d, "g*_p*.png")):
        name = os.path.splitext(os.path.basename(f))[0]
        if not PANEL_RE.match(name):
            continue  # 跳过 *_lastframe 等非标准 panel 图
        im = Image.open(f)
        locals_.append({"scene": scene, "name": name,
                        "dh": dhash(im), "ah": ahash(im), "ph": phash(im)})

# 服务器 i2v 首帧
manifest = json.load(open(os.path.join(DL, "manifest.json"), encoding="utf-8"))
remotes = []
for m in manifest:
    p8 = m["prompt_id"][:8]
    fp = os.path.join(FRAMES, p8 + ".png")
    im = Image.open(fp)
    remotes.append({"prompt_id": m["prompt_id"], "desub": m["desub"], "p8": p8,
                    "dh": dhash(im), "ah": ahash(im), "ph": phash(im)})

L, R = len(locals_), len(remotes)
print("locals", L, "remotes", R)
assert L == R, f"数量不等 local={L} remote={R}，先核对 pids/manifest 是否覆盖本集所有 panel"

C = np.zeros((L, R), dtype=int)
for i in range(L):
    for j in range(R):
        C[i, j] = ham(locals_[i]["dh"], remotes[j]["dh"]) + \
                  ham(locals_[i]["ah"], remotes[j]["ah"]) + \
                  ham(locals_[i]["ph"], remotes[j]["ph"])

ri, rj = linear_sum_assignment(C)
pairs = []
for i, j in zip(ri, rj):
    cost = int(C[i, j])
    row2 = int(np.sort(C[i])[1]); col2 = int(np.sort(C[:, j])[1])
    pairs.append({
        "scene": locals_[i]["scene"], "panel": locals_[i]["name"],
        "prompt_id": remotes[j]["prompt_id"], "desub": remotes[j]["desub"],
        "cost": cost, "dh": ham(locals_[i]["dh"], remotes[j]["dh"]),
        "ah": ham(locals_[i]["ah"], remotes[j]["ah"]),
        "ph": ham(locals_[i]["ph"], remotes[j]["ph"]),
        "row2": row2, "col2": col2,
        "margin_row": row2 - cost, "margin_col": col2 - cost,
    })

pairs.sort(key=lambda x: x["cost"])
json.dump({"pairs": pairs}, open(os.path.join(DL, "mapping_final.json"), "w", encoding="utf-8"),
          ensure_ascii=False, indent=1)

costs = sorted(p["cost"] for p in pairs)
print("cost: min", costs[0], "median", costs[len(costs)//2],
      "p90", costs[int(len(costs)*0.9)], "max", costs[-1])
# 危险：cost>60 或 margin<5（可能与次优混淆，需人工抽查该条）
weak = [p for p in pairs if p["cost"] > 60 or p["margin_row"] < 5 or p["margin_col"] < 5]
print("weak", len(weak))
for p in weak:
    print(" ", p["scene"], p["panel"], p["prompt_id"][:8], "cost", p["cost"],
          "dh", p["dh"], "ah", p["ah"], "ph", p["ph"],
          "mrow", p["margin_row"], "mcol", p["margin_col"])
print("写入", os.path.join(DL, "mapping_final.json"))
