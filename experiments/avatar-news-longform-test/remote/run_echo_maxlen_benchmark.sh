#!/usr/bin/env bash
set -euo pipefail

ROOT="/root/avatar-news-test"
RUN_DIR="$ROOT/runs/ipo-echo-maxlen"
OUTPUT_DIR="$RUN_DIR/output/echo"
LOG_DIR="$RUN_DIR/logs"
METRICS_DIR="$RUN_DIR/metrics"
VIDEO_LENGTH="${ECHO_VIDEO_LENGTH:-161}"
AUDIO_FILE="${ECHO_AUDIO_FILE:-article_maxlen.wav}"
AUDIO_PATH="$RUN_DIR/input/$AUDIO_FILE"
FPS=25

source "$ROOT/venv-py310/bin/activate"
export CUDA_VISIBLE_DEVICES=0
export CUDA_MODULE_LOADING=LAZY
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
export PYTHONUNBUFFERED=1

mkdir -p "$OUTPUT_DIR" "$LOG_DIR" "$METRICS_DIR"
started="$(date +%s.%N)"

cd "$ROOT/src/echomimic_v3"
set +e
stdbuf -oL -eL python "$ROOT/remote/echo_single_gpu.py" \
  --image_path "$RUN_DIR/input/reference_9x16.png" \
  --audio_path "$AUDIO_PATH" \
  --prompt "An anime female financial news anchor speaks directly to the camera with a professional calm expression, accurate lip movement, subtle blinking and small natural head movements, restrained presenter posture, static camera, clean bright studio background, consistent face, hair and clothing." \
  --num_inference_steps 8 \
  --config_path config/config.yaml \
  --model_name "$ROOT/models/echo/Wan2.1-Fun-V1.1-1.3B-InP" \
  --transformer_path "$ROOT/models/echo/EchoMimicV3/echomimicv3-flash-pro/diffusion_pytorch_model.safetensors" \
  --save_path "$OUTPUT_DIR" \
  --wav2vec_model_dir "$ROOT/models/echo/chinese-wav2vec2-base" \
  --sampler_name Flow_Unipc \
  --video_length "$VIDEO_LENGTH" \
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
  --fps "$FPS" \
  --negative_prompt "subtitles, captions, text, watermark, logo, deformed face, duplicate person, extra limbs, bad hands, camera movement, identity drift" \
  --shift 5.0 2>&1 | while IFS= read -r line; do
    printf '[%s] %s\n' "$(date +%s.%N)" "$line"
  done | tee "$LOG_DIR/echo.log"
run_status="${PIPESTATUS[0]}"
set -e
finished="$(date +%s.%N)"

if [[ "$run_status" -ne 0 ]]; then
  exit "$run_status"
fi

video_path="$(find "$OUTPUT_DIR" -type f -name '*.mp4' -printf '%T@ %p\n' | sort -nr | head -n 1 | cut -d' ' -f2-)"
if [[ -z "$video_path" || ! -f "$video_path" ]]; then
  echo "EchoMimic did not write an MP4 output." >&2
  exit 1
fi

python - "$METRICS_DIR/echo_maxlen_benchmark.json" "$started" "$finished" "$video_path" "$VIDEO_LENGTH" "$FPS" "$AUDIO_PATH" <<'PY'
import json
import subprocess
import sys

metrics_path, started, finished, video_path, video_length, fps, audio_path = sys.argv[1:]

def duration(path: str) -> float:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path],
        check=True,
        capture_output=True,
        text=True,
    )
    return float(result.stdout.strip())

payload = {
    "model": "EchoMimicV3 Flash",
    "mode": "maximum-single-window-benchmark",
    "requested_video_length_frames": int(video_length),
    "requested_fps": int(fps),
    "requested_duration_sec": int(video_length) / int(fps),
    "audio_duration_sec": duration(audio_path),
    "output_duration_sec": duration(video_path),
    "wall_clock_sec": float(finished) - float(started),
    "output_path": video_path,
}
with open(metrics_path, "w", encoding="utf-8") as handle:
    json.dump(payload, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
print(json.dumps(payload, ensure_ascii=False))
PY
