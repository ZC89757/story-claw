#!/usr/bin/env bash
set -euo pipefail

ROOT="/root/avatar-news-test"
source "$ROOT/venv-py310/bin/activate"
export CUDA_VISIBLE_DEVICES=0
export CUDA_MODULE_LOADING=LAZY
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True

mkdir -p "$ROOT/output/longcat" "$ROOT/logs"
cd "$ROOT/src/LongCat-Video"

torchrun --nproc_per_node=1 "$ROOT/remote/longcat_single_gpu.py" \
  --context_parallel_size=1 \
  --checkpoint_dir="$ROOT/models/longcat/LongCat-Video-Avatar-1.5" \
  --stage_1=ai2v \
  --input_json="$ROOT/input/longcat_case.json" \
  --output_dir="$ROOT/output/longcat" \
  --resolution=480p \
  --num_segments=1 \
  --use_distill \
  --model_type=avatar-v1.5 \
  --use_int8 2>&1 | tee "$ROOT/logs/longcat.log"
