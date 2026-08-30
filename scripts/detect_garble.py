"""扫描 render 目录下所有 g*_p00.mp4，抽中间帧算花屏分数 + 帧数，排序输出。
花屏特征：大量高饱和小色块(vivid 占比高) + 极高高频能量(Laplacian 方差)。
自然画面：低饱和(棕/暗肤色)、平滑渐变。
"""
import subprocess, os, sys, glob, json, tempfile
import numpy as np
from PIL import Image

RENDER = sys.argv[1] if len(sys.argv) > 1 else \
    "C:/Users/ZhangChi/Desktop/改写漫剧/story-claw/workspace/十日终焉/ep02/render_封闭密室"

def nb_frames(mp4):
    out = subprocess.run(["ffprobe","-v","error","-select_streams","v:0",
        "-show_entries","stream=nb_frames","-of","csv=p=0",mp4],
        capture_output=True,text=True).stdout.strip()
    try: return int(out)
    except: return -1

def mid_frame(mp4, idx, dst):
    subprocess.run(["ffmpeg","-y","-v","error","-i",mp4,
        "-vf",f"select=eq(n\\,{idx})","-vframes","1",dst],capture_output=True)

def metrics(png):
    im = Image.open(png).convert("RGB")
    a = np.asarray(im).astype(np.float32)/255.0
    r,g,b = a[...,0],a[...,1],a[...,2]
    mx = np.max(a,axis=2); mn = np.min(a,axis=2)
    sat = np.where(mx>0,(mx-mn)/(mx+1e-6),0.0)          # HSV 饱和度
    vivid = float(np.mean((sat>0.55)&(mx>0.35)))         # 高饱和且不太暗的像素占比
    gray = a.mean(axis=2)
    lap = (gray[2:,1:-1]+gray[:-2,1:-1]+gray[1:-1,2:]+gray[1:-1,:-2]-4*gray[1:-1,1:-1])
    lapvar = float(np.var(lap))                          # 高频能量
    return vivid, lapvar, float(sat.mean())

tmp = tempfile.mkdtemp()
rows=[]
for mp4 in sorted(glob.glob(os.path.join(RENDER,"g*_p00.mp4"))):
    name=os.path.basename(mp4)
    nf=nb_frames(mp4)
    if nf<=0: continue
    dst=os.path.join(tmp,name+".png")
    mid_frame(mp4,nf//2,dst)
    if not os.path.exists(dst): continue
    vivid,lapvar,msat=metrics(dst)
    rows.append((name,nf,vivid,lapvar,msat))

# 花屏判据：vivid 占比高 + lapvar 高。先按 vivid 排序看分布。
rows.sort(key=lambda x:-x[2])
print(f"{'panel':14}{'frames':>7}{'vivid%':>9}{'lapvar':>10}{'meanSat':>9}")
for name,nf,vivid,lapvar,msat in rows:
    flag=" <== 疑似花屏" if (vivid>0.12 and lapvar>0.02) else ""
    print(f"{name:14}{nf:>7}{vivid*100:>8.2f}{lapvar:>10.4f}{msat:>9.3f}{flag}")

# 帧数分布 vs 花屏
print("\n--- 帧数 → 花屏统计 ---")
from collections import defaultdict
byf=defaultdict(lambda:[0,0])
for name,nf,vivid,lapvar,msat in rows:
    garble = vivid>0.12 and lapvar>0.02
    byf[nf][0]+=1
    if garble: byf[nf][1]+=1
for nf in sorted(byf):
    tot,gb=byf[nf]
    print(f"  frames={nf:>3}: {gb}/{tot} 花屏")
