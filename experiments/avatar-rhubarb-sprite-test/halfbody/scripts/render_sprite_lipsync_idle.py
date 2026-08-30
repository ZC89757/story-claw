#!/usr/bin/env python3
"""Render the sprite lip-sync experiment with local blink and hair idle motion."""

from __future__ import annotations

import argparse
import json
import math
import random
import subprocess
import sys
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import render_sprite_lipsync as lipsync


EYE_CROP = (196, 449, 419, 493)
# The Image2 eye variants are not registered to the base portrait perfectly.
# These target boxes fully cover the original upper lashes without touching eyebrows.
EYE_PATCH_BOXES = ((201, 444, 291, 492), (324, 444, 418, 492))
# A positive offset samples earlier source rows, moving the generated eye downward.
CLOSED_EYE_SOURCE_Y_OFFSETS = (10, 9)
HALF_EYE_SOURCE_Y_OFFSETS = (-13, -13)
EYE_BOUNDS = ((204, 450, 284, 487), (329, 450, 411, 487))
EYELID_LINES = (
    ((210, 468), (244, 478), (279, 468)),
    ((335, 468), (370, 478), (405, 468)),
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--audio", type=Path, required=True)
    parser.add_argument("--cue-json", type=Path, required=True)
    parser.add_argument("--vendor-root", type=Path, required=True)
    parser.add_argument("--pose-dir", type=Path)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--blink-source", type=Path)
    parser.add_argument("--blink-half-source", type=Path)
    parser.add_argument("--fps", type=int, default=25)
    parser.add_argument("--seed", type=int, default=17)
    return parser.parse_args()


def smoothstep(value: float) -> float:
    value = max(0.0, min(1.0, value))
    return value * value * (3.0 - 2.0 * value)


def bezier_points(start: tuple[int, int], control: tuple[int, int], end: tuple[int, int], count: int = 25) -> list[tuple[int, int]]:
    points: list[tuple[int, int]] = []
    for index in range(count):
        t = index / (count - 1)
        inverse = 1.0 - t
        x = inverse * inverse * start[0] + 2.0 * inverse * t * control[0] + t * t * end[0]
        y = inverse * inverse * start[1] + 2.0 * inverse * t * control[1] + t * t * end[1]
        points.append((round(x), round(y)))
    return points


def make_closed_eye_patch(base_image: Image.Image) -> Image.Image:
    """Make a small closed-eye source patch without changing face or hair contours."""
    base = base_image.convert("RGB")
    fill_layer = base.copy()
    mask = Image.new("L", base.size, 0)
    mask_draw = ImageDraw.Draw(mask)

    for x1, y1, x2, y2 in EYE_BOUNDS:
        # A narrow strip under the eye carries the local face color and lighting.
        skin_strip = base.crop((x1, y2 + 4, x2, y2 + 12)).resize((x2 - x1, y2 - y1), Image.Resampling.BICUBIC)
        skin_strip = skin_strip.filter(ImageFilter.GaussianBlur(1.0))
        fill_layer.paste(skin_strip, (x1, y1))
        mask_draw.ellipse((x1, y1, x2, y2), fill=255)

    mask = mask.filter(ImageFilter.GaussianBlur(1.35))
    closed = Image.composite(fill_layer, base, mask)
    eye_draw = ImageDraw.Draw(closed)
    lash_color = (62, 43, 66)
    for start, control, end in EYELID_LINES:
        points = bezier_points(start, control, end)
        eye_draw.line(points, fill=lash_color, width=2, joint="curve")
        eye_draw.line([points[0], (points[0][0] - 4, points[0][1] - 1)], fill=lash_color, width=2)
        eye_draw.line([points[-1], (points[-1][0] + 4, points[-1][1] - 1)], fill=lash_color, width=2)

    return closed.crop(EYE_CROP)


def load_generated_eye_patch(path: Path, target_size: tuple[int, int]) -> tuple[Image.Image, Image.Image]:
    generated = Image.open(path.resolve()).convert("RGB")
    if generated.size != target_size:
        generated = generated.resize(target_size, Image.Resampling.LANCZOS)
    return generated, generated.crop(EYE_CROP)


def extract_eye_patches(generated: Image.Image, source_y_offsets: tuple[int, int]) -> tuple[Image.Image, ...]:
    """Crop each generated eye after its small vertical registration correction."""
    patches: list[Image.Image] = []
    for (x1, y1, x2, y2), offset in zip(EYE_PATCH_BOXES, source_y_offsets):
        source_box = (x1, y1 - offset, x2, y2 - offset)
        patches.append(generated.crop(source_box))
    return tuple(patches)


def build_blink_events(duration: float, seed: int) -> list[dict[str, float]]:
    rng = random.Random(seed)
    events: list[dict[str, float]] = []
    start = 1.05 + rng.uniform(0.0, 0.55)
    while start + 0.25 < duration:
        close = rng.uniform(0.18, 0.22)
        hold = rng.uniform(0.02, 0.04)
        reopen = rng.uniform(0.20, 0.24)
        events.append(
            {
                "start": round(start, 4),
                "close": round(close, 4),
                "hold": round(hold, 4),
                "reopen": round(reopen, 4),
            }
        )
        start += rng.uniform(2.55, 3.85)
    return events


def blink_strength(events: list[dict[str, float]], seconds: float) -> float:
    strength = 0.0
    for event in events:
        start = event["start"]
        close_end = start + event["close"]
        hold_end = close_end + event["hold"]
        end = hold_end + event["reopen"]
        if seconds < start or seconds > end:
            continue
        if seconds <= close_end:
            value = smoothstep((seconds - start) / event["close"])
        elif seconds <= hold_end:
            value = 1.0
        else:
            value = 1.0 - smoothstep((seconds - hold_end) / event["reopen"])
        strength = max(strength, value)
    return strength


def make_hair_mask(base_image: Image.Image) -> np.ndarray:
    pixels = np.asarray(base_image.convert("RGB"), dtype=np.int16)
    height, width, _ = pixels.shape
    y, x = np.indices((height, width))
    red, green, blue = pixels[:, :, 0], pixels[:, :, 1], pixels[:, :, 2]
    blue_hair = (blue > red + 10) & (blue > green - 18) & (blue < 245)
    upper_hair = (y >= 180) & (y < 515) & (x >= 65) & (x <= 515)
    side_hair = (y >= 430) & (y < 835) & ((x < 225) | (x > 350))
    face = (x >= 182) & (x <= 394) & (y >= 438) & (y <= 635)
    selected = blue_hair & (upper_hair | side_hair) & ~face
    raw_mask = Image.fromarray(np.where(selected, 255, 0).astype(np.uint8), mode="L")
    return np.asarray(raw_mask.filter(ImageFilter.GaussianBlur(1.25)), dtype=np.float32) / 255.0


class IdleAnimator:
    def __init__(self, base_image: Image.Image, half_eye_patches: tuple[Image.Image, ...], closed_eye_patches: tuple[Image.Image, ...], events: list[dict[str, float]]) -> None:
        self.half_eye_patches = tuple(patch.convert("RGB") for patch in half_eye_patches)
        self.closed_eye_patches = tuple(patch.convert("RGB") for patch in closed_eye_patches)
        self.events = events
        self.hair_mask = make_hair_mask(base_image)
        self.y, self.x = np.indices(self.hair_mask.shape)
        height, width = self.hair_mask.shape
        self.hair_taper = np.clip((self.y - 225) / 570.0, 0.0, 1.0)
        self.hair_side = np.where(self.x < width / 2, -1.0, 1.0)
        self.height = height
        self.width = width
        self.eye_masks: tuple[Image.Image, ...] = tuple(self._eye_mask(patch.size) for patch in self.half_eye_patches)

    @staticmethod
    def _eye_mask(size: tuple[int, int]) -> Image.Image:
        width, height = size
        mask = Image.new("L", size, 0)
        draw = ImageDraw.Draw(mask)
        # Keep the eye/lash area opaque. Feather only the outer skin transition.
        draw.rounded_rectangle((1, 1, width - 2, height - 2), radius=5, fill=255)
        return mask.filter(ImageFilter.GaussianBlur(0.8))

    def apply_hair_sway(self, image: Image.Image, seconds: float) -> Image.Image:
        pixels = np.asarray(image.convert("RGB"), dtype=np.float32)
        wave = np.sin(seconds * 2.0 * math.pi * 0.34 + self.y * 0.022 + (self.x > self.width / 2) * 0.65)
        displacement = 1.7 * self.hair_taper * self.hair_side * wave
        sample_x = np.clip(np.rint(self.x - displacement).astype(np.int32), 0, self.width - 1)
        shifted = pixels[self.y, sample_x]
        alpha = (self.hair_mask * (0.25 + 0.75 * self.hair_taper))[:, :, None]
        mixed = pixels * (1.0 - alpha) + shifted * alpha
        return Image.fromarray(np.clip(mixed, 0, 255).astype(np.uint8), mode="RGB")

    def apply_blink(self, image: Image.Image, seconds: float) -> Image.Image:
        amount = blink_strength(self.events, seconds)
        if amount < 0.20:
            return image
        result = image.copy()
        patches = self.closed_eye_patches if amount >= 0.999 else self.half_eye_patches
        for box, patch, mask in zip(EYE_PATCH_BOXES, patches, self.eye_masks):
            current = result.crop(box)
            result.paste(Image.composite(patch, current, mask), box[:2])
        return result

    def apply(self, image: Image.Image, seconds: float) -> Image.Image:
        return self.apply_blink(self.apply_hair_sway(image, seconds), seconds)


def encode_video(
    images: dict[str, Image.Image],
    cues: list[dict[str, float | str]],
    audio_path: Path,
    output_path: Path,
    qa_dir: Path,
    duration: float,
    fps: int,
    animator: IdleAnimator,
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
    qa_frames = {0, frame_count // 6, frame_count * 2 // 6, frame_count * 3 // 6, frame_count * 4 // 6, frame_count * 5 // 6, frame_count - 1}
    report: list[dict[str, Any]] = []
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    assert process.stdin is not None
    for frame_index in range(frame_count):
        seconds = (frame_index + 0.5) / fps
        weights = lipsync.cue_weights(cues, seconds)
        mouth_frame, contributing = lipsync.blend_pose_images(images, weights)
        frame = animator.apply(mouth_frame, seconds)
        process.stdin.write(frame.tobytes())
        if frame_index in qa_frames:
            frame.save(qa_dir / f"frame_{frame_index + 1:06d}.png")
        report.append(
            {
                "frame": frame_index + 1,
                "time": round(seconds, 5),
                "poses": contributing,
                "blink": round(blink_strength(animator.events, seconds), 5),
            }
        )
    process.stdin.close()
    stderr = process.stderr.read().decode("utf-8", errors="replace") if process.stderr else ""
    if process.wait() != 0:
        raise RuntimeError(f"ffmpeg encode failed: {stderr[-1500:]}")
    return report


def main() -> None:
    args = parse_args()
    root = args.root.resolve()
    output_dir = args.output_dir.resolve() if args.output_dir else root / "output" / "v3"
    output_dir.mkdir(parents=True, exist_ok=True)
    pose_dir = args.pose_dir.resolve() if args.pose_dir else root / "assets" / "composited-poses-v2"
    base_path = root / "assets" / "base" / "X_source.png"
    base_image = Image.open(base_path).convert("RGB")
    if args.blink_source:
        generated, closed_eye_patch = load_generated_eye_patch(args.blink_source, base_image.size)
        api_name = args.blink_source.stem
        patch_path = root / "assets" / "blink" / "patches" / f"{api_name}.png"
        scaled_path = root / "assets" / "blink" / "api-processed" / f"{api_name}_scaled.png"
        scaled_path.parent.mkdir(parents=True, exist_ok=True)
        generated.save(scaled_path)
        blink_source = "Image2 generated closed-eye portrait"
    else:
        closed_eye_patch = make_closed_eye_patch(base_image)
        generated = base_image.copy()
        generated.paste(closed_eye_patch, EYE_CROP[:2])
        patch_path = root / "assets" / "blink" / "patches" / "closed_local.png"
        blink_source = "local closed-eye fallback"
    patch_path.parent.mkdir(parents=True, exist_ok=True)
    closed_eye_patch.save(patch_path)
    closed_eye_patches = extract_eye_patches(generated, CLOSED_EYE_SOURCE_Y_OFFSETS)
    if args.blink_half_source:
        half_generated, half_eye_patch = load_generated_eye_patch(args.blink_half_source, base_image.size)
        half_name = args.blink_half_source.stem
        half_patch_path = root / "assets" / "blink" / "patches" / f"{half_name}.png"
        half_scaled_path = root / "assets" / "blink" / "api-processed" / f"{half_name}_scaled.png"
        half_scaled_path.parent.mkdir(parents=True, exist_ok=True)
        half_generated.save(half_scaled_path)
        half_patch_path.parent.mkdir(parents=True, exist_ok=True)
        half_eye_patch.save(half_patch_path)
        blink_source += " + Image2 generated half-closed portrait"
        half_eye_patches = extract_eye_patches(half_generated, HALF_EYE_SOURCE_Y_OFFSETS)
    else:
        half_eye_patch = closed_eye_patch
        half_eye_patches = closed_eye_patches

    payload = json.loads(args.cue_json.read_text(encoding="utf-8"))
    cue_frames, optimization = lipsync.load_upstream_cues(payload, args.vendor_root.resolve(), args.fps)
    cues = lipsync.cue_windows(cue_frames, args.fps)
    images = lipsync.load_pose_images(pose_dir)
    duration = lipsync.wave_duration(args.audio)
    events = build_blink_events(duration, args.seed)
    animator = IdleAnimator(base_image, half_eye_patches, closed_eye_patches, events)
    video_path = output_dir / "avatar_sprite_lipsync_idle.mp4"
    frames = encode_video(images, cues, args.audio.resolve(), video_path, output_dir / "qa_frames", duration, args.fps, animator)
    contact_sheet = output_dir / "avatar_sprite_lipsync_idle_contact_sheet.png"
    lipsync.make_video_contact_sheet(video_path, contact_sheet)
    timeline = {
        "source": "Rhubarb cues + local blink and local hair sway",
        "blink_source": blink_source,
        "audio": str(args.audio.resolve()),
        "fps": args.fps,
        "blink_events": events,
        "eye_crop": {"x": EYE_CROP[0], "y": EYE_CROP[1], "width": EYE_CROP[2] - EYE_CROP[0], "height": EYE_CROP[3] - EYE_CROP[1]},
        "eye_patch_boxes": EYE_PATCH_BOXES,
        "closed_eye_source_y_offsets": CLOSED_EYE_SOURCE_Y_OFFSETS,
        "half_eye_source_y_offsets": HALF_EYE_SOURCE_Y_OFFSETS,
        "hair_motion": {"max_displacement_px": 1.7, "frequency_hz": 0.34},
        "optimization": optimization,
        "cues": cues,
        "frames": frames,
    }
    (output_dir / "idle_timeline.json").write_text(json.dumps(timeline, indent=2) + "\n", encoding="utf-8")
    metrics = {
        "renderer": "Pillow mouth blend + local blink patch + local hair sway + FFmpeg",
        "audio_duration_sec": round(duration, 3),
        "fps": args.fps,
        "frame_count": len(frames),
        "video": str(video_path),
        "contact_sheet": str(contact_sheet),
        "blink_patch": str(patch_path),
    }
    (output_dir / "metrics.json").write_text(json.dumps(metrics, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(metrics, indent=2))


if __name__ == "__main__":
    main()
