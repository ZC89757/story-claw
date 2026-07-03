# -*- coding: utf-8 -*-
"""
ComfyUI 自定义节点 — SubtitleDetector + SubtitleRemoverVSR

SubtitleDetector  : 检测 base 帧是否含字幕，命中时 POST /subtitle_record 回调
                    pipeline_wrapper:8190，图像原样透传，不做任何修改。
SubtitleRemoverVSR: 原有节点，保留向后兼容。
"""
import glob
import json
import os
import shutil
import subprocess
import tempfile
import urllib.request
import urllib.error

import numpy as np
import torch
from PIL import Image

VSR_PYTHON  = "/root/miniconda3/envs/vsr/bin/python"
HELPER      = "/root/video-subtitle-remover/clean_frames_cli.py"
WRAPPER     = "http://127.0.0.1:8190/subtitle_record"
GATE_FRAMES = 8


def _gate_indices(n, k):
    k = max(1, min(k, n))
    if k == 1:
        return [0]
    return sorted(set(int(round(i * (n - 1) / (k - 1))) for i in range(k)))


def _run_gate(in_dir: str) -> str:
    """调 clean_frames_cli.py --mode gate，返回 'RESULT=HIT'/'RESULT=CLEAN'/'RESULT=ERROR'。"""
    env = dict(os.environ)
    env["QT_QPA_PLATFORM"]                  = "offscreen"
    env["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"
    try:
        proc = subprocess.run(
            [VSR_PYTHON, HELPER, "--in-dir", in_dir, "--mode", "gate"],
            env=env, capture_output=True, text=True, timeout=120,
        )
        for line in reversed((proc.stdout or "").strip().splitlines()):
            if line.startswith("RESULT="):
                return line.strip()
        return "RESULT=ERROR"
    except Exception as e:
        print(f"[SubtitleDetector] _run_gate 异常: {e}")
        return "RESULT=ERROR"


def _post_record(job_id: str) -> None:
    body = json.dumps({"job_id": job_id}).encode()
    req  = urllib.request.Request(
        WRAPPER,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        urllib.request.urlopen(req, timeout=5)
        print(f"[SubtitleDetector] POST /subtitle_record job_id={job_id} OK")
    except urllib.error.URLError as e:
        print(f"[SubtitleDetector] POST /subtitle_record 失败: {e}")


# ─── SubtitleDetector ─────────────────────────────────────────────────────────

class SubtitleDetector:
    """
    输入：images (IMAGE), job_id (STRING), enabled (BOOLEAN)
    输出：images (IMAGE) — 原样透传，不做任何修改
    内部：抽 GATE_FRAMES 帧跑 gate 检测；命中时回调 pipeline_wrapper /subtitle_record。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images":  ("IMAGE",),
                "job_id":  ("STRING",  {"default": ""}),
                "enabled": ("BOOLEAN", {"default": True}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    FUNCTION     = "process"
    CATEGORY     = "video/postprocess"

    def process(self, images, job_id: str, enabled: bool):
        if not enabled or not job_id:
            return (images,)

        n = images.shape[0]
        if n == 0:
            return (images,)

        work   = tempfile.mkdtemp(prefix="subdet_")
        in_dir = os.path.join(work, "in")
        os.makedirs(in_dir, exist_ok=True)
        try:
            arr       = (images.cpu().numpy() * 255.0).clip(0, 255).astype(np.uint8)
            gate_idx  = _gate_indices(n, GATE_FRAMES)
            for i in gate_idx:
                Image.fromarray(arr[i]).save(os.path.join(in_dir, f"{i:05d}.png"))

            result = _run_gate(in_dir)
            print(f"[SubtitleDetector] job_id={job_id} gate -> {result}")

            if result == "RESULT=HIT":
                _post_record(job_id)
        except Exception as e:
            print(f"[SubtitleDetector] 异常，透传原帧: {e}")
        finally:
            shutil.rmtree(work, ignore_errors=True)

        return (images,)


# ─── SubtitleRemoverVSR（保留向后兼容）────────────────────────────────────────

class SubtitleRemoverVSR:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"images": ("IMAGE",), "enabled": ("BOOLEAN", {"default": True})}}

    RETURN_TYPES = ("IMAGE",)
    FUNCTION     = "process"
    CATEGORY     = "video/postprocess"

    def _run_helper(self, in_dir, mode, out_dir=""):
        env = dict(os.environ)
        env["QT_QPA_PLATFORM"]                  = "offscreen"
        env["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"
        cmd = [VSR_PYTHON, HELPER, "--in-dir", in_dir, "--mode", mode]
        if out_dir:
            cmd += ["--out-dir", out_dir]
        proc   = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=3600)
        result = ""
        for line in reversed((proc.stdout or "").strip().splitlines()):
            if line.startswith("RESULT="):
                result = line.strip()
                break
        print(f"[SubtitleRemoverVSR] mode={mode} -> {result or '?'} (rc={proc.returncode})")
        if proc.returncode != 0 and proc.stderr:
            print("[SubtitleRemoverVSR] stderr:\n" + "\n".join(proc.stderr.strip().splitlines()[-8:]))
        return result, proc.returncode

    def process(self, images, enabled):
        if not enabled:
            return (images,)
        n = images.shape[0]
        if n == 0:
            return (images,)

        work   = tempfile.mkdtemp(prefix="vsr_sub_")
        in_dir = os.path.join(work, "in")
        out_dir= os.path.join(work, "out")
        os.makedirs(in_dir, exist_ok=True)
        try:
            arr      = (images.cpu().numpy() * 255.0).clip(0, 255).astype(np.uint8)
            gate_idx = _gate_indices(n, GATE_FRAMES)
            for i in gate_idx:
                Image.fromarray(arr[i]).save(os.path.join(in_dir, f"{i:05d}.png"))
            result, rc = self._run_helper(in_dir, "gate")
            if rc != 0 or result != "RESULT=HIT":
                return (images,)

            have = set(gate_idx)
            for i in range(n):
                if i not in have:
                    Image.fromarray(arr[i]).save(os.path.join(in_dir, f"{i:05d}.png"))
            result, rc = self._run_helper(in_dir, "full", out_dir=out_dir)
            if rc != 0 or result != "RESULT=CLEANED":
                return (images,)

            outs = sorted(glob.glob(os.path.join(out_dir, "*.png")))
            if len(outs) != n:
                print(f"[SubtitleRemoverVSR] 输出帧数 {len(outs)} != 输入 {n}，透传")
                return (images,)
            cleaned = np.stack([np.asarray(Image.open(p).convert("RGB"), dtype=np.uint8) for p in outs])
            return (torch.from_numpy(cleaned.astype(np.float32) / 255.0),)
        except Exception as e:
            print(f"[SubtitleRemoverVSR] 异常，透传原帧: {e}")
            return (images,)
        finally:
            shutil.rmtree(work, ignore_errors=True)


# ─── 注册 ─────────────────────────────────────────────────────────────────────

NODE_CLASS_MAPPINGS = {
    "SubtitleDetector":   SubtitleDetector,
    "SubtitleRemoverVSR": SubtitleRemoverVSR,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "SubtitleDetector":   "字幕检测（回调）",
    "SubtitleRemoverVSR": "字幕去除(VSR/STTN)",
}
