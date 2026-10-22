"""Compatibility entry: use the main H3 lifecycle and real-video warmup."""
import pathlib
import shutil
import subprocess
import sys
root = pathlib.Path(__file__).resolve().parent.parent
sys.exit(subprocess.call([shutil.which('node') or 'node', '--import', 'tsx', str(root/'scripts/gpu-service.ts'), 'start'], cwd=root))
