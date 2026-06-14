#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
帧目录 -> 帧目录 的字幕去除助手（运行在隔离的 vsr 环境）。

被 ComfyUI 自定义节点 SubtitleRemoverVSR 以子进程方式调用，复用 video-subtitle-remover
已验证的检测(PaddleOCR det) + STTN(sttn-det) 组件，在内存帧序列上操作，全程无损 PNG。

【最优参数全部写死在下方常量，外部不可传，避免传错】

三种模式（--mode，唯一可变的结构性参数）：
  gate ：只在 in-dir 现有帧（节点先写的少量抽检帧）上跑检测，输出 RESULT=HIT / RESULT=CLEAN，
         不做全量检测、不加载 STTN、不写盘。
  full ：跳过闸门，对 in-dir 全部帧做(每 SAMPLE_STEP 帧+插值)检测 + STTN 擦除，写 out-dir。
  auto ：（独立 CLI 用）先抽样闸门，干净则 CLEAN，命中再 full。

stdout 末行：RESULT=HIT / RESULT=CLEAN / RESULT=CLEANED / RESULT=ERROR
"""
import os
import sys
import glob
import argparse

# ============ 最优参数（写死，勿外传）============
BAND_TOP = 0.5        # 字幕搜索带上沿（占高比）：下半部
BAND_BOTTOM = 1.0     # 下沿
DILATION = 8          # mask 膨胀像素（STTN 下擦得净又不过糊的最优值）
GATE_FRAMES = 8       # 闸门抽检帧数（等距）
SAMPLE_STEP = 4       # 全量检测抽帧步长（每 4 帧检测 + 插值；目的是圈字幕区域，字幕段连续故足够）
# ================================================

VSR_ROOT = "/root/video-subtitle-remover"
sys.path.insert(0, VSR_ROOT)

import cv2
import numpy as np


def log(msg):
    print(f"[clean_frames_cli] {msg}", file=sys.stderr, flush=True)


def list_frames(in_dir):
    return sorted(glob.glob(os.path.join(in_dir, "*.png")))


def make_detector(sample_path, band):
    from backend.config import config
    from backend.tools.subtitle_detect import SubtitleDetect
    config.subtitleAreaDeviationPixel.value = DILATION
    sd = SubtitleDetect(sample_path, [band])
    sd.SAMPLE_STEP = 1
    return sd, config


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in-dir", required=True)
    ap.add_argument("--out-dir", default="")
    ap.add_argument("--mode", default="auto", choices=["auto", "gate", "full"])
    args = ap.parse_args()

    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")

    files = list_frames(args.in_dir)
    if not files:
        log("no input frames")
        print("RESULT=ERROR")
        return 2

    first = cv2.imread(files[0])
    if first is None:
        log("failed to read first frame")
        print("RESULT=ERROR")
        return 2
    H, W = first.shape[:2]
    ymin = max(0, int(round(BAND_TOP * H)))
    ymax = min(H, int(round(BAND_BOTTOM * H)))
    band = (ymin, ymax, 0, W)

    sd, config = make_detector(files[0], band)

    # ---------- gate：只对现有帧检测 ----------
    if args.mode == "gate":
        for f in files:
            fr = cv2.imread(f)
            if fr is not None and len(sd.detect_subtitle(fr)) > 0:
                log(f"gate HIT @ {os.path.basename(f)}")
                print("RESULT=HIT")
                return 0
        log(f"gate CLEAN ({len(files)} frames)")
        print("RESULT=CLEAN")
        return 0

    # ---------- auto：抽样闸门 ----------
    n = len(files)
    if args.mode == "auto":
        k = max(1, min(GATE_FRAMES, n))
        gate_idx = sorted(set(int(round(i * (n - 1) / max(1, k - 1))) for i in range(k))) if k > 1 else [0]
        if not any(
            (fr := cv2.imread(files[gi])) is not None and len(sd.detect_subtitle(fr)) > 0
            for gi in gate_idx
        ):
            log(f"auto gate CLEAN ({len(gate_idx)} sampled)")
            print("RESULT=CLEAN")
            return 0

    # ---------- full：每 SAMPLE_STEP 帧检测 + 插值 + STTN ----------
    if not args.out_dir:
        log("full 模式需要 --out-dir")
        print("RESULT=ERROR")
        return 2

    import torch
    from backend.tools.inpaint_tools import create_mask, expand_frame_ranges
    from backend.tools.model_config import ModelConfig
    from backend.inpaint.sttn_det_inpaint import STTNDetInpaint

    frames = [cv2.imread(f) for f in files]  # BGR
    sampled = {}
    for i, fr in enumerate(frames):
        if fr is None or (i % SAMPLE_STEP) != 0:
            continue
        boxes = sd.detect_subtitle(fr)
        if boxes:
            sampled[i + 1] = boxes  # 1-based
    if not sampled:
        log("full detect found nothing -> CLEAN")
        print("RESULT=CLEAN")
        return 0

    # 插值：相邻采样帧间隔 <= SAMPLE_STEP*2 时，中间帧继承前一帧的框
    filled = {}
    nos = sorted(sampled.keys())
    max_gap = SAMPLE_STEP * 2
    for f, nf in zip(nos, nos[1:]):
        filled[f] = sampled[f]
        if nf - f <= max_gap:
            for ff in range(f + 1, nf):
                filled[ff] = sampled[f]
    filled[nos[-1]] = sampled[nos[-1]]

    sub_list = sd.unify_regions(filled)
    sub_list = {k: v for k, v in sub_list.items() if len(v) > 0}
    log(f"detect step={SAMPLE_STEP}: sampled {len(sampled)} -> filled {len(sub_list)}")

    ranges = sd.find_continuous_ranges_with_same_mask(sub_list)
    ranges = expand_frame_ranges(
        ranges,
        config.subtitleTimelineBackwardFrameCount.value,
        config.subtitleTimelineForwardFrameCount.value,
    )
    ranges = sd.filter_and_merge_intervals(ranges, config.sttnReferenceLength.value)

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    mc = ModelConfig()
    model = STTNDetInpaint(device, mc.STTN_DET_MODEL_PATH)
    mask_size = (H, W)
    max_load = config.getSttnMaxLoadNum()
    yx_diff = config.subtitleYXAxisDifferencePixel.value

    out = list(frames)
    for (start, end) in ranges:
        start = max(1, int(start))
        end = min(n, int(end))
        if end < start:
            continue
        coords = []
        for fno in range(start, end + 1):
            if fno in sub_list:
                for area in sub_list[fno]:
                    xmin, xmax, _ymin, _ymax = area
                    if (_ymax - _ymin) - (xmax - xmin) > yx_diff:
                        continue
                    if area not in coords:
                        coords.append(area)
        if not coords:
            continue
        mask = create_mask(mask_size, coords)
        seg = frames[start - 1:end]
        done = []
        for b0 in range(0, len(seg), max_load):
            done.extend(model(seg[b0:b0 + max_load], mask))
        for j, ff in enumerate(done):
            out[start - 1 + j] = ff

    os.makedirs(args.out_dir, exist_ok=True)
    for i, ff in enumerate(out):
        cv2.imwrite(os.path.join(args.out_dir, os.path.basename(files[i])), ff)
    log(f"cleaned {len(ranges)} segment(s), wrote {len(out)} frames")
    print("RESULT=CLEANED")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        import traceback
        traceback.print_exc()
        print("RESULT=ERROR")
        sys.exit(1)
