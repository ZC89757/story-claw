#!/usr/bin/env bash
set -euo pipefail

ROOT="/root/avatar-news-test"
SRC="$ROOT/src"
MODELS="$ROOT/models"
VENV="$ROOT/venv-py310"
LOGS="$ROOT/logs"

mkdir -p "$SRC" "$MODELS/echo" "$MODELS/longcat" "$LOGS" "$ROOT/output"

nvidia-smi
df -h "$ROOT"

available_kb="$(df --output=avail -k "$ROOT" | tail -n 1 | tr -d ' ')"
if (( available_kb < 90 * 1024 * 1024 )); then
  echo "Need at least 90 GiB free under $ROOT; found $((available_kb / 1024 / 1024)) GiB." >&2
  exit 1
fi

if ! command -v git >/dev/null 2>&1 || ! command -v ffmpeg >/dev/null 2>&1; then
  apt-get update
  apt-get install -y git ffmpeg
fi

if [[ ! -d "$SRC/echomimic_v3/.git" ]]; then
  git clone --depth 1 https://github.com/antgroup/echomimic_v3.git "$SRC/echomimic_v3"
fi
if [[ ! -d "$SRC/LongCat-Video/.git" ]]; then
  git clone --depth 1 https://github.com/meituan-longcat/LongCat-Video.git "$SRC/LongCat-Video"
fi

if [[ ! -x "$VENV/bin/python" ]]; then
  /root/miniconda3/bin/python -m venv "$VENV"
fi

source "$VENV/bin/activate"
python -m pip install --upgrade pip setuptools wheel packaging ninja psutil
python -m pip install \
  torch==2.7.1 torchvision==0.22.1 torchaudio==2.7.1 \
  --index-url https://download.pytorch.org/whl/cu128

grep -Ev '^(torch|tensorflow|gradio|tensorboard|datasets|retina-face)([<=>~! ]|$)' \
  "$SRC/echomimic_v3/requirements.txt" > "$ROOT/echo-requirements.txt"
grep -Ev '^(torch|transformers|diffusers|flash-attn)([<=>~! ]|$)' \
  "$SRC/LongCat-Video/requirements.txt" > "$ROOT/longcat-requirements.txt"
grep -Ev '^(sympy|libsndfile1|tritonserverclient)([<=>~! ]|$)' \
  "$SRC/LongCat-Video/requirements_avatar.txt" > "$ROOT/longcat-avatar-requirements.txt"

python -m pip install -r "$ROOT/echo-requirements.txt"
python -m pip install -r "$ROOT/longcat-requirements.txt"
python -m pip install -r "$ROOT/longcat-avatar-requirements.txt"
python -m pip install \
  transformers==4.46.2 diffusers==0.35.1 \
  opencv-python-headless==4.9.0.80 "huggingface_hub[cli]"

if ! python -c 'import flash_attn' >/dev/null 2>&1; then
  FLASH_ATTENTION_FORCE_BUILD=TRUE \
    FLASH_ATTN_CUDA_ARCHS=120 \
    NVCC_THREADS=2 \
    MAX_JOBS=12 \
    python -m pip install flash-attn==2.8.3.post1 --no-build-isolation
fi

python - <<'PY'
import audio_separator
import decord
import diffusers
import flash_attn
import moviepy
import torch
import transformers

print({
    "torch": torch.__version__,
    "transformers": transformers.__version__,
    "diffusers": diffusers.__version__,
    "flash_attn": flash_attn.__version__,
})
PY

python - <<'PY'
from pathlib import Path
from huggingface_hub import snapshot_download

root = Path("/root/avatar-news-test/models")
endpoints = ("https://hf-mirror.com", "https://huggingface.co")


def download(repo_id: str, local_dir: Path, allow_patterns=None) -> None:
    last_error = None
    for endpoint in endpoints:
        try:
            print(f"[models] {repo_id} via {endpoint}")
            snapshot_download(
                repo_id=repo_id,
                local_dir=local_dir,
                allow_patterns=allow_patterns,
                endpoint=endpoint,
                max_workers=8,
            )
            return
        except Exception as exc:
            print(f"[models] endpoint failed: {exc}")
            last_error = exc
    raise RuntimeError(f"failed to download {repo_id}: {last_error}")


download(
    "alibaba-pai/Wan2.1-Fun-V1.1-1.3B-InP",
    root / "echo" / "Wan2.1-Fun-V1.1-1.3B-InP",
)
download(
    "BadToBest/EchoMimicV3",
    root / "echo" / "EchoMimicV3",
    ["echomimicv3-flash-pro/*"],
)
download(
    "TencentGameMate/chinese-wav2vec2-base",
    root / "echo" / "chinese-wav2vec2-base",
    ["config.json", "preprocessor_config.json", "pytorch_model.bin"],
)

download(
    "meituan-longcat/LongCat-Video",
    root / "longcat" / "LongCat-Video",
    ["tokenizer/*", "text_encoder/*", "vae/*"],
)
download(
    "meituan-longcat/LongCat-Video-Avatar-1.5",
    root / "longcat" / "LongCat-Video-Avatar-1.5",
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

import torch

root = Path("/root/avatar-news-test/models")
required = {
    root / "echo/Wan2.1-Fun-V1.1-1.3B-InP/diffusion_pytorch_model.safetensors": 3_000_000_000,
    root / "echo/EchoMimicV3/echomimicv3-flash-pro/diffusion_pytorch_model.safetensors": 3_000_000_000,
    root / "echo/chinese-wav2vec2-base/pytorch_model.bin": 300_000_000,
    root / "longcat/LongCat-Video/text_encoder/model.safetensors.index.json": 1,
    root / "longcat/LongCat-Video/vae/diffusion_pytorch_model.safetensors": 400_000_000,
    root / "longcat/LongCat-Video-Avatar-1.5/base_model_int8/quantized_model.safetensors.index.json": 1,
    root / "longcat/LongCat-Video-Avatar-1.5/lora/dmd_lora.safetensors": 2_000_000_000,
    root / "longcat/LongCat-Video-Avatar-1.5/whisper-large-v3/model.safetensors": 3_000_000_000,
}
for path, minimum_size in required.items():
    if not path.is_file() or path.stat().st_size < minimum_size:
        raise RuntimeError(f"missing or incomplete model file: {path}")

print({
    "torch": torch.__version__,
    "cuda": torch.version.cuda,
    "gpu": torch.cuda.get_device_name(0),
    "capability": torch.cuda.get_device_capability(0),
})
assert torch.cuda.get_device_capability(0) >= (12, 0)
PY

touch "$ROOT/.bootstrap-complete"
