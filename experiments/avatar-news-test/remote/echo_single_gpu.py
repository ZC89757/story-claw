"""Run EchoMimicV3 while releasing its text encoder after prompt encoding."""

from __future__ import annotations

import sys
from pathlib import Path

import torch


sys.path.insert(0, str(Path("/root/avatar-news-test/src/echomimic_v3")))

from src.pipeline_wan_fun_inpaint_audio_2512 import WanFunInpaintAudioPipeline


_encode_prompt = WanFunInpaintAudioPipeline.encode_prompt


def _encode_prompt_and_offload(
    self: WanFunInpaintAudioPipeline,
    *args: object,
    **kwargs: object,
) -> object:
    result = _encode_prompt(self, *args, **kwargs)
    if self.text_encoder is not None:
        self.text_encoder.to("cpu")
        torch.cuda.empty_cache()
        print("[single-gpu] Text encoder moved to CPU after prompt encoding.", flush=True)
    return result


WanFunInpaintAudioPipeline.encode_prompt = _encode_prompt_and_offload

from infer_flash import main  # noqa: E402


if __name__ == "__main__":
    main()
