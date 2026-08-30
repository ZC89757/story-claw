#!/usr/bin/env bash
set -euo pipefail

ROOT="/root/avatar-news-test"
RUN_DIR="$ROOT/runs/ipo-lowres"
source "$ROOT/venv-py310/bin/activate"
export CUDA_VISIBLE_DEVICES=0
export CUDA_MODULE_LOADING=LAZY
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True

mkdir -p "$RUN_DIR/output/longcat" "$RUN_DIR/metrics"
started="$(date +%s)"
cd "$ROOT/src/LongCat-Video"

torchrun --nproc_per_node=1 "$ROOT/remote/longcat_single_gpu.py" \
  --context_parallel_size=1 \
  --checkpoint_dir="$ROOT/models/longcat/LongCat-Video-Avatar-1.5" \
  --stage_1=ai2v \
  --input_json="$RUN_DIR/input/longcat_case.json" \
  --output_dir="$RUN_DIR/output/longcat" \
  --resolution=480p \
  --num_segments=79 \
  --use_distill \
  --model_type=avatar-v1.5 \
  --use_int8

finished="$(date +%s)"
python - "$RUN_DIR/metrics/longcat_benchmark.json" "$started" "$finished" <<'PY'
import json
import sys

out, started, finished = sys.argv[1:]
with open(out, "w", encoding="utf-8") as handle:
    json.dump({"model": "LongCat-Video-Avatar 1.5", "started_epoch": int(started), "finished_epoch": int(finished), "elapsed_sec": int(finished) - int(started), "resolution": "480p", "num_segments": 79, "first_segment_frames": 93, "continuation_frames": 80, "fps": 25}, handle, ensure_ascii=False, indent=2)
PY
