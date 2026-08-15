#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
推算某集「视频生成」总时长。

模型：ComfyUI 单 GPU 串行处理（并发只是排队），
      总生成时间 ≈ 总帧数 × (s/帧)。
      s/帧 由参考 render.log 的「墙钟 / 总帧数」实测标定（已含提交/下载等开销）。

用法：
  # 只看参考日志标定出的速率
  python estimate_render_time.py "workspace/人间西游 - 副本/ep01/render.log"

  # 推算：给视频条数 + 平均每条成片秒数
  python estimate_render_time.py <参考log> <视频条数> <平均每条秒数>

  # 推算：直接对一个已有 storyboards 目录数面板数（时长仍需给平均值）
  python estimate_render_time.py <参考log> --storyboards <ep目录的storyboards路径> <平均每条秒数>
"""
import io, re, sys, glob, os, json
from datetime import datetime

FPS = 25  # 与 video workflow 节点 320:300 一致

def parse_log(path):
    """从 render.log 提取 (墙钟秒, 总帧数, 视频数)。靠『提交…→帧』和『已保存』两类行配对。"""
    def ts(s): return datetime.strptime(s, "%H:%M:%S")
    submit, save, frames = {}, {}, {}
    for line in io.open(path, encoding="utf-8"):
        m = re.search(r"\[(\d\d:\d\d:\d\d)\].*\[视频\] 提交: (\S+?)\.mp4（目标 [\d.]+s → (\d+)帧", line)
        if m:
            submit[m.group(2)] = ts(m.group(1)); frames[m.group(2)] = int(m.group(3))
        m = re.search(r"\[(\d\d:\d\d:\d\d)\].*\[视频\] 已保存: (\S+?)\.mp4", line)
        if m:
            save[m.group(2)] = ts(m.group(1))
    ids = submit.keys() & save.keys()
    if not ids:
        raise SystemExit(f"日志里没找到可配对的视频行: {path}")
    sub = [submit[i] for i in ids]; sav = [save[i] for i in ids]
    wall = (max(sav) - min(sub)).total_seconds()
    if wall < 0:
        wall += 86400  # 跨午夜
    return wall, sum(frames[i] for i in ids), len(ids)

def calibrate(ref_log):
    wall, tot_frames, n = parse_log(ref_log)
    return {"s_per_frame": wall / tot_frames, "s_per_video": wall / n,
            "wall": wall, "frames": tot_frames, "n": n}

def fmt(secs):
    return f"{secs/60:.0f} min（{secs/3600:.1f} 小时）"

def count_panels(storyboards_dir):
    n = 0
    for fp in glob.glob(os.path.join(storyboards_dir, "storyboard_*.jsonl")):
        for line in io.open(fp, encoding="utf-8"):
            line = line.strip()
            if not line:
                continue
            n += len(json.loads(line).get("panels", []))
    return n

def estimate(n_videos, avg_seconds, model):
    total_frames = n_videos * avg_seconds * FPS
    secs = total_frames * model["s_per_frame"]
    return total_frames, secs

if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    ref = sys.argv[1]
    m = calibrate(ref)
    print(f"== 标定（参考: {ref}）==")
    print(f"  {m['n']} 条视频, {m['frames']} 帧, 墙钟 {m['wall']/60:.1f} min")
    print(f"  速率: {m['s_per_frame']:.3f} s/帧  |  {m['s_per_video']:.0f} s/条均摊  |  {m['s_per_frame']*FPS:.1f} s生成/每秒成片")

    args = sys.argv[2:]
    if args and args[0] == "--storyboards":
        n_videos = count_panels(args[1]); avg = float(args[2])
        print(f"\n  面板数（来自 {args[1]}）= {n_videos}")
    elif len(args) >= 2:
        n_videos = int(args[0]); avg = float(args[1])
    else:
        sys.exit(0)

    tf, secs = estimate(n_videos, avg, m)
    print(f"\n== 推算 ==")
    print(f"  {n_videos} 条 × 平均 {avg}s/条 = {tf:.0f} 帧")
    print(f"  预计视频生成: {fmt(secs)}")
