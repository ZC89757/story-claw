#!/usr/bin/env python3
"""Generate a short, non-speaking idle avatar clip through the GPU LTX service."""

from __future__ import annotations

import argparse
import base64
import json
import random
import time
from pathlib import Path
from typing import Any

import requests


SCRIPT_DIR = Path(__file__).resolve().parent
EXPERIMENT_ROOT = SCRIPT_DIR.parent
REPO_ROOT = EXPERIMENT_ROOT.parents[1]
DEFAULT_IMAGE = EXPERIMENT_ROOT / "halfbody" / "assets" / "base" / "X_source.png"
DEFAULT_OUTPUT = SCRIPT_DIR / "output" / "idle_blink_hair_576x1024.mp4"
DEFAULT_WORKFLOW = REPO_ROOT / "video_ltx2_3_i2v_PRESUB.json"
DEFAULT_PROMPT = (
    "A static vertical medium shot of the same anime female news presenter from the reference image. "
    "She looks directly at the camera and keeps the exact same identity, pose, framing, outfit, and white background. "
    "Her mouth remains gently closed and completely still; she is not speaking. "
    "She performs one brief, natural, continuous blink around the middle of the clip, with smooth eyelid motion. "
    "A very gentle breeze makes only the bangs and hair tips sway subtly. "
    "No head movement, no body movement, no camera movement, no zoom, no scene change."
)
def resolve_base_url(args: argparse.Namespace) -> str:
    if args.base_url:
        return args.base_url.rstrip("/")
    return str(load_video_config()["base_url"]).rstrip("/")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", type=Path, default=DEFAULT_IMAGE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--duration", type=float, default=3.2)
    parser.add_argument("--fps", type=int, default=25)
    parser.add_argument("--width", type=int, default=576)
    parser.add_argument("--height", type=int, default=1024)
    parser.add_argument("--seed", type=int, default=918274)
    parser.add_argument("--poll-seconds", type=float, default=5.0)
    parser.add_argument("--timeout-seconds", type=int, default=1800)
    parser.add_argument(
        "--base-url",
        help="Override the configured endpoint, for example direct ComfyUI at http://host:8188.",
    )
    parser.add_argument(
        "--disable-person-face-gate",
        action="store_true",
        help="Disable the workflow's PersonFaceGate node for a direct-ComfyUI experiment.",
    )
    parser.add_argument("--prompt-id", help="Reattach to an already submitted GPU job without submitting again.")
    parser.add_argument("--submit-only", action="store_true", help="Submit once, save metadata, and exit immediately.")
    parser.add_argument("--prompt", default=DEFAULT_PROMPT)
    return parser.parse_args()


def duration_to_frames(duration: float, fps: int) -> int:
    if duration <= 0 or fps <= 0:
        raise ValueError("duration and fps must be positive")
    step = 8
    ideal = duration * fps
    return max(1, round((ideal - 1) / step)) * step + 1


def load_video_config() -> dict[str, Any]:
    config_path = Path.home() / ".story-claw" / "video_config.json"
    return json.loads(config_path.read_text(encoding="utf-8"))


def configure_workflow(args: argparse.Namespace) -> tuple[str, dict[str, Any], int]:
    base_url = resolve_base_url(args)
    workflow = json.loads(DEFAULT_WORKFLOW.read_text(encoding="utf-8"))
    image_path = args.image.resolve()
    if not image_path.is_file():
        raise FileNotFoundError(image_path)
    if args.width % 32 or args.height % 32:
        raise ValueError("width and height must both be divisible by 32")

    frames = duration_to_frames(args.duration, args.fps)
    image_b64 = base64.b64encode(image_path.read_bytes()).decode("ascii")
    prompt = args.prompt
    workflow["324"]["inputs"]["base64_data"] = image_b64
    workflow["320:319"]["inputs"]["value"] = prompt
    workflow["320:312"]["inputs"]["value"] = args.width
    workflow["320:299"]["inputs"]["value"] = args.height
    workflow["320:295"]["inputs"]["length"] = frames
    workflow["320:305"]["inputs"]["frames_number"] = frames
    workflow["320:276"]["inputs"]["noise_seed"] = args.seed
    workflow["320:277"]["inputs"]["noise_seed"] = random.Random(args.seed).randrange(1, 2**53)
    if args.disable_person_face_gate and "gate12" in workflow:
        workflow["gate12"]["inputs"]["enabled"] = False
    workflow["75"]["inputs"]["filename_prefix"] = "avatar_idle_gpu/idle_blink_hair"
    return base_url, workflow, frames


def output_record(entry: dict[str, Any]) -> dict[str, Any] | None:
    node = entry.get("outputs", {}).get("75", {})
    records = node.get("videos") or node.get("images") or []
    return records[0] if records else None


def write_metadata(args: argparse.Namespace, prompt_id: str, frames: int) -> Path:
    output_path = args.output.resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    metadata = {
        "prompt_id": prompt_id,
        "image": str(args.image.resolve()),
        "output": str(output_path),
        "frames": frames,
        "fps": args.fps,
        "duration_seconds": frames / args.fps,
        "width": args.width,
        "height": args.height,
        "seed": args.seed,
        "prompt": args.prompt,
        "base_url": resolve_base_url(args),
        "person_face_gate_enabled": not args.disable_person_face_gate,
    }
    metadata_path = output_path.with_suffix(".json")
    metadata_path.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    return metadata_path


def run() -> None:
    args = parse_args()
    frames = duration_to_frames(args.duration, args.fps)
    base_url = resolve_base_url(args)
    session = requests.Session()
    session.trust_env = False
    if args.prompt_id:
        prompt_id = args.prompt_id
        print(f"reattached prompt_id={prompt_id}", flush=True)
    else:
        _, workflow, frames = configure_workflow(args)
        response = session.post(f"{base_url}/prompt", json={"prompt": workflow}, timeout=30)
        response.raise_for_status()
        prompt_id = str(response.json()["prompt_id"])
        metadata_path = write_metadata(args, prompt_id, frames)
        print(
            f"submitted prompt_id={prompt_id} frames={frames} duration={frames / args.fps:.2f}s metadata={metadata_path}",
            flush=True,
        )
        if args.submit_only:
            return

    deadline = time.monotonic() + args.timeout_seconds
    while time.monotonic() < deadline:
        time.sleep(args.poll_seconds)
        history_response = session.get(f"{base_url}/history/{prompt_id}", timeout=20)
        if not history_response.ok:
            continue
        entry = history_response.json().get(prompt_id)
        if not entry:
            continue
        status = str(entry.get("status", {}).get("status_str", ""))
        if status == "error":
            raise RuntimeError(json.dumps(entry.get("status", {}), ensure_ascii=False))
        record = output_record(entry)
        if record is None:
            print(f"status={status or 'running'}", flush=True)
            continue

        view_response = session.get(
            f"{base_url}/view",
            params={
                "filename": record["filename"],
                "subfolder": record.get("subfolder", ""),
                "type": record.get("type", "output"),
            },
            timeout=180,
        )
        view_response.raise_for_status()
        output_path = args.output.resolve()
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(view_response.content)
        write_metadata(args, prompt_id, frames)
        print(f"saved {output_path}", flush=True)
        return

    raise TimeoutError(f"generation did not finish within {args.timeout_seconds}s: {prompt_id}")


if __name__ == "__main__":
    run()
