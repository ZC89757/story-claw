#!/usr/bin/env bash
set -euo pipefail

ROOT="/root/avatar-news-test"
RUN_DIR="$ROOT/runs/ipo-official-5seg"
OUTPUT_DIR="$RUN_DIR/output/longcat"
LOG_DIR="$RUN_DIR/logs"
METRICS_DIR="$RUN_DIR/metrics"
LOG_PATH="$LOG_DIR/longcat.log"
METRICS_PATH="$METRICS_DIR/longcat_benchmark.json"
NUM_SEGMENTS=5
FPS=25
FIRST_SEGMENT_FRAMES=93
CONTINUATION_FRAMES=80
ENTRYPOINT="${LONGCAT_ENTRYPOINT:-$ROOT/remote/longcat_single_gpu.py}"
KV_CACHE_OFFLOAD="${LONGCAT_KV_CACHE_OFFLOAD:-false}"

source "$ROOT/venv-py310/bin/activate"
export CUDA_VISIBLE_DEVICES=0
export CUDA_MODULE_LOADING=LAZY
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
export PYTHONUNBUFFERED=1

mkdir -p "$OUTPUT_DIR" "$LOG_DIR" "$METRICS_DIR"
started="$(date +%s.%N)"

cd "$ROOT/src/LongCat-Video"
set +e
stdbuf -oL -eL torchrun --nproc_per_node=1 "$ENTRYPOINT" \
  --context_parallel_size=1 \
  --checkpoint_dir="$ROOT/models/longcat/LongCat-Video-Avatar-1.5" \
  --stage_1=ai2v \
  --input_json="$RUN_DIR/input/longcat_official_5seg.json" \
  --output_dir="$OUTPUT_DIR" \
  --resolution=480p \
  --num_segments="$NUM_SEGMENTS" \
  --ref_img_index=10 \
  --mask_frame_range=3 \
  --use_distill \
  --model_type=avatar-v1.5 \
  --use_int8 2>&1 | while IFS= read -r line; do
    printf '[%s] %s\n' "$(date +%s.%N)" "$line"
  done | tee "$LOG_PATH"
run_status="${PIPESTATUS[0]}"
set -e
finished="$(date +%s.%N)"

if [[ "$run_status" -ne 0 ]]; then
  exit "$run_status"
fi

video_path="$OUTPUT_DIR/video_continue_${NUM_SEGMENTS}.mp4"
if [[ ! -f "$video_path" ]]; then
  echo "Expected final video was not written: $video_path" >&2
  exit 1
fi

python - "$LOG_PATH" "$METRICS_PATH" "$started" "$finished" "$video_path" "$NUM_SEGMENTS" "$FPS" "$FIRST_SEGMENT_FRAMES" "$CONTINUATION_FRAMES" "$KV_CACHE_OFFLOAD" <<'PY'
import json
import re
import subprocess
import sys

log_path, metrics_path, started, finished, video_path, count, fps, first_frames, continuation_frames, kv_cache_offload = sys.argv[1:]
started = float(started)
finished = float(finished)
count = int(count)
fps = int(fps)
first_frames = int(first_frames)
continuation_frames = int(continuation_frames)

starts = {}
pattern = re.compile(r"^\[(\d+\.\d+)\] Generating segment (\d+)/(\d+)\.\.\.")
with open(log_path, encoding="utf-8", errors="replace") as handle:
    for line in handle:
        match = pattern.match(line)
        if match:
            starts[int(match.group(2))] = float(match.group(1))

durations = {}
for index in range(1, count):
    if index in starts and index + 1 in starts:
        durations[str(index)] = starts[index + 1] - starts[index]
if count in starts:
    durations[str(count)] = finished - starts[count]

probe = subprocess.run(
    ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", video_path],
    check=True,
    capture_output=True,
    text=True,
)
video_duration = float(probe.stdout.strip())
continuation_values = [durations[str(index)] for index in range(2, count + 1) if str(index) in durations]

payload = {
    "model": "LongCat-Video-Avatar-1.5",
    "mode": "official-ai2v-continuation-benchmark",
    "kv_cache_offload": kv_cache_offload.lower() == "true",
    "resolution": "480p",
    "num_segments": count,
    "fps": fps,
    "first_segment_frames": first_frames,
    "continuation_frames": continuation_frames,
    "expected_video_duration_sec": first_frames / fps + (count - 1) * continuation_frames / fps,
    "actual_video_duration_sec": video_duration,
    "wall_clock_sec": finished - started,
    "setup_before_first_segment_sec": starts.get(1, finished) - started,
    "segment_wall_clock_sec": durations,
    "mean_continuation_segment_sec": sum(continuation_values) / len(continuation_values) if continuation_values else None,
    "output_path": video_path,
}
with open(metrics_path, "w", encoding="utf-8") as handle:
    json.dump(payload, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
print(json.dumps(payload, ensure_ascii=False))
PY
