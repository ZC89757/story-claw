#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="/root/avatar-continuous-test"
TOOLS_DIR="$ROOT_DIR/tools"
INPUT_DIR="$ROOT_DIR/input"
OUTPUT_DIR="$ROOT_DIR/output"
BLENDER_VERSION="4.2.3"
BLENDER_ARCHIVE="$TOOLS_DIR/blender-${BLENDER_VERSION}-linux-x64.tar.xz"
BLENDER_DIR="$TOOLS_DIR/blender-${BLENDER_VERSION}-linux-x64"
RHUBARB_ARCHIVE="$TOOLS_DIR/rhubarb-1.13.0-linux.zip"

download() {
  local url="$1"
  local destination="$2"
  printf 'Downloading %s\n' "$(basename "$destination")"
  wget --continue --show-progress --output-document="$destination" "$url"
}

mkdir -p "$TOOLS_DIR" "$INPUT_DIR" "$OUTPUT_DIR"
command -v ffmpeg >/dev/null
command -v unzip >/dev/null

if [[ ! -d "$TOOLS_DIR/rhubarb-dist" ]]; then
  download "https://ghfast.top/https://github.com/DanielSWolf/rhubarb-lip-sync/releases/download/v1.13.0/Rhubarb-Lip-Sync-1.13.0-Linux.zip" "$RHUBARB_ARCHIVE"
  unzip -q "$RHUBARB_ARCHIVE" -d "$TOOLS_DIR/rhubarb-dist"
fi
RHUBARB_BIN="$(find "$TOOLS_DIR/rhubarb-dist" -type f -name rhubarb -print -quit)"
test -n "$RHUBARB_BIN"
chmod +x "$RHUBARB_BIN"

if [[ ! -x "$BLENDER_DIR/blender" ]]; then
  download "https://download.blender.org/release/Blender4.2/blender-4.2.3-linux-x64.tar.xz" "$BLENDER_ARCHIVE"
  tar -xf "$BLENDER_ARCHIVE" -C "$TOOLS_DIR"
fi

"$BLENDER_DIR/blender" --background --version
env AVATAR_RENDER_CONFIG="$ROOT_DIR/remote_render_config.json" \
  "$BLENDER_DIR/blender" --background --python "$ROOT_DIR/avatar_continuous_render.py"

printf 'Remote render completed successfully.\n'
