# -*- coding: utf-8 -*-
"""
ComfyUI 自定义节点：SubtitleRemoverVSR

IMAGE 进 / IMAGE 出。插在帧解码(VAEDecodeTiled)与合成(CreateVideo)之间，对 base 帧做
"轻量闸门检测 -> 命中才 STTN 清理 -> 干净帧透传下游"。

【最优参数全部写死，节点只暴露 images + enabled，避免传错】
两阶段：先写 GATE_FRAMES 张等距抽样帧跑 gate；CLEAN/禁用/出错 -> 透传；
HIT -> 补写全部帧跑 full（每 2 帧检测+插值+STTN），读回干净帧。

绝不污染 ComfyUI base 环境：本文件只用 base 已有的 numpy/PIL/torch + subprocess，
真正的检测(PaddleOCR)+STTN 全在隔离 vsr 环境子进程运行。

部署：/root/ComfyUI/custom_nodes/ComfyUI-SubtitleRemover/__init__.py，重启 ComfyUI 注册。
"""
import os
import glob
import shutil
import tempfile
import subprocess

import numpy as np
import torch
from PIL import Image

VSR_PYTHON = "/root/miniconda3/envs/vsr/bin/python"
HELPER = "/root/video-subtitle-remover/clean_frames_cli.py"
GATE_FRAMES = 8  # 闸门等距抽样帧数（与助手内常量一致）


def _gate_indices(n, k):
    k = max(1, min(k, n))
    if k == 1:
        return [0]
    return sorted(set(int(round(i * (n - 1) / (k - 1))) for i in range(k)))


class SubtitleRemoverVSR:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"images": ("IMAGE",), "enabled": ("BOOLEAN", {"default": True})}}

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "process"
    CATEGORY = "video/postprocess"

    def _run_helper(self, in_dir, mode, out_dir=""):
        env = dict(os.environ)
        env["QT_QPA_PLATFORM"] = "offscreen"
        env["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"
        cmd = [VSR_PYTHON, HELPER, "--in-dir", in_dir, "--mode", mode]
        if out_dir:
            cmd += ["--out-dir", out_dir]
        proc = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=3600)
        result = ""
        for line in reversed((proc.stdout or "").strip().splitlines()):
            if line.startswith("RESULT="):
                result = line.strip()
                break
        print(f"[SubtitleRemoverVSR] mode={mode} -> {result or '?'} (rc={proc.returncode})")
        if proc.returncode != 0 and proc.stderr:
            print("[SubtitleRemoverVSR] stderr tail:\n" + "\n".join(proc.stderr.strip().splitlines()[-8:]))
        return result, proc.returncode

    def process(self, images, enabled):
        if not enabled:
            return (images,)
        n = images.shape[0]
        if n == 0:
            return (images,)

        work = tempfile.mkdtemp(prefix="vsr_sub_")
        in_dir = os.path.join(work, "in")
        out_dir = os.path.join(work, "out")
        os.makedirs(in_dir, exist_ok=True)
        try:
            arr = (images.cpu().numpy() * 255.0).clip(0, 255).astype(np.uint8)

            # 阶段1：只写抽样帧跑 gate
            gate_idx = _gate_indices(n, GATE_FRAMES)
            for i in gate_idx:
                Image.fromarray(arr[i]).save(os.path.join(in_dir, f"{i:05d}.png"))
            result, rc = self._run_helper(in_dir, "gate")
            if rc != 0 or result != "RESULT=HIT":
                return (images,)  # CLEAN/出错 -> 透传

            # 阶段2：命中，补写其余帧跑 full
            have = set(gate_idx)
            for i in range(n):
                if i not in have:
                    Image.fromarray(arr[i]).save(os.path.join(in_dir, f"{i:05d}.png"))
            result, rc = self._run_helper(in_dir, "full", out_dir=out_dir)
            if rc != 0 or result != "RESULT=CLEANED":
                return (images,)

            outs = sorted(glob.glob(os.path.join(out_dir, "*.png")))
            if len(outs) != n:
                print(f"[SubtitleRemoverVSR] 输出帧数 {len(outs)} != 输入 {n}，透传原帧")
                return (images,)
            cleaned = np.stack([np.asarray(Image.open(p).convert("RGB"), dtype=np.uint8) for p in outs])
            return (torch.from_numpy(cleaned.astype(np.float32) / 255.0),)
        except Exception as e:
            print(f"[SubtitleRemoverVSR] 异常，透传原帧: {e}")
            return (images,)
        finally:
            shutil.rmtree(work, ignore_errors=True)


NODE_CLASS_MAPPINGS = {"SubtitleRemoverVSR": SubtitleRemoverVSR}
NODE_DISPLAY_NAME_MAPPINGS = {"SubtitleRemoverVSR": "字幕去除(VSR/STTN)"}
