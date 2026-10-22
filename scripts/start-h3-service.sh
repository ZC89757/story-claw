#!/usr/bin/env bash
set -euo pipefail
comfy_dir="${COMFYUI_DIR:-/root/ComfyUI}"
python_bin="${H3_PYTHON:-/root/miniconda3/bin/python3.10}"
port="${H3_PORT:-8188}"
test -f "$comfy_dir/main.py" || { echo "Missing ComfyUI main.py: $comfy_dir" >&2; exit 1; }
test -x "$python_bin" || { echo "Missing H3 Python: $python_bin" >&2; exit 1; }
cd "$comfy_dir"
exec "$python_bin" -u main.py --listen 0.0.0.0 --port "$port"
