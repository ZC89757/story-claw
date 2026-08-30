#!/usr/bin/env python3
"""Compose full-frame blink clips first, then overlay Rhubarb-driven mouth poses."""

from __future__ import annotations

import argparse
import json
import random
import subprocess
import sys
from pathlib import Path
from typing import Any, BinaryIO

from PIL import Image


SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import render_sprite_lipsync as lipsync


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--audio", type=Path, required=True)
    parser.add_argument("--cue-json", type=Path, required=True)
    parser.add_argument("--vendor-root", type=Path, required=True)
    parser.add_argument("--blink-video", type=Path, required=True)
    parser.add_argument("--pose-dir", type=Path)
    parser.add_argument("--base-image", type=Path)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--fps", type=int, default=25)
    parser.add_argument("--seed", type=int, default=17)
    parser.add_argument("--blink-gap-min", type=float, default=2.0)
    parser.add_argument("--blink-gap-max", type=float, default=3.0)
    return parser.parse_args()


def run_command(command: list[str]) -> None:
    completed = subprocess.run(command, capture_output=True, text=True, check=False)
    if completed.returncode:
        raise RuntimeError(f"command failed: {' '.join(command)}\n{completed.stderr[-1600:]}")


def probe_duration(path: Path) -> float:
    command = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        str(path),
    ]
    completed = subprocess.run(command, capture_output=True, text=True, check=False)
    if completed.returncode:
        raise RuntimeError(f"ffprobe failed for {path}: {completed.stderr[-800:]}")
    duration = float(completed.stdout.strip())
    if duration <= 0:
        raise ValueError(f"invalid duration for {path}")
    return duration


def build_blink_events(
    duration: float,
    blink_duration: float,
    gap_min: float,
    gap_max: float,
    seed: int,
) -> list[dict[str, float]]:
    if gap_min <= 0 or gap_max < gap_min:
        raise ValueError("blink gap must be positive and ordered")
    rng = random.Random(seed)
    events: list[dict[str, float]] = []
    start = 1.15 + rng.uniform(0.0, 0.35)
    while start + blink_duration <= duration - 0.1:
        events.append({"start": round(start, 4), "duration": round(blink_duration, 4)})
        start += rng.uniform(gap_min, gap_max)
    return events


def make_blink_base(
    base_image: Path,
    blink_video: Path,
    events: list[dict[str, float]],
    duration: float,
    fps: int,
    output: Path,
) -> None:
    command = [
        "ffmpeg",
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-loop",
        "1",
        "-framerate",
        str(fps),
        "-i",
        str(base_image),
    ]
    for _event in events:
        command.extend(["-i", str(blink_video)])

    filters = [f"[0:v]trim=duration={duration:.6f},setpts=PTS-STARTPTS[base]"]
    current = "[base]"
    for index, event in enumerate(events):
        blink = f"blink{index}"
        stage = f"stage{index}"
        filters.append(
            f"[{index + 1}:v]setpts=PTS-STARTPTS+{float(event['start']):.6f}/TB[{blink}]"
        )
        filters.append(
            f"{current}[{blink}]overlay=0:0:eof_action=pass:repeatlast=0:shortest=0[{stage}]"
        )
        current = f"[{stage}]"
    filters.append(f"{current}format=yuv420p[out]")
    command.extend(
        [
            "-filter_complex",
            ";".join(filters),
            "-map",
            "[out]",
            "-t",
            f"{duration:.6f}",
            "-r",
            str(fps),
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "slow",
            "-crf",
            "0",
            "-pix_fmt",
            "yuv420p",
            str(output),
        ]
    )
    run_command(command)


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


def overlay_mouth_on_blink_base(
    blink_base: Path,
    audio: Path,
    images: dict[str, Image.Image],
    cues: list[dict[str, float | str]],
    duration: float,
    fps: int,
    output: Path,
) -> dict[str, Any]:
    base_image = next(iter(images.values()))
    width, height = base_image.size
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

    pose_counts: dict[str, int] = {key: 0 for key in lipsync.POSE_KEYS}
    try:
        for frame_index in range(frame_count):
            raw_frame = read_exact(reader.stdout, frame_bytes)
            if len(raw_frame) != frame_bytes:
                raise RuntimeError(
                    f"blink base ended at frame {frame_index + 1}; expected {frame_count} frames"
                )
            seconds = (frame_index + 0.5) / fps
            weights = lipsync.cue_weights(cues, seconds)
            mouth_frame, contributing = lipsync.blend_pose_images(images, weights)
            for pose in contributing:
                pose_counts[str(pose["key"])] += 1
            frame = Image.frombytes("RGB", (width, height), raw_frame)
            frame.paste(mouth_frame.crop(mouth_box), mouth_box[:2])
            writer.stdin.write(frame.tobytes())
    finally:
        writer.stdin.close()

    writer_stderr = writer.stderr.read().decode("utf-8", errors="replace") if writer.stderr else ""
    reader_stderr = reader.stderr.read().decode("utf-8", errors="replace") if reader.stderr else ""
    writer_status = writer.wait()
    reader_status = reader.wait()
    if reader_status:
        raise RuntimeError(f"blink base decode failed: {reader_stderr[-1600:]}")
    if writer_status:
        raise RuntimeError(f"final encode failed: {writer_stderr[-1600:]}")
    return {"frame_count": frame_count, "pose_frame_counts": pose_counts, "mouth_box": crop}


def main() -> None:
    args = parse_args()
    root = args.root.expanduser().resolve()
    audio = args.audio.expanduser().resolve()
    cue_json = args.cue_json.expanduser().resolve()
    vendor_root = args.vendor_root.expanduser().resolve()
    blink_video = args.blink_video.expanduser().resolve()
    for path in (audio, cue_json, blink_video):
        if not path.is_file():
            raise FileNotFoundError(path)
    if not vendor_root.is_dir():
        raise FileNotFoundError(vendor_root)

    pose_dir = (
        args.pose_dir.expanduser().resolve()
        if args.pose_dir
        else root / "assets" / "composited-poses-v2"
    )
    base_image = (
        args.base_image.expanduser().resolve()
        if args.base_image
        else root / "assets" / "base" / "X_source.png"
    )
    output_dir = (
        args.output_dir.expanduser().resolve()
        if args.output_dir
        else root / "output" / "v10-video-blinks"
    )
    if not base_image.is_file():
        raise FileNotFoundError(base_image)
    output_dir.mkdir(parents=True, exist_ok=True)

    payload = json.loads(cue_json.read_text(encoding="utf-8"))
    cue_frames, optimization = lipsync.load_upstream_cues(payload, vendor_root, args.fps)
    cues = lipsync.cue_windows(cue_frames, args.fps)
    pose_images = lipsync.load_pose_images(pose_dir)
    duration = lipsync.wave_duration(audio)
    blink_duration = probe_duration(blink_video)
    events = build_blink_events(
        duration,
        blink_duration,
        args.blink_gap_min,
        args.blink_gap_max,
        args.seed,
    )
    if not events:
        raise RuntimeError("audio is too short to place a full blink video")

    blink_base = output_dir / "blink_base.mp4"
    final_video = output_dir / "avatar_sprite_lipsync_full_blinks.mp4"
    make_blink_base(base_image, blink_video, events, duration, args.fps, blink_base)
    mouth_report = overlay_mouth_on_blink_base(
        blink_base,
        audio,
        pose_images,
        cues,
        duration,
        args.fps,
        final_video,
    )
    timeline = {
        "pipeline": "full-frame blink clips first, mouth-only overlay second",
        "audio": str(audio),
        "blink_video": str(blink_video),
        "blink_video_duration_seconds": blink_duration,
        "blink_events": events,
        "mouth_cue_count": len(cues),
        "mouth_box": mouth_report["mouth_box"],
        "fps": args.fps,
        "duration_seconds": duration,
        "rhubarb_optimization": optimization,
    }
    (output_dir / "timeline.json").write_text(
        json.dumps(timeline, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    metrics = {
        "renderer": "FFmpeg full-frame blink concat + Pillow mouth-only overlay + FFmpeg",
        "audio_duration_seconds": round(duration, 3),
        "fps": args.fps,
        "frame_count": mouth_report["frame_count"],
        "blink_count": len(events),
        "blink_base": str(blink_base),
        "final_video": str(final_video),
    }
    (output_dir / "metrics.json").write_text(
        json.dumps(metrics, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(metrics, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
