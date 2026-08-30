#!/usr/bin/env python3
"""Run one image-to-video prompt against three independent random seeds."""

from __future__ import annotations

import argparse
import json
import secrets
import subprocess
import sys
import time
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
RUNNER = SCRIPT_DIR / "run_ltx_idle.py"
DEFAULT_IMAGE = SCRIPT_DIR.parent / "halfbody" / "assets" / "base" / "X_source.png"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prompt-file", type=Path, required=True)
    parser.add_argument("--label", required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--image", type=Path, default=DEFAULT_IMAGE)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--duration", type=float, default=1.6)
    parser.add_argument("--fps", type=int, default=25)
    parser.add_argument("--width", type=int, default=576)
    parser.add_argument("--height", type=int, default=1024)
    parser.add_argument("--count", type=int, default=3)
    parser.add_argument("--timeout-seconds", type=int, default=1800)
    return parser.parse_args()


def run() -> None:
    args = parse_args()
    prompt = args.prompt_file.read_text(encoding="utf-8").strip()
    if not prompt:
        raise ValueError(f"empty prompt file: {args.prompt_file}")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    records: list[dict[str, object]] = []

    for index in range(1, args.count + 1):
        seed = secrets.randbelow(2**52 - 1) + 1
        output = args.output_dir / f"{args.label}_{index:02d}.mp4"
        command = [
            sys.executable,
            str(RUNNER),
            "--image",
            str(args.image),
            "--output",
            str(output),
            "--duration",
            str(args.duration),
            "--fps",
            str(args.fps),
            "--width",
            str(args.width),
            "--height",
            str(args.height),
            "--seed",
            str(seed),
            "--timeout-seconds",
            str(args.timeout_seconds),
            "--base-url",
            args.base_url,
            "--disable-person-face-gate",
            "--prompt",
            prompt,
        ]
        item_started = time.monotonic()
        print(f"[{index}/{args.count}] seed={seed} output={output}", flush=True)
        completed = subprocess.run(command, check=False)
        elapsed = round(time.monotonic() - item_started, 2)
        metadata_path = output.with_suffix(".json")
        records.append(
            {
                "index": index,
                "seed": seed,
                "output": str(output.resolve()),
                "metadata": str(metadata_path.resolve()),
                "elapsed_seconds": elapsed,
                "returncode": completed.returncode,
            }
        )
        if completed.returncode:
            raise RuntimeError(f"generation {index} failed after {elapsed}s")

    manifest = {
        "label": args.label,
        "prompt": prompt,
        "base_url": args.base_url,
        "duration_requested_seconds": args.duration,
        "total_elapsed_seconds": round(time.monotonic() - started, 2),
        "records": records,
    }
    manifest_path = args.output_dir / f"{args.label}_manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"manifest={manifest_path}", flush=True)


if __name__ == "__main__":
    run()
