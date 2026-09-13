"""Remove a flat chroma background and write a validated transparent PNG.

This is intentionally small and deterministic.  The template asks the image
model for a vivid green, shadow-free plate; the helper flood-fills only pixels
connected to the image border, which avoids deleting isolated green details in
the subject itself.  A narrow distance band keeps antialiased silhouette edges
soft while suppressing green spill.
"""

from __future__ import annotations

import argparse
import math
from collections import deque
from pathlib import Path

from PIL import Image


def parse_color(value: str) -> tuple[int, int, int]:
    value = value.strip().lstrip("#")
    if len(value) != 6:
        raise ValueError("background color must be #RRGGBB")
    return tuple(int(value[index : index + 2], 16) for index in (0, 2, 4))  # type: ignore[return-value]


def color_distance(rgb: tuple[int, int, int], key: tuple[int, int, int]) -> float:
    return math.sqrt(sum((float(channel) - float(target)) ** 2 for channel, target in zip(rgb, key)))


def connected_background(
    pixels: list[tuple[int, int, int, int]],
    width: int,
    height: int,
    key: tuple[int, int, int],
    threshold: float,
) -> bytearray:
    mask = bytearray(width * height)
    queue: deque[int] = deque()

    def add(index: int) -> None:
        if mask[index]:
            return
        rgb = pixels[index][:3]
        if pixels[index][3] == 0 or color_distance(rgb, key) <= threshold:
            mask[index] = 1
            queue.append(index)

    for x in range(width):
        add(x)
        add((height - 1) * width + x)
    for y in range(height):
        add(y * width)
        add(y * width + width - 1)

    while queue:
        index = queue.popleft()
        x = index % width
        y = index // width
        if x:
            add(index - 1)
        if x + 1 < width:
            add(index + 1)
        if y:
            add(index - width)
        if y + 1 < height:
            add(index + width)
    return mask


def remove_background(
    input_path: Path,
    output_path: Path,
    key: tuple[int, int, int],
) -> None:
    with Image.open(input_path) as source:
        image = source.convert("RGBA")
    width, height = image.size
    if width < 2 or height < 2:
        raise ValueError("image is too small")
    pixels = list(image.getdata())

    # A generous flood threshold removes model-generated green shadows while
    # remaining restricted to the background connected to the border.
    flood = connected_background(pixels, width, height, key, threshold=205.0)
    # Image models usually render the requested #00ff00 plate as a slightly
    # darker/uneven green (often distance 80-100 from the key color).  Keep
    # the flood-fill connected to the border, but make the hard cutoff wide
    # enough to remove that entire background instead of leaving an opaque
    # green border that is later rejected as a failed cutout.
    hard = 110.0
    feather = 68.0
    result: list[tuple[int, int, int, int]] = []
    for index, (red, green, blue, alpha) in enumerate(pixels):
        rgb = (red, green, blue)
        distance = color_distance(rgb, key)
        if flood[index]:
            if distance <= hard:
                new_alpha = 0
            elif distance < hard + feather:
                new_alpha = int(round(alpha * (distance - hard) / feather))
            else:
                new_alpha = alpha
        else:
            new_alpha = alpha

        # Remove the green fringe left by antialiasing without recoloring the
        # interior of the subject.
        if new_alpha and flood[index] and distance < hard + feather * 1.8:
            green_cap = min(255, int((red + blue) / 2 + 30))
            green = min(green, green_cap)
        result.append((red, green, blue, max(0, min(255, new_alpha))))

    visible = [index for index, pixel in enumerate(result) if pixel[3] >= 16]
    if len(visible) < max(1, int(width * height * 0.01)):
        raise ValueError("cutout is almost fully transparent")
    border = [
        result[x] for x in range(width)
    ] + [
        result[(height - 1) * width + x] for x in range(width)
    ] + [
        result[y * width] for y in range(height)
    ] + [
        result[y * width + width - 1] for y in range(height)
    ]
    transparent_border = sum(pixel[3] < 16 for pixel in border) / max(1, len(border))
    if transparent_border < 0.55:
        raise ValueError(f"cutout border is not transparent enough ({transparent_border:.2%})")

    output = Image.new("RGBA", (width, height))
    output.putdata(result)
    output.save(output_path, format="PNG", optimize=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input")
    parser.add_argument("output")
    parser.add_argument("--color", default="#00ff00")
    args = parser.parse_args()
    remove_background(Path(args.input), Path(args.output), parse_color(args.color))


if __name__ == "__main__":
    main()
