#!/usr/bin/env python3
"""Render a lightweight, continuously animated 2D avatar mouth test."""

from __future__ import annotations

import argparse
import json
import math
import subprocess
import time
import wave
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter


MOUTH_CENTER = (300, 181)
SKIN_RGB = (252, 241, 233)
FPS = 25


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", type=Path, required=True)
    parser.add_argument("--audio", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--fps", type=int, default=FPS)
    parser.add_argument("--mouth-x", type=int, default=MOUTH_CENTER[0])
    parser.add_argument("--mouth-y", type=int, default=MOUTH_CENTER[1])
    return parser.parse_args()


def read_wav(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path), "rb") as wav:
        if wav.getnchannels() != 1 or wav.getsampwidth() != 2:
            raise ValueError("Only 16-bit mono WAV is supported in this prototype.")
        sample_rate = wav.getframerate()
        samples = np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2")
    return samples.astype(np.float32) / 32768.0, sample_rate


def quantile_span(values: np.ndarray, low: float, high: float) -> tuple[float, float]:
    lower = float(np.quantile(values, low))
    upper = float(np.quantile(values, high))
    return lower, max(upper, lower + 1e-6)


def smooth_curve(target: np.ndarray, fps: int, attack: float, release: float) -> np.ndarray:
    result = np.zeros_like(target)
    value = float(target[0]) if len(target) else 0.0
    dt = 1.0 / fps
    for index, desired in enumerate(target):
        tau = attack if desired > value else release
        alpha = 1.0 - math.exp(-dt / tau)
        value += (float(desired) - value) * alpha
        result[index] = value
    return result


def analyze_audio(samples: np.ndarray, sample_rate: int, fps: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Return continuous open, rounded, and wide controls for each video frame."""
    frame_count = math.ceil(len(samples) / sample_rate * fps)
    window = max(1, round(sample_rate * 0.045))
    rms = np.zeros(frame_count, dtype=np.float32)
    centroids = np.zeros(frame_count, dtype=np.float32)
    padded = np.pad(samples, (window, window), mode="constant")
    hann = np.hanning(window * 2).astype(np.float32)
    frequencies = np.fft.rfftfreq(window * 2, 1 / sample_rate)

    for index in range(frame_count):
        center = round(index / fps * sample_rate) + window
        chunk = padded[center - window : center + window] * hann
        rms[index] = float(np.sqrt(np.mean(chunk * chunk) + 1e-9))
        spectrum = np.abs(np.fft.rfft(chunk)) + 1e-8
        centroids[index] = float(np.sum(frequencies * spectrum) / np.sum(spectrum))

    rms_low, rms_high = quantile_span(rms, 0.18, 0.96)
    open_target = np.clip((rms - rms_low) / (rms_high - rms_low), 0.0, 1.0)
    open_target = np.where(open_target < 0.055, 0.0, open_target**0.72)

    voiced_centroids = centroids[open_target > 0.12]
    if len(voiced_centroids) < 4:
        centroid_low, centroid_high = 700.0, 2800.0
    else:
        centroid_low, centroid_high = quantile_span(voiced_centroids, 0.12, 0.90)
    centroid_normalized = np.clip(
        (centroids - centroid_low) / (centroid_high - centroid_low), 0.0, 1.0
    )

    # Low-frequency voiced moments bias toward O/U; high-frequency moments bias E/I.
    round_target = open_target * np.clip((0.55 - centroid_normalized) / 0.55, 0.0, 1.0)
    wide_target = open_target * np.clip((centroid_normalized - 0.42) / 0.58, 0.0, 1.0)

    return (
        smooth_curve(open_target, fps, attack=0.055, release=0.115),
        smooth_curve(round_target, fps, attack=0.070, release=0.140),
        smooth_curve(wide_target, fps, attack=0.075, release=0.150),
    )


def scale_box(box: tuple[float, float, float, float], scale: int) -> tuple[int, int, int, int]:
    return tuple(round(value * scale) for value in box)  # type: ignore[return-value]


def mouth_patch(open_amount: float, rounded: float, wide: float) -> Image.Image:
    """Create an antialiased mouth patch from continuous control values."""
    scale = 4
    patch_width, patch_height = 88, 58
    size = (patch_width * scale, patch_height * scale)
    center_x, center_y = patch_width * scale / 2, patch_height * scale / 2 + open_amount * scale
    patch = Image.new("RGBA", size, (0, 0, 0, 0))

    # Fade out the original small smile only while the driven mouth is opening.
    cover = Image.new("L", size, 0)
    cover_draw = ImageDraw.Draw(cover)
    cover_draw.ellipse(scale_box((17, 17, 71, 42), scale), fill=round(215 * min(1.0, open_amount * 1.65)))
    cover = cover.filter(ImageFilter.GaussianBlur(2.2 * scale))
    skin = Image.new("RGBA", size, (*SKIN_RGB, 0))
    skin.putalpha(cover)
    patch.alpha_composite(skin)

    if open_amount < 0.018:
        return patch.resize((patch_width, patch_height), Image.Resampling.LANCZOS)

    mouth_width = 29.0 + wide * 5.0 - rounded * 4.0
    mouth_height = 1.8 + open_amount * 13.2
    outer_width = mouth_width + 2.2
    outer_height = mouth_height + 2.0
    outer_box = (
        center_x / scale - outer_width / 2,
        center_y / scale - outer_height / 2,
        center_x / scale + outer_width / 2,
        center_y / scale + outer_height / 2,
    )
    inner_box = (
        center_x / scale - mouth_width / 2,
        center_y / scale - mouth_height / 2,
        center_x / scale + mouth_width / 2,
        center_y / scale + mouth_height / 2,
    )

    draw = ImageDraw.Draw(patch)
    draw.ellipse(scale_box(outer_box, scale), fill=(211, 139, 151, 220))
    draw.ellipse(scale_box(inner_box, scale), fill=(111, 55, 75, 245))

    # A restrained tooth/tongue treatment gives large vowel openings depth.
    if open_amount > 0.28:
        tooth_top = inner_box[1] + 0.6
        tooth_bottom = inner_box[1] + max(1.2, mouth_height * 0.42)
        tooth_box = (inner_box[0] + 2.3, tooth_top, inner_box[2] - 2.3, tooth_bottom)
        draw.ellipse(scale_box(tooth_box, scale), fill=(255, 252, 248, 208))
    if open_amount > 0.54:
        tongue_box = (
            inner_box[0] + 4.0,
            inner_box[1] + mouth_height * 0.58,
            inner_box[2] - 4.0,
            inner_box[3] - 0.7,
        )
        draw.ellipse(scale_box(tongue_box, scale), fill=(205, 100, 118, 205))

    # Redraw a thin upper lip after the inner-mouth layers.
    lip_y = center_y / scale - mouth_height * 0.24
    lip_left = center_x / scale - mouth_width * 0.47
    lip_right = center_x / scale + mouth_width * 0.47
    draw.line(
        [(round(lip_left * scale), round(lip_y * scale)), (round(center_x), round((lip_y - 0.85) * scale)), (round(lip_right * scale), round(lip_y * scale))],
        fill=(184, 104, 124, 165),
        width=max(2, scale),
        joint="curve",
    )
    return patch.resize((patch_width, patch_height), Image.Resampling.LANCZOS)


def render_frame(base: Image.Image, controls: tuple[float, float, float], mouth_x: int, mouth_y: int) -> Image.Image:
    frame = base.copy()
    patch = mouth_patch(*controls)
    frame.alpha_composite(patch, (mouth_x - patch.width // 2, mouth_y - patch.height // 2))
    return frame


def make_contact_sheet(frames: list[Image.Image], output: Path) -> None:
    if not frames:
        return
    thumb_width = 192
    thumb_height = round(frames[0].height * thumb_width / frames[0].width)
    sheet = Image.new("RGB", (thumb_width * len(frames), thumb_height), "white")
    for index, frame in enumerate(frames):
        thumb = frame.convert("RGB").resize((thumb_width, thumb_height), Image.Resampling.LANCZOS)
        sheet.paste(thumb, (thumb_width * index, 0))
    sheet.save(output)


def main() -> None:
    args = parse_args()
    if not args.image.is_file() or not args.audio.is_file():
        raise FileNotFoundError("The portrait image and WAV input must both exist.")
    args.output.parent.mkdir(parents=True, exist_ok=True)

    base = Image.open(args.image).convert("RGBA")
    samples, sample_rate = read_wav(args.audio)
    controls = analyze_audio(samples, sample_rate, args.fps)
    frame_count = len(controls[0])
    duration = len(samples) / sample_rate
    started = time.perf_counter()

    command = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{base.width}x{base.height}",
        "-r", str(args.fps), "-i", "-", "-i", str(args.audio),
        "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-shortest", str(args.output),
    ]
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    if process.stdin is None:
        raise RuntimeError("Could not open FFmpeg stdin.")

    contact_indices = np.linspace(0, max(0, frame_count - 1), 6, dtype=int)
    contact_set = set(int(index) for index in contact_indices)
    contact_frames: list[Image.Image] = []
    try:
        for index in range(frame_count):
            frame = render_frame(
                base,
                (float(controls[0][index]), float(controls[1][index]), float(controls[2][index])),
                args.mouth_x,
                args.mouth_y,
            )
            if index in contact_set:
                contact_frames.append(frame)
            process.stdin.write(frame.convert("RGB").tobytes())
        process.stdin.close()
        stderr = process.stderr.read().decode("utf-8", errors="replace") if process.stderr else ""
        return_code = process.wait()
    finally:
        if process.poll() is None:
            process.kill()

    if return_code != 0:
        raise RuntimeError(f"FFmpeg failed with exit code {return_code}: {stderr}")

    contact_path = args.output.with_name(f"{args.output.stem}_contact_sheet.png")
    make_contact_sheet(contact_frames, contact_path)
    elapsed = time.perf_counter() - started
    metrics = {
        "renderer": "acoustic_smooth_v1",
        "gpu_used": False,
        "image": str(args.image.resolve()),
        "audio": str(args.audio.resolve()),
        "output": str(args.output.resolve()),
        "fps": args.fps,
        "frame_count": frame_count,
        "audio_duration_sec": round(duration, 3),
        "render_elapsed_sec": round(elapsed, 3),
        "render_realtime_factor": round(elapsed / duration, 3),
        "mouth_center": [args.mouth_x, args.mouth_y],
        "control_ranges": {
            "open": [round(float(controls[0].min()), 3), round(float(controls[0].max()), 3)],
            "rounded": [round(float(controls[1].min()), 3), round(float(controls[1].max()), 3)],
            "wide": [round(float(controls[2].min()), 3), round(float(controls[2].max()), 3)],
        },
    }
    metrics_path = args.output.with_name(f"{args.output.stem}_metrics.json")
    metrics_path.write_text(json.dumps(metrics, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(metrics, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
