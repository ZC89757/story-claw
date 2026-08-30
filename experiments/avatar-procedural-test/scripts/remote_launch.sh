#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="/root/avatar-continuous-test"
PID_FILE="$ROOT_DIR/run.pid"
LOG_FILE="$ROOT_DIR/run.log"

if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  printf 'already running: %s\n' "$(cat "$PID_FILE")"
  exit 0
fi

nohup bash "$ROOT_DIR/remote_render.sh" > "$LOG_FILE" 2>&1 &
printf '%s\n' "$!" > "$PID_FILE"
printf 'started: %s\n' "$!"
