#!/usr/bin/env bash
set -euo pipefail

ROOT="/root/avatar-news-test"
source "$ROOT/venv-py310/bin/activate"

python - <<'PY'
from pathlib import Path

from huggingface_hub import snapshot_download


root = Path("/root/avatar-news-test/models/longcat")
endpoints = ("https://hf-mirror.com", "https://huggingface.co")


def download(repo_id: str, local_dir: Path, allow_patterns: list[str]) -> None:
    last_error = None
    for endpoint in endpoints:
        try:
            print(f"[models] {repo_id} via {endpoint}", flush=True)
            snapshot_download(
                repo_id=repo_id,
                local_dir=local_dir,
                allow_patterns=allow_patterns,
                endpoint=endpoint,
                max_workers=8,
            )
            return
        except Exception as exc:
            print(f"[models] endpoint failed: {exc}", flush=True)
            last_error = exc
    raise RuntimeError(f"failed to download {repo_id}: {last_error}")


download(
    "meituan-longcat/LongCat-Video",
    root / "LongCat-Video",
    ["tokenizer/*", "text_encoder/*", "vae/*"],
)
download(
    "meituan-longcat/LongCat-Video-Avatar-1.5",
    root / "LongCat-Video-Avatar-1.5",
    [
        "base_model_int8/*",
        "lora/dmd_lora.safetensors",
        "scheduler/*",
        "vocal_separator/*",
        "whisper-large-v3/*.json",
        "whisper-large-v3/*.txt",
        "whisper-large-v3/*.model",
        "whisper-large-v3/model.safetensors",
    ],
)
PY

python - <<'PY'
from pathlib import Path


root = Path("/root/avatar-news-test/models/longcat")
required = {
    root / "LongCat-Video/text_encoder/model.safetensors.index.json": 1,
    root / "LongCat-Video/vae/diffusion_pytorch_model.safetensors": 400_000_000,
    root / "LongCat-Video-Avatar-1.5/base_model_int8/quantized_model.safetensors.index.json": 1,
    root / "LongCat-Video-Avatar-1.5/lora/dmd_lora.safetensors": 2_000_000_000,
    root / "LongCat-Video-Avatar-1.5/whisper-large-v3/model.safetensors": 3_000_000_000,
}
for path, minimum_size in required.items():
    if not path.is_file() or path.stat().st_size < minimum_size:
        raise RuntimeError(f"missing or incomplete model file: {path}")

print("LongCat model files verified.")
PY

touch "$ROOT/.longcat-models-complete"
