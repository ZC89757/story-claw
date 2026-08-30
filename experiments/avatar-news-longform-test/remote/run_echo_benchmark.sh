#!/usr/bin/env bash
set -euo pipefail

ROOT="/root/avatar-news-test"
RUN_DIR="$ROOT/runs/ipo-lowres"
source "$ROOT/venv-py310/bin/activate"
export CUDA_VISIBLE_DEVICES=0
export CUDA_MODULE_LOADING=LAZY
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True

mkdir -p "$RUN_DIR/output/echo" "$RUN_DIR/metrics"
started="$(date +%s)"
cd "$ROOT/src/echomimic_v3"

python "$ROOT/remote/echo_single_gpu.py" \
  --image_path "$RUN_DIR/input/reference_9x16.png" \
  --audio_path "$RUN_DIR/input/article.wav" \
  --prompt "An anime female financial news anchor speaks directly to the camera with a professional calm expression, accurate lip movement, subtle blinking and small natural head movements, restrained presenter posture, static camera, clean bright studio background, consistent face, hair and clothing." \
  --num_inference_steps 8 \
  --config_path config/config.yaml \
  --model_name "$ROOT/models/echo/Wan2.1-Fun-V1.1-1.3B-InP" \
  --transformer_path "$ROOT/models/echo/EchoMimicV3/echomimicv3-flash-pro/diffusion_pytorch_model.safetensors" \
  --save_path "$RUN_DIR/output/echo" \
  --wav2vec_model_dir "$ROOT/models/echo/chinese-wav2vec2-base" \
  --sampler_name Flow_Unipc \
  --video_length 161 \
  --guidance_scale 6.0 \
  --audio_guidance_scale 2.0 \
  --seed 43 \
  --enable_teacache \
  --teacache_threshold 0.1 \
  --num_skip_start_steps 5 \
  --ulysses_degree 1 \
  --ring_degree 1 \
  --weight_dtype bfloat16 \
  --sample_size 512 896 \
  --fps 25 \
  --negative_prompt "subtitles, captions, text, watermark, logo, deformed face, duplicate person, extra limbs, bad hands, camera movement, identity drift" \
  --shift 5.0

finished="$(date +%s)"
python - "$RUN_DIR/metrics/echo_benchmark.json" "$started" "$finished" <<'PY'
import json
import sys

out, started, finished = sys.argv[1:]
with open(out, "w", encoding="utf-8") as handle:
    json.dump({"model": "EchoMimicV3 Flash", "started_epoch": int(started), "finished_epoch": int(finished), "elapsed_sec": int(finished) - int(started), "video_length_frames": 161, "requested_max_area": [512, 896]}, handle, ensure_ascii=False, indent=2)
PY
