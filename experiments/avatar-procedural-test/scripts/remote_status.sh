#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="/root/avatar-continuous-test"
TOOLS_DIR="$ROOT_DIR/tools"
PID_FILE="$ROOT_DIR/run.pid"

printf 'timestamp: '
date -Is
if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  printf 'run: active (%s)\n' "$(cat "$PID_FILE")"
else
  printf 'run: inactive\n'
fi

for artifact in \
  "$TOOLS_DIR/rhubarb-1.13.0-linux.zip" \
  "$TOOLS_DIR/blender-4.2.3-linux-x64.tar.xz" \
  "$ROOT_DIR/output/avatar_continuous.mp4"; do
  if [[ -e "$artifact" ]]; then
    printf '%s: ' "$(basename "$artifact")"
    stat --format='%s bytes' "$artifact"
  fi
done

if [[ -f "$ROOT_DIR/run.log" ]]; then
  tail -n 12 "$ROOT_DIR/run.log"
fi
