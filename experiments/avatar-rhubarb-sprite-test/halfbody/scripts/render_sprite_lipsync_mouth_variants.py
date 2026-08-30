#!/usr/bin/env python3
"""Render no-crossfade mouth-transition variants over an existing blink base video."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any, BinaryIO

from PIL import Image, ImageFilter


SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import render_sprite_lipsync as lipsync


VARIANTS = ("dominant", "hysteresis", "neutral_bridge", "motion_blur")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--blink-base", required=True, type=Path)
    parser.add_argument("--audio", required=True, type=Path)
    parser.add_argument("--cue-json", required=True, type=Path)
    parser.add_argument("--vendor-root", required=True, type=Path)
    parser.add_argument("--pose-dir", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--fps", type=int, default=25)
    return parser.parse_args()


def read_exact(stream: BinaryIO, byte_count: int) -> bytes:
    chunks: list[bytes] = []
    remaining = byte_count
    while remaining:
        chunk = stream.read(remaining)
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def dominant_key(weights: dict[str, float]) -> str:
    return max(lipsync.POSE_KEYS, key=lambda key: weights[key])


class HysteresisSelector:
    """Wait two consecutive frames before accepting a new target pose."""

    def __init__(self) -> None:
        self.current = "X"
        self.pending: str | None = None
        self.pending_frames = 0

    def select(self, target: str) -> tuple[str, bool]:
        changed = False
        if target == self.current:
            self.pending = None
            self.pending_frames = 0
            return self.current, changed
        if target != self.pending:
            self.pending = target
            self.pending_frames = 1
            return self.current, changed
        self.pending_frames += 1
        if self.pending_frames >= 2:
            self.current = target
            self.pending = None
            self.pending_frames = 0
            changed = True
        return self.current, changed


class NeutralBridgeSelector:
    """Insert a single B pose before a large direct sprite transition."""

    def __init__(self) -> None:
        self.current = "X"
        self.queued_target: str | None = None

    @staticmethod
    def needs_bridge(current: str, target: str) -> bool:
        return current != target and current != "B" and target != "B"

    def select(self, target: str) -> tuple[str, bool]:
        if self.queued_target is not None:
            if target != self.queued_target:
                self.queued_target = target
                return "B", False
            self.current = target
            self.queued_target = None
            return self.current, True
        if not self.needs_bridge(self.current, target):
            changed = target != self.current
            self.current = target
            return self.current, changed
        self.queued_target = target
        return "B", True


def render_variant(
    variant: str,
    blink_base: Path,
    audio: Path,
    images: dict[str, Image.Image],
    cues: list[dict[str, float | str]],
    duration: float,
    fps: int,
    output: Path,
) -> dict[str, Any]:
    width, height = next(iter(images.values())).size
    frame_count = round(duration * fps)
    frame_bytes = width * height * 3
    crop = lipsync.CROP
    mouth_box = (crop["x"], crop["y"], crop["x"] + crop["width"], crop["y"] + crop["height"])
    reader = subprocess.Popen(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(blink_base),
            "-map",
            "0:v:0",
            "-frames:v",
            str(frame_count),
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    writer = subprocess.Popen(
        [
            "ffmpeg",
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-s:v",
            f"{width}x{height}",
            "-r",
            str(fps),
            "-i",
            "-",
            "-i",
            str(audio),
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
            "-c:v",
            "libx264",
            "-preset",
            "slow",
            "-crf",
            "0",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-shortest",
            str(output),
        ],
        stdin=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    assert reader.stdout is not None and writer.stdin is not None
    hysteresis = HysteresisSelector()
    bridge = NeutralBridgeSelector()
    previous_key = "X"
    switch_count = 0
    pose_frame_counts = {key: 0 for key in lipsync.POSE_KEYS}

    try:
        for frame_index in range(frame_count):
            raw_frame = read_exact(reader.stdout, frame_bytes)
            if len(raw_frame) != frame_bytes:
                raise RuntimeError(
                    f"blink base ended at frame {frame_index + 1}; expected {frame_count} frames"
                )
            weights = lipsync.cue_weights(cues, (frame_index + 0.5) / fps)
            target = dominant_key(weights)
            if variant == "dominant":
                key = target
                changed = key != previous_key
            elif variant == "hysteresis":
                key, changed = hysteresis.select(target)
            elif variant == "neutral_bridge":
                key, changed = bridge.select(target)
            elif variant == "motion_blur":
                key = target
                changed = key != previous_key
            else:
                raise ValueError(f"unknown variant: {variant}")

            patch = images[key].crop(mouth_box)
            if variant == "motion_blur" and changed:
                patch = patch.filter(ImageFilter.GaussianBlur(radius=0.8))
            frame = Image.frombytes("RGB", (width, height), raw_frame)
            frame.paste(patch, mouth_box[:2])
            writer.stdin.write(frame.tobytes())
            pose_frame_counts[key] += 1
            switch_count += int(changed)
            previous_key = key
    finally:
        writer.stdin.close()

    writer_stderr = writer.stderr.read().decode("utf-8", errors="replace") if writer.stderr else ""
    reader_stderr = reader.stderr.read().decode("utf-8", errors="replace") if reader.stderr else ""
    writer_status = writer.wait()
    reader_status = reader.wait()
    if reader_status:
        raise RuntimeError(f"blink base decode failed: {reader_stderr[-1600:]}")
    if writer_status:
        raise RuntimeError(f"variant encode failed: {writer_stderr[-1600:]}")
    return {
        "variant": variant,
        "video": str(output.resolve()),
        "frame_count": frame_count,
        "switch_count": switch_count,
        "pose_frame_counts": pose_frame_counts,
        "pixel_crossfade": False,
    }


def main() -> None:
    args = parse_args()
    blink_base = args.blink_base.expanduser().resolve()
    audio = args.audio.expanduser().resolve()
    cue_json = args.cue_json.expanduser().resolve()
    vendor_root = args.vendor_root.expanduser().resolve()
    pose_dir = args.pose_dir.expanduser().resolve()
    output_dir = args.output_dir.expanduser().resolve()
    for path in (blink_base, audio, cue_json):
        if not path.is_file():
            raise FileNotFoundError(path)
    if not vendor_root.is_dir() or not pose_dir.is_dir():
        raise FileNotFoundError("vendor root or pose directory is missing")
    output_dir.mkdir(parents=True, exist_ok=True)

    payload = json.loads(cue_json.read_text(encoding="utf-8"))
    cue_frames, optimization = lipsync.load_upstream_cues(payload, vendor_root, args.fps)
    cues = lipsync.cue_windows(cue_frames, args.fps)
    images = lipsync.load_pose_images(pose_dir)
    duration = lipsync.wave_duration(audio)
    records = [
        render_variant(
            variant,
            blink_base,
            audio,
            images,
            cues,
            duration,
            args.fps,
            output_dir / f"avatar_sprite_lipsync_{variant}.mp4",
        )
        for variant in VARIANTS
    ]
    manifest = {
        "blink_base": str(blink_base),
        "audio": str(audio),
        "fps": args.fps,
        "duration_seconds": duration,
        "rhubarb_optimization": optimization,
        "mouth_box": lipsync.CROP,
        "records": records,
    }
    manifest_path = output_dir / "variant_manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
