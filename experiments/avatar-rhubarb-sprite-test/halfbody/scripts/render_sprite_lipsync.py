#!/usr/bin/env python3
"""Render a 2D mouth-patch avatar using Rhubarb Lip Sync NG cue timing."""

from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
import types
import wave
from pathlib import Path
from typing import Any

from PIL import Image


POSE_KEYS = ("A", "B", "C", "D", "E", "F", "G", "H", "X")
BLEND_RATIO = 0.52
CROP = {"x": 256, "y": 530, "width": 104, "height": 60}
POSE_DESCRIPTIONS = {
    "X": "rest / pause",
    "A": "closed lips, p/b/m",
    "B": "slightly open, consonant / ee",
    "C": "ordinary open mouth",
    "D": "wide a-like vowel",
    "E": "rounded o/er-like vowel",
    "F": "puckered u/w",
    "G": "upper teeth on lower lip, f/v",
    "H": "raised tongue, l",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--audio", type=Path, required=True)
    parser.add_argument("--cue-json", type=Path, required=True)
    parser.add_argument("--vendor-root", type=Path, required=True)
    parser.add_argument("--pose-dir", type=Path)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--fps", type=int, default=25)
    return parser.parse_args()


def wave_duration(path: Path) -> float:
    with wave.open(str(path), "rb") as source:
        return source.getnframes() / source.getframerate()


def import_upstream_rhubarb(vendor_root: Path) -> tuple[Any, Any, Any, Any]:
    """Load only Rhubarb modules, bypassing the addon's Blender-only root init."""
    package_root = vendor_root / "rhubarb_lipsync"
    package = types.ModuleType("rhubarb_lipsync")
    package.__path__ = [str(package_root)]
    sys.modules["rhubarb_lipsync"] = package
    subpackage = types.ModuleType("rhubarb_lipsync.rhubarb")
    subpackage.__path__ = [str(package_root / "rhubarb")]
    sys.modules["rhubarb_lipsync.rhubarb"] = subpackage

    from rhubarb_lipsync.rhubarb.cue_processor import CueProcessor
    from rhubarb_lipsync.rhubarb.mouth_cues import FrameConfig, MouthCueFrames
    from rhubarb_lipsync.rhubarb.rhubarb_command import RhubarbParser

    return CueProcessor, FrameConfig, MouthCueFrames, RhubarbParser


def load_upstream_cues(payload: dict[str, Any], vendor_root: Path, fps: int) -> tuple[list[Any], str]:
    cue_processor_type, frame_config_type, mouth_cue_frames_type, parser_type = import_upstream_rhubarb(vendor_root)
    raw_cues = parser_type.lipsync_json2MouthCues(payload["mouthCues"])
    frame_config = frame_config_type(fps=fps)
    cue_frames = [mouth_cue_frames_type(cue, frame_config) for cue in raw_cues]
    processor = cue_processor_type(frame_cfg=frame_config, cue_frames=cue_frames, use_extended_shapes=True)
    report = processor.optimize_cues(max_cue_duration=0.24)
    return list(processor.cue_frames), report.strip()


def cue_windows(cue_frames: list[Any], fps: int) -> list[dict[str, float | str]]:
    windows: list[dict[str, float | str]] = []
    for cue_frame in cue_frames:
        key = cue_frame.cue.key
        windows.append(
            {
                "value": key if key in POSE_KEYS else "X",
                "start": float(cue_frame.cue.start),
                "end": float(cue_frame.cue.end),
                "middle_start": float(cue_frame.get_middle_start(BLEND_RATIO)),
                "middle_end": float(cue_frame.get_middle_end_frame_float(BLEND_RATIO) / fps),
            }
        )
    return windows


def smoothstep(value: float) -> float:
    value = max(0.0, min(1.0, value))
    return value * value * (3.0 - 2.0 * value)


def ramp(seconds: float, start: float, end: float) -> float:
    if end <= start + 1e-6:
        return 1.0 if seconds >= end else 0.0
    return smoothstep((seconds - start) / (end - start))


def cue_weights(cues: list[dict[str, float | str]], seconds: float) -> dict[str, float]:
    weights = {key: 0.0 for key in POSE_KEYS}
    for index, cue in enumerate(cues):
        previous = cues[index - 1] if index else None
        following = cues[index + 1] if index + 1 < len(cues) else None
        fade_in_start = float(previous["middle_end"]) if previous else float(cue["start"])
        fade_in_end = float(cue["middle_start"])
        fade_out_start = float(cue["middle_end"])
        fade_out_end = float(following["middle_start"]) if following else float(cue["end"])
        if seconds < fade_in_start or seconds > fade_out_end:
            continue
        if seconds < fade_in_end:
            weight = ramp(seconds, fade_in_start, fade_in_end)
        elif seconds > fade_out_start:
            weight = 1.0 - ramp(seconds, fade_out_start, fade_out_end)
        else:
            weight = 1.0
        weights[str(cue["value"])] += max(0.0, weight)
    total = sum(weights.values())
    if total <= 1e-8:
        weights["X"] = 1.0
        return weights
    return {key: value / total for key, value in weights.items()}


def load_pose_images(pose_dir: Path) -> dict[str, Image.Image]:
    images: dict[str, Image.Image] = {}
    expected_size: tuple[int, int] | None = None
    for key in POSE_KEYS:
        path = pose_dir / f"{key}.png"
        if not path.exists():
            raise FileNotFoundError(path)
        image = Image.open(path).convert("RGB")
        if expected_size is None:
            expected_size = image.size
        elif image.size != expected_size:
            raise ValueError(f"pose image size mismatch: {path} is {image.size}, expected {expected_size}")
        images[key] = image
    return images


def blend_pose_images(images: dict[str, Image.Image], weights: dict[str, float]) -> tuple[Image.Image, list[dict[str, float | str]]]:
    ranked = sorted(weights.items(), key=lambda item: item[1], reverse=True)
    primary_key, primary_weight = ranked[0]
    secondary_key, secondary_weight = ranked[1]
    total = primary_weight + secondary_weight
    if total <= 1e-8 or secondary_weight <= 1e-5:
        return images[primary_key].copy(), [{"key": primary_key, "weight": round(primary_weight, 5)}]
    alpha = secondary_weight / total
    return (
        Image.blend(images[primary_key], images[secondary_key], alpha),
        [
            {"key": primary_key, "weight": round(primary_weight, 5)},
            {"key": secondary_key, "weight": round(secondary_weight, 5)},
        ],
    )


def write_grid(paths: list[Path], output_path: Path, tile_size: tuple[int, int], columns: int = 3) -> None:
    tiles: list[Image.Image] = []
    for path in paths:
        image = Image.open(path).convert("RGB")
        image.thumbnail(tile_size, Image.Resampling.LANCZOS)
        tile = Image.new("RGB", tile_size, "white")
        offset = ((tile_size[0] - image.width) // 2, (tile_size[1] - image.height) // 2)
        tile.paste(image, offset)
        tiles.append(tile)
    rows = math.ceil(len(tiles) / columns)
    margin, gap = 8, 8
    canvas = Image.new(
        "RGB",
        (margin * 2 + columns * tile_size[0] + (columns - 1) * gap, margin * 2 + rows * tile_size[1] + (rows - 1) * gap),
        "white",
    )
    for index, tile in enumerate(tiles):
        x = margin + (index % columns) * (tile_size[0] + gap)
        y = margin + (index // columns) * (tile_size[1] + gap)
        canvas.paste(tile, (x, y))
    canvas.save(output_path)


def make_asset_indexes(root: Path) -> None:
    assets = root / "assets"
    contact_sheets = assets / "contact-sheets"
    contact_sheets.mkdir(parents=True, exist_ok=True)
    raw_paths = [assets / "image2-full" / f"{key}.png" for key in POSE_KEYS if key != "X"]
    patch_paths = [assets / "mouth-patches" / f"{key}.png" for key in POSE_KEYS]
    composite_paths = [assets / "composited-poses" / f"{key}.png" for key in POSE_KEYS]
    write_grid(raw_paths, contact_sheets / "image2-full.png", (192, 341))
    write_grid(patch_paths, contact_sheets / "mouth-patches.png", (208, 120))
    write_grid(composite_paths, contact_sheets / "composited-poses.png", (192, 341))
    manifest = {
        "base_image": "assets/base/X_source.png",
        "image2_full": {key: f"assets/image2-full/{key}.png" for key in POSE_KEYS if key != "X"},
        "mouth_patches": {key: f"assets/mouth-patches/{key}.png" for key in POSE_KEYS},
        "composited_poses": {key: f"assets/composited-poses/{key}.png" for key in POSE_KEYS},
        "crop": CROP,
        "poses": POSE_DESCRIPTIONS,
    }
    (assets / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


def encode_video(
    images: dict[str, Image.Image],
    cues: list[dict[str, float | str]],
    audio_path: Path,
    output_path: Path,
    qa_dir: Path,
    duration: float,
    fps: int,
) -> list[dict[str, Any]]:
    frame_count = round(duration * fps)
    first_image = next(iter(images.values()))
    width, height = first_image.size
    command = [
        "ffmpeg",
        "-y",
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
        str(audio_path),
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-shortest",
        str(output_path),
    ]
    qa_dir.mkdir(parents=True, exist_ok=True)
    qa_frames = {0, frame_count // 5, frame_count * 2 // 5, frame_count * 3 // 5, frame_count * 4 // 5, frame_count - 1}
    frame_report: list[dict[str, Any]] = []
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    assert process.stdin is not None
    for frame_index in range(frame_count):
        seconds = (frame_index + 0.5) / fps
        weights = cue_weights(cues, seconds)
        frame, contributing = blend_pose_images(images, weights)
        process.stdin.write(frame.tobytes())
        if frame_index in qa_frames:
            frame.save(qa_dir / f"frame_{frame_index + 1:06d}.png")
        frame_report.append({"frame": frame_index + 1, "time": round(seconds, 5), "poses": contributing})
    process.stdin.close()
    stderr = process.stderr.read().decode("utf-8", errors="replace") if process.stderr else ""
    if process.wait() != 0:
        raise RuntimeError(f"ffmpeg encode failed: {stderr[-1500:]}")
    return frame_report


def make_video_contact_sheet(video_path: Path, output_path: Path) -> None:
    command = [
        "ffmpeg",
        "-y",
        "-loglevel",
        "error",
        "-i",
        str(video_path),
        "-vf",
        "fps=1,scale=144:-1,tile=4x2",
        "-frames:v",
        "1",
        str(output_path),
    ]
    completed = subprocess.run(command, capture_output=True, text=True, check=False)
    if completed.returncode:
        raise RuntimeError(f"ffmpeg contact sheet failed: {completed.stderr[-1500:]}")


def main() -> None:
    args = parse_args()
    root = args.root.resolve()
    output_dir = args.output_dir.resolve() if args.output_dir else root / "output"
    output_dir.mkdir(parents=True, exist_ok=True)
    if args.pose_dir is None:
        make_asset_indexes(root)
    payload = json.loads(args.cue_json.read_text(encoding="utf-8"))
    cue_frames, optimization = load_upstream_cues(payload, args.vendor_root.resolve(), args.fps)
    cues = cue_windows(cue_frames, args.fps)
    pose_dir = args.pose_dir.resolve() if args.pose_dir else root / "assets" / "composited-poses"
    images = load_pose_images(pose_dir)
    duration = wave_duration(args.audio)
    video_path = output_dir / "avatar_sprite_lipsync.mp4"
    frame_report = encode_video(images, cues, args.audio.resolve(), video_path, output_dir / "qa_frames", duration, args.fps)
    contact_sheet = output_dir / "avatar_sprite_lipsync_contact_sheet.png"
    make_video_contact_sheet(video_path, contact_sheet)
    timeline = {
        "source": "Rhubarb Lip Sync NG RhubarbParser + CueProcessor",
        "audio": str(args.audio.resolve()),
        "fps": args.fps,
        "blend_ratio": BLEND_RATIO,
        "optimization": optimization,
        "cues": cues,
        "frames": frame_report,
    }
    (output_dir / "mouth_timeline.json").write_text(json.dumps(timeline, indent=2) + "\n", encoding="utf-8")
    metrics = {
        "renderer": "Pillow two-pose blend + FFmpeg",
        "timing": "Rhubarb Lip Sync NG CueProcessor",
        "audio_duration_sec": round(duration, 3),
        "fps": args.fps,
        "frame_count": len(frame_report),
        "video": str(video_path),
        "contact_sheet": str(contact_sheet),
    }
    (output_dir / "metrics.json").write_text(json.dumps(metrics, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(metrics, indent=2))


if __name__ == "__main__":
    main()
