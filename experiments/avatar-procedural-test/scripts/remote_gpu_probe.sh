#!/usr/bin/env bash
set -euo pipefail

BLENDER="/root/avatar-continuous-test/tools/blender-4.2.3-linux-x64/blender"
EXPR='import gpu; print("GPU_VENDOR=" + gpu.platform.vendor_get()); print("GPU_RENDERER=" + gpu.platform.renderer_get()); print("GPU_VERSION=" + gpu.platform.version_get())'

env __GLX_VENDOR_LIBRARY_NAME=nvidia LIBGL_ALWAYS_SOFTWARE=0 EGL_PLATFORM=surfaceless \
  "$BLENDER" --background --gpu-backend opengl --python-expr "$EXPR"
