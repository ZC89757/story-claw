#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
帧目录 -> 帧目录 的字幕去除助手。

检测：EasyOCR detect()（只定位文字区域，不识别内容）
过滤标准：
  1. y_top > H * BAND_TOP        在底部 70% 以内
  2. width > height              横向矩形
  3. |center_x - W/2| < W*0.10  水平居中（10% 容差）
修复：LaMa 单帧神经网络修复（仅替换 mask 像素）

stdout 末行：RESULT=CLEAN / RESULT=CLEANED / RESULT=ERROR
"""
import os, sys, glob, argparse, types

VSR_ROOT = "/root/video-subtitle-remover"
sys.path.insert(0, VSR_ROOT)

# ---- headless shim ----
def _shim(name):
    m = types.ModuleType(name); sys.modules[name] = m; return m
for _n in ['PySide6','PySide6.QtCore','PySide6.QtWidgets',
           'PySide6.QtGui','PySide6.QtNetwork','PySide6.QtSvg']:
    _shim(_n)
_qfw = _shim('qfluentwidgets')
class _CI:
    def __init__(self, *a, **k): self.value = a[2] if len(a) > 2 else None
class _QConfig:
    def set(self, i, v): i.value = v
_qfw.ConfigItem = _qfw.RangeConfigItem = _qfw.OptionsConfigItem = _CI
_qfw.BoolValidator = _qfw.OptionsValidator = _qfw.RangeValidator = \
    _qfw.ConfigValidator = lambda *a,**k: None
_qfw.EnumSerializer = lambda *a,**k: None
_qfw.QConfig = _QConfig
_qfw.qconfig = type('_qc',(),{'load':staticmethod(lambda *a,**k:None)})()

import backend.config as _bc
_tr = os.path.join(os.path.dirname(os.path.abspath(_bc.__file__)), 'interface', 'ch.ini')
_bc.tr.read(_tr, encoding='utf-8')
# ---- end shim ----

import cv2
import numpy as np

BAND_TOP    = 0.30   # 检测区上沿（底部 70%）
CENTER_TOL  = 0.10   # 居中容差（帧宽的 10%）
DILATION    = 8      # mask 膨胀像素
GATE_FRAMES = 8      # gate 抽检帧数


def log(msg):
    print(f"[clean_frames_cli] {msg}", file=sys.stderr, flush=True)


def list_frames(d):
    return sorted(glob.glob(os.path.join(d, "*.png")))



def is_subtitle_box(box, frame_gray, H, W):
    """合并后判断是否满足字幕四条标准"""
    x1, x2, y1, y2 = int(box[0]), int(box[1]), int(box[2]), int(box[3])
    bw, bh = x2 - x1, y2 - y1
    if bw <= 0 or bh <= 0:
        return False
    # 1. 底部 70% 以内
    if y1 < H * BAND_TOP:
        return False
    # 2. 横向矩形
    if bw <= bh:
        return False
    # 3. 框内有白色文字（最大亮度 > 200，且高亮像素占比 > 5%）
    crop = frame_gray[max(0,y1):min(H,y2), max(0,x1):min(W,x2)]
    if crop.size == 0:
        return False
    if crop.max() <= 200:
        return False
    if (crop > 200).sum() / crop.size < 0.05:
        return False
    # 4. 水平居中（10% 容差）
    cx = (x1 + x2) / 2
    if abs(cx - W / 2) > W * CENTER_TOL:
        return False
    return True


def detect_subtitle_boxes(reader, frame_bgr, H, W):
    """EasyOCR 检测 → 合并相近框 → 过滤 → 返回字幕框列表"""
    ymin = int(H * BAND_TOP)
    crop = frame_bgr[ymin:]
    result = reader.detect(crop, slope_ths=0.1, add_margin=0.05)
    raw = result[0][0] if (result and result[0]) else []

    # 坐标转回全帧，直接应用字幕过滤标准
    all_boxes = [(b[0], b[1], b[2] + ymin, b[3] + ymin) for b in raw]
    gray = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY)
    return [b for b in all_boxes if is_subtitle_box(b, gray, H, W)]


def boxes_to_mask(boxes, H, W):
    mask = np.zeros((H, W), dtype=np.uint8)
    for (x1, x2, y1, y2) in boxes:
        mask[max(0, int(y1)):min(H, int(y2)),
             max(0, int(x1)):min(W, int(x2))] = 255
    if mask.max() > 0:
        kernel = np.ones((DILATION, DILATION), np.uint8)
        mask = cv2.dilate(mask, kernel, iterations=2)
    return mask


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in-dir",  required=True)
    ap.add_argument("--out-dir", default="")
    ap.add_argument("--mode",    default="auto", choices=["auto","gate","full"])
    args = ap.parse_args()

    files = list_frames(args.in_dir)
    if not files:
        log("no input frames"); print("RESULT=ERROR"); return 2

    frames = [cv2.imread(f) for f in files]
    if any(f is None for f in frames):
        log("failed to read frames"); print("RESULT=ERROR"); return 2

    n = len(frames)
    H, W = frames[0].shape[:2]

    import easyocr
    reader = easyocr.Reader(['ch_sim'], gpu=True, verbose=False)

    # ---------- gate ----------
    if args.mode in ("gate", "auto"):
        k = max(1, min(GATE_FRAMES, n))
        idx = (sorted(set(int(round(i*(n-1)/max(1,k-1))) for i in range(k)))
               if k > 1 else [0])
        hit = any(detect_subtitle_boxes(reader, frames[i], H, W) for i in idx)
        if not hit:
            log(f"gate CLEAN ({len(idx)} frames sampled)")
            print("RESULT=CLEAN"); return 0
        if args.mode == "gate":
            print("RESULT=HIT"); return 0

    # ---------- full ----------
    if not args.out_dir:
        log("full 需要 --out-dir"); print("RESULT=ERROR"); return 2

    import torch
    from backend.inpaint.lama_inpaint import LamaInpaint
    from backend.tools.model_config import ModelConfig

    mc = ModelConfig()
    model_path = os.path.join(mc.LAMA_MODEL_DIR, 'big-lama.pt')
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = LamaInpaint(device, model_path)
    log(f"LaMa on {device}，detecting & repairing {n} frames")

    # 第一遍：检测所有帧，收集字幕框和居中偏移
    all_boxes = []
    for f in frames:
        all_boxes.append(detect_subtitle_boxes(reader, f, H, W))

    # 有字幕的帧
    detected_idx = [i for i, b in enumerate(all_boxes) if b]
    if not detected_idx:
        log("no subtitle detected → CLEAN")
        print("RESULT=CLEAN"); return 0

    # 计算典型居中偏移（中位数）和最宽字幕框
    offsets, widest = [], None
    for boxes in all_boxes:
        for b in boxes:
            x1,x2 = int(b[0]),int(b[1])
            off = abs((x1+x2)/2 - W/2)
            offsets.append(off)
            if widest is None or (x2-x1) > (int(widest[1])-int(widest[0])):
                widest = b
    typical_off = float(np.median(offsets))
    log(f"detected {len(detected_idx)}/{n} frames, typical offset={typical_off:.1f}px, widest x={int(widest[0])}-{int(widest[1])}")

    # 第二遍：逐框处理——偏移异常的框单独扩宽 x，y 不变；正常框保持原样
    ANOMALY_MULT = 2.0
    wx1, wx2 = int(widest[0]), int(widest[1])
    frame_masks = []
    for i, boxes in enumerate(all_boxes):
        if not boxes:
            frame_masks.append(None); continue
        adjusted = []
        for b in boxes:
            x1, x2, y1, y2 = int(b[0]), int(b[1]), int(b[2]), int(b[3])
            off = abs((x1+x2)/2 - W/2)
            if off > typical_off * ANOMALY_MULT + 20:
                # 只扩宽 x 到最宽范围，y 位置不变
                adjusted.append((wx1, wx2, y1, y2))
                log(f"frame {i:03d}: box offset={off:.0f}px→expanded x to {wx1}-{wx2}")
            else:
                adjusted.append(b)
        frame_masks.append(boxes_to_mask(adjusted, H, W))

    need_idx = [i for i, m in enumerate(frame_masks) if m is not None]
    log(f"running LaMa on {len(need_idx)} frames")

    # 批量 LaMa
    imgs   = [frames[i] for i in need_idx]
    masks  = [frame_masks[i] for i in need_idx]
    lama_out = model._inpaint_batch(imgs, masks)

    # 合并：只替换 mask 像素
    results = list(frames)
    for i, (orig_i, lama, mask) in enumerate(zip(need_idx, lama_out, masks)):
        result = frames[orig_i].copy()
        result[mask > 0] = lama[mask > 0]
        results[orig_i] = result

    os.makedirs(args.out_dir, exist_ok=True)
    for i, result in enumerate(results):
        cv2.imwrite(os.path.join(args.out_dir, os.path.basename(files[i])), result)

    log(f"done, wrote {n} frames")
    print("RESULT=CLEANED"); return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        import traceback; traceback.print_exc()
        print("RESULT=ERROR"); sys.exit(1)
