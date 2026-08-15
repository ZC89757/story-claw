# -*- coding: utf-8 -*-
"""
ComfyUI 自定义节点 — PersonFaceGate（Gate1 多余人物 + Gate2 人脸捏造）

部署：/root/ComfyUI/custom_nodes/PersonFaceGate/__init__.py，重启 ComfyUI 注册。
（不要跟 /root/ComfyUI/custom_nodes/ComfyUI-SubtitleRemover/ 混用，那是另一个独立的
 自定义节点包，当前 PRESUB workflow 没有引用它。）

插在 base 采样（LTXVSeparateAVLatent 输出）之后、升采样（LTXVLatentUpsampler）之前。
取 base 阶段解码出的首帧、尾帧，送多模态 LLM 判断：
  1. 首尾帧主要人物是否一致，尾帧有没有凭空多出的人（Gate1）
  2. 首帧看不到正脸时，尾帧是否出现了编造出的正脸（Gate2）
不通过时回调 pipeline_wrapper:8190 的 /gate_verdict，问询是否已达重试上限：
  - 未达上限 -> raise，中断该 ComfyUI 任务，让 render.ts 的重试机制重新生成
  - 已达上限 -> 放行，原样透传 base latent 到升采样

latent 原样透传、不修改内容，只是让图执行顺序卡在这里等待 gate 判断完成。
"""
import base64
import io
import json
import os
import re
import time
import urllib.error
import urllib.request

import numpy as np
from PIL import Image


def _log(msg: str) -> None:
    print(f"[PersonFaceGate {time.strftime('%H:%M:%S')}] {msg}", flush=True)

VISION_BASE_URL   = "https://zenmux.ai/api/anthropic"
VISION_API_KEY    = os.environ.get("STORY_CLAW_VISION_API_KEY", "")
_DEFAULT_VISION_MODEL = "stepfun/step-3.7-flash"  # wrapper 不可用时的兜底值
GATE_WRAPPER_HOST = "http://127.0.0.1:8190"
GATE_WRAPPER_URL  = f"{GATE_WRAPPER_HOST}/gate_verdict"


def _get_vision_model() -> str:
    """每次调用前问 pipeline_wrapper 要当前配置的模型 id（页面上可改，无需重启 ComfyUI）。"""
    try:
        resp = json.loads(urllib.request.urlopen(f"{GATE_WRAPPER_HOST}/vision_model", timeout=5).read())
        model = resp.get("model")
        if model:
            return model
    except Exception as e:
        _log(f"获取 vision_model 配置失败，用默认值: {e}")
    return _DEFAULT_VISION_MODEL

PERSON_FACE_PROMPT = """这是同一段 AI 生成视频的首帧（第一张图）和尾帧（第二张图）。只需要考虑画面中的主体人物（构图焦点、镜头对准的角色），背景里的路人、群演等次要人物不用管。请判断：
1. 首帧和尾帧中的主体人物是否是同一批人？尾帧里有没有出现首帧中没有的、多余的主体人物？
2. 如果首帧中主体人物背对镜头或看不到正脸，但尾帧却出现了一张清晰的正脸——这张脸没有任何首帧依据，是凭空捏造的，也算不合理。
只输出如下 JSON，不要有任何其他文字：
{"extra_person": true/false, "fabricated_face": true/false, "reason": "一句话说明"}"""


def _encode_png(arr: np.ndarray) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(arr).save(buf, format="PNG")
    return buf.getvalue()


def _call_vision_llm(images_png: list, prompt: str):
    if not VISION_API_KEY:
        _log("缺少 STORY_CLAW_VISION_API_KEY，跳过人物检测")
        return None
    content = [
        {"type": "image", "source": {"type": "base64", "media_type": "image/png",
                                      "data": base64.b64encode(p).decode()}}
        for p in images_png
    ] + [{"type": "text", "text": prompt}]
    body = json.dumps({
        "model": _get_vision_model(), "max_tokens": 2048,
        "messages": [{"role": "user", "content": content}],
    }).encode()
    req = urllib.request.Request(
        f"{VISION_BASE_URL}/v1/messages", data=body,
        headers={"x-api-key": VISION_API_KEY, "anthropic-version": "2023-06-01",
                 "Content-Type": "application/json"},
        method="POST",
    )
    t0 = time.time()
    try:
        resp = json.loads(urllib.request.urlopen(req, timeout=30).read())
        # 推理模型 content 里第一块常是 thinking，要找 type=="text" 的那块
        text = next((b["text"] for b in resp["content"] if b.get("type") == "text"), "")
        m = re.search(r"\{.*\}", text, re.S)
        verdict = json.loads(m.group(0)) if m else None
        _log(f"vision_llm {round(time.time() - t0, 1)}s → {verdict}")
        return verdict
    except Exception as e:
        _log(f"vision_llm {round(time.time() - t0, 1)}s 调用/解析失败: {e}")
        return None


def _consult_gate_wrapper(job_key: str, gate: str, passed: bool, reason: str) -> str:
    """问 wrapper 这次不通过该不该拦（还是已达重试上限该放行）。失败时 fail-open 放行。"""
    body = json.dumps({"job_key": job_key, "gate": gate, "passed": passed, "reason": reason}).encode()
    req = urllib.request.Request(
        GATE_WRAPPER_URL, data=body,
        headers={"Content-Type": "application/json"}, method="POST",
    )
    try:
        resp = json.loads(urllib.request.urlopen(req, timeout=10).read())
        return resp.get("action", "continue")
    except Exception as e:
        _log(f"/gate_verdict 回调失败，放行: {e}")
        return "continue"


class PersonFaceGate:
    """
    输入：images (IMAGE, base 阶段解码全部帧), latent (LATENT, base 阶段原始 latent,
          原样透传), job_key (STRING), enabled (BOOLEAN)
    输出：latent (LATENT) — 原样透传，不修改内容
    不通过且 wrapper 判定未达重试上限时 raise，中断整个 ComfyUI 任务。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images":  ("IMAGE",),
                "latent":  ("LATENT",),
                "job_key": ("STRING",  {"default": ""}),
                "enabled": ("BOOLEAN", {"default": True}),
            }
        }

    RETURN_TYPES = ("LATENT",)
    FUNCTION     = "process"
    CATEGORY     = "video/postprocess"

    def process(self, images, latent, job_key: str, enabled: bool):
        if not enabled or not job_key:
            return (latent,)

        passed, reason = True, ""
        try:
            arr = (images.cpu().numpy() * 255.0).clip(0, 255).astype(np.uint8)
            if arr.shape[0] > 0:
                frame0_png     = _encode_png(arr[0])
                frame_last_png = _encode_png(arr[-1])
                verdict = _call_vision_llm([frame0_png, frame_last_png], PERSON_FACE_PROMPT)
                if verdict is not None:
                    extra      = bool(verdict.get("extra_person", False))
                    fabricated = bool(verdict.get("fabricated_face", False))
                    passed = not (extra or fabricated)
                    reason = verdict.get("reason", "")
        except Exception as e:
            _log(f"检测异常，视为通过: {e}")
            passed = True

        action = _consult_gate_wrapper(job_key, "person_face", passed, reason)
        _log(f"job_key={job_key[:8]} passed={passed} action={action} reason={reason}")
        if action == "reject":
            raise RuntimeError(f"Gate1/2 未通过: {reason}")
        return (latent,)


NODE_CLASS_MAPPINGS = {
    "PersonFaceGate": PersonFaceGate,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "PersonFaceGate": "人物一致性+人脸捏造检测（Gate1/2）",
}
