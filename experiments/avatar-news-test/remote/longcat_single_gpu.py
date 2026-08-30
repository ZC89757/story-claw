"""Run LongCat Avatar 1.5 on one 32 GB GPU with the text encoder on CPU."""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

import torch


sys.path.insert(0, str(Path.cwd()))

from longcat_video.pipeline_longcat_video_avatar import (  # noqa: E402
    LongCatVideoAvatarPipeline,
)


class CPUTextEncoder(torch.nn.Module):
    """Keep UMT5-XXL in system RAM while returning embeddings to the pipeline."""

    def __init__(self, inner: torch.nn.Module) -> None:
        super().__init__()
        self.inner = inner.to("cpu")

    @property
    def config(self) -> Any:
        return self.inner.config

    @property
    def dtype(self) -> torch.dtype:
        return next(self.inner.parameters()).dtype

    def to(self, *args: Any, **kwargs: Any) -> "CPUTextEncoder":
        return self

    def forward(
        self,
        input_ids: torch.Tensor,
        attention_mask: torch.Tensor | None = None,
        **kwargs: Any,
    ) -> Any:
        cpu_mask = attention_mask.to("cpu") if attention_mask is not None else None
        return self.inner(
            input_ids.to("cpu"),
            attention_mask=cpu_mask,
            **kwargs,
        )


_pipeline_to = LongCatVideoAvatarPipeline.to


def _single_gpu_to(
    self: LongCatVideoAvatarPipeline,
    device: str | torch.device,
) -> LongCatVideoAvatarPipeline:
    encoder = self.text_encoder
    proxy = encoder if isinstance(encoder, CPUTextEncoder) else CPUTextEncoder(encoder)
    self.text_encoder = None
    try:
        result = _pipeline_to(self, device)
    finally:
        self.text_encoder = proxy
    return result


LongCatVideoAvatarPipeline.to = _single_gpu_to

from run_demo_avatar_single_audio_to_video import _parse_args, generate  # noqa: E402


if __name__ == "__main__":
    generate(_parse_args())
