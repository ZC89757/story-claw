#!/usr/bin/env python3
"""Render a continuous 2D mouth rig from Rhubarb Lip Sync NG cues in Blender."""

from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys
import time
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

import bpy


VISEME_KEYS = ("A", "B", "C", "D", "E", "F", "G", "H")
BLEND_RATIO = 0.52


@dataclass(frozen=True)
class MouthShape:
    width: float
    height: float
    center_y: float
    teeth_width: float
    teeth_height: float
    tongue_width: float
    tongue_height: float


# Measurements are in source-image pixels. The Basis is the idle X mouth.
MOUTH_SHAPES: dict[str, MouthShape] = {
    "X": MouthShape(20.0, 1.1, 0.0, 0.0, 0.0, 0.0, 0.0),
    "A": MouthShape(21.0, 1.6, -0.1, 0.0, 0.0, 0.0, 0.0),
    "B": MouthShape(22.5, 3.6, -0.4, 0.0, 0.0, 0.0, 0.0),
    "C": MouthShape(23.5, 8.3, -1.4, 14.0, 1.9, 12.0, 1.0),
    "D": MouthShape(24.5, 13.3, -2.5, 15.0, 2.7, 14.5, 2.4),
    "E": MouthShape(18.3, 9.4, -1.8, 10.0, 1.7, 10.0, 1.4),
    "F": MouthShape(13.6, 8.1, -1.2, 0.0, 0.0, 7.5, 1.2),
    "G": MouthShape(19.5, 6.1, -1.0, 12.5, 2.0, 8.5, 0.8),
    "H": MouthShape(21.5, 7.8, -1.4, 13.5, 1.9, 12.5, 1.8),
}


def parse_args() -> argparse.Namespace:
    config_path = os.environ.get("AVATAR_RENDER_CONFIG", "").strip()
    if config_path:
        payload = json.loads(Path(config_path).read_text(encoding="utf-8"))
        return argparse.Namespace(
            image=Path(payload["image"]),
            audio=Path(payload["audio"]),
            rhubarb=Path(payload["rhubarb"]),
            vendor_root=Path(payload["vendor_root"]),
            output_dir=Path(payload["output_dir"]),
            fps=int(payload.get("fps", 25)),
            mouth_x=float(payload.get("mouth_x", 300.0)),
            mouth_y=float(payload.get("mouth_y", 181.0)),
            frame_limit=int(payload.get("frame_limit", 0)),
        )
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", type=Path, required=True)
    parser.add_argument("--audio", type=Path, required=True)
    parser.add_argument("--rhubarb", type=Path, required=True)
    parser.add_argument("--vendor-root", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--fps", type=int, default=25)
    parser.add_argument("--mouth-x", type=float, default=300.0)
    parser.add_argument("--mouth-y", type=float, default=181.0)
    parser.add_argument("--frame-limit", type=int, default=0)
    return parser.parse_args()


def ensure_input_paths(args: argparse.Namespace) -> None:
    for path in (args.image, args.audio, args.rhubarb, args.vendor_root):
        if not path.exists():
            raise FileNotFoundError(path)
    if args.fps < 12:
        raise ValueError("fps must be at least 12")


def wave_duration(path: Path) -> float:
    with wave.open(str(path), "rb") as source:
        return source.getnframes() / source.getframerate()


def import_upstream_types(vendor_root: Path) -> tuple[Any, Any, Any, Any]:
    vendor_path = str(vendor_root.resolve())
    if vendor_path not in sys.path:
        sys.path.insert(0, vendor_path)
    from rhubarb_lipsync.rhubarb.cue_processor import CueProcessor
    from rhubarb_lipsync.rhubarb.mouth_cues import FrameConfig, MouthCueFrames
    from rhubarb_lipsync.rhubarb.rhubarb_command import RhubarbParser

    return CueProcessor, FrameConfig, MouthCueFrames, RhubarbParser


def run_rhubarb(rhubarb_path: Path, audio_path: Path) -> dict[str, Any]:
    command = [
        str(rhubarb_path),
        "-f",
        "json",
        "--extendedShapes",
        "GHX",
        "-r",
        "phonetic",
        str(audio_path),
    ]
    completed = subprocess.run(command, capture_output=True, text=True, check=False)
    if completed.returncode != 0:
        raise RuntimeError(f"Rhubarb failed ({completed.returncode}): {completed.stderr[-1200:]}")
    payload = json.loads(completed.stdout)
    if not payload.get("mouthCues"):
        raise RuntimeError("Rhubarb returned no mouth cues")
    return payload


def process_cues(raw_payload: dict[str, Any], vendor_root: Path, fps: int) -> tuple[list[Any], str]:
    cue_processor_type, frame_config_type, mouth_cue_frames_type, parser_type = import_upstream_types(vendor_root)
    raw_cues = parser_type.lipsync_json2MouthCues(raw_payload["mouthCues"])
    frame_config = frame_config_type(fps=fps)
    cue_frames = [mouth_cue_frames_type(cue, frame_config) for cue in raw_cues]
    processor = cue_processor_type(frame_cfg=frame_config, cue_frames=cue_frames, use_extended_shapes=True)
    report = processor.optimize_cues(max_cue_duration=0.24)
    return list(processor.cue_frames), report.strip()


def smoothstep(value: float) -> float:
    value = max(0.0, min(1.0, value))
    return value * value * (3.0 - 2.0 * value)


def ease_between(value: float, start: float, end: float, rising: bool) -> float:
    if end <= start + 1e-6:
        return 1.0 if rising and value >= end else 0.0 if rising else 0.0 if value >= end else 1.0
    ratio = smoothstep((value - start) / (end - start))
    return ratio if rising else 1.0 - ratio


def cue_boundaries(cue_frames: list[Any], fps: int) -> list[dict[str, float | str]]:
    result: list[dict[str, float | str]] = []
    for cue_frame in cue_frames:
        middle_start = cue_frame.get_middle_start(BLEND_RATIO)
        middle_end = cue_frame.get_middle_end_frame_float(BLEND_RATIO) / fps
        result.append(
            {
                "value": cue_frame.cue.key,
                "start": cue_frame.cue.start,
                "end": cue_frame.cue.end,
                "middle_start": middle_start,
                "middle_end": middle_end,
            }
        )
    return result


def cue_weight(index: int, cues: list[dict[str, float | str]], seconds: float) -> float:
    cue = cues[index]
    previous = cues[index - 1] if index else None
    following = cues[index + 1] if index + 1 < len(cues) else None
    fade_in_start = float(previous["middle_end"]) if previous else float(cue["start"])
    fade_in_end = float(cue["middle_start"])
    fade_out_start = float(cue["middle_end"])
    fade_out_end = float(following["middle_start"]) if following else float(cue["end"])
    if seconds < fade_in_start or seconds > fade_out_end:
        return 0.0
    if seconds < fade_in_end:
        return ease_between(seconds, fade_in_start, fade_in_end, rising=True)
    if seconds > fade_out_start:
        return ease_between(seconds, fade_out_start, fade_out_end, rising=False)
    return 1.0


def smooth_damp(current: float, target: float, velocity: float, smooth_time: float, delta_time: float) -> tuple[float, float]:
    smooth_time = max(0.001, smooth_time)
    omega = 2.0 / smooth_time
    value = omega * delta_time
    exponential = 1.0 / (1.0 + value + 0.48 * value * value + 0.235 * value * value * value)
    change = current - target
    temporary = (velocity + omega * change) * delta_time
    velocity = (velocity - omega * temporary) * exponential
    output = target + (change + temporary) * exponential
    if (target - current > 0.0) == (output > target):
        return target, 0.0
    return output, velocity


def motion_smooth_time(key: str, rising: bool) -> float:
    base = {"A": 0.030, "B": 0.050, "C": 0.062, "D": 0.070, "E": 0.060, "F": 0.055, "G": 0.042, "H": 0.055}[key]
    return base if rising else base * 0.72


def build_weight_curves(cues: list[dict[str, float | str]], duration: float, fps: int) -> dict[str, list[float]]:
    frame_count = max(1, math.ceil(duration * fps))
    target_curves = {key: [0.0] * frame_count for key in VISEME_KEYS}
    for frame_index in range(frame_count):
        seconds = frame_index / fps
        for cue_index, cue in enumerate(cues):
            key = str(cue["value"])
            if key not in target_curves:
                continue
            target_curves[key][frame_index] += cue_weight(cue_index, cues, seconds)
        total = sum(target_curves[key][frame_index] for key in VISEME_KEYS)
        if total > 1.0:
            for key in VISEME_KEYS:
                target_curves[key][frame_index] /= total

    curves = {key: [] for key in VISEME_KEYS}
    velocities = {key: 0.0 for key in VISEME_KEYS}
    values = {key: 0.0 for key in VISEME_KEYS}
    delta_time = 1.0 / fps
    for frame_index in range(frame_count):
        for key in VISEME_KEYS:
            target = target_curves[key][frame_index]
            current = values[key]
            smoothed, velocity = smooth_damp(
                current,
                target,
                velocities[key],
                motion_smooth_time(key, target > current),
                delta_time,
            )
            values[key] = max(0.0, min(1.0, smoothed))
            velocities[key] = velocity
        total = sum(values.values())
        if total > 1.0:
            for key in VISEME_KEYS:
                values[key] /= total
        for key in VISEME_KEYS:
            curves[key].append(values[key])
    return curves


def create_emission_material(name: str, color: tuple[float, float, float, float]) -> Any:
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    material.diffuse_color = color
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    nodes.clear()
    emission = nodes.new("ShaderNodeEmission")
    emission.inputs["Color"].default_value = color
    emission.inputs["Strength"].default_value = 1.0
    output = nodes.new("ShaderNodeOutputMaterial")
    links.new(emission.outputs["Emission"], output.inputs["Surface"])
    return material


def configure_alpha_material(material: Any) -> None:
    if hasattr(material, "surface_render_method"):
        material.surface_render_method = "DITHERED"
    elif hasattr(material, "blend_method"):
        material.blend_method = "BLEND"


def create_image_material(name: str, image: Any, transparent: bool) -> Any:
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    configure_alpha_material(material)
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    nodes.clear()
    texture = nodes.new("ShaderNodeTexImage")
    texture.image = image
    emission = nodes.new("ShaderNodeEmission")
    emission.inputs["Strength"].default_value = 1.0
    output = nodes.new("ShaderNodeOutputMaterial")
    links.new(texture.outputs["Color"], emission.inputs["Color"])
    if not transparent:
        links.new(emission.outputs["Emission"], output.inputs["Surface"])
        return material
    transparent_node = nodes.new("ShaderNodeBsdfTransparent")
    mix = nodes.new("ShaderNodeMixShader")
    links.new(texture.outputs["Alpha"], mix.inputs[0])
    links.new(transparent_node.outputs["BSDF"], mix.inputs[1])
    links.new(emission.outputs["Emission"], mix.inputs[2])
    links.new(mix.outputs["Shader"], output.inputs["Surface"])
    return material


def plane_object(name: str, center: tuple[float, float], width: float, height: float, z: float, material: Any) -> Any:
    x, y = center
    vertices = [
        (x - width / 2, y - height / 2, z),
        (x + width / 2, y - height / 2, z),
        (x + width / 2, y + height / 2, z),
        (x - width / 2, y + height / 2, z),
    ]
    mesh = bpy.data.meshes.new(f"{name}Mesh")
    mesh.from_pydata(vertices, [], [(0, 1, 2, 3)])
    uv_layer = mesh.uv_layers.new(name="UVMap")
    for loop, coordinates in zip(mesh.polygons[0].loop_indices, ((0, 0), (1, 0), (1, 1), (0, 1))):
        uv_layer.data[loop].uv = coordinates
    mesh.materials.append(material)
    object_ = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(object_)
    return object_


def ellipse_points(center: tuple[float, float], width: float, height: float, z: float, segments: int) -> list[tuple[float, float, float]]:
    x, y = center
    return [(x, y, z)] + [
        (x + math.cos(2.0 * math.pi * index / segments) * width, y + math.sin(2.0 * math.pi * index / segments) * height, z)
        for index in range(segments)
    ]


def ring_points(center: tuple[float, float], outer_width: float, outer_height: float, inner_width: float, inner_height: float, z: float, segments: int) -> list[tuple[float, float, float]]:
    points: list[tuple[float, float, float]] = []
    for width, height in ((outer_width, outer_height), (inner_width, inner_height)):
        points.extend(
            [
                (
                    center[0] + math.cos(2.0 * math.pi * index / segments) * width,
                    center[1] + math.sin(2.0 * math.pi * index / segments) * height,
                    z,
                )
                for index in range(segments)
            ]
        )
    return points


def create_shape_key_object(
    name: str,
    base_points: list[tuple[float, float, float]],
    faces: list[tuple[int, ...]],
    points_for_shape: Callable[[MouthShape], list[tuple[float, float, float]]],
    material: Any,
) -> Any:
    mesh = bpy.data.meshes.new(f"{name}Mesh")
    mesh.from_pydata(base_points, [], faces)
    mesh.materials.append(material)
    object_ = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(object_)
    object_.shape_key_add(name="Basis", from_mix=False)
    for key in VISEME_KEYS:
        block = object_.shape_key_add(name=key, from_mix=False)
        for point, coordinates in zip(block.data, points_for_shape(MOUTH_SHAPES[key])):
            point.co = coordinates
    return object_


def create_mouth_rig(center: tuple[float, float], pixel_unit: float) -> list[Any]:
    segments = 36
    lip_material = create_emission_material("Lip", (0.67, 0.26, 0.38, 1.0))
    inner_material = create_emission_material("InnerMouth", (0.18, 0.025, 0.055, 1.0))
    teeth_material = create_emission_material("Teeth", (1.0, 0.97, 0.92, 1.0))
    tongue_material = create_emission_material("Tongue", (0.76, 0.20, 0.31, 1.0))

    def ring_for_shape(shape: MouthShape) -> list[tuple[float, float, float]]:
        center_y = center[1] + shape.center_y * pixel_unit
        outer_width = (shape.width + 2.0) * pixel_unit
        outer_height = max(1.7, shape.height + 1.55) * pixel_unit
        inner_width = max(0.2, shape.width - 0.5) * pixel_unit
        inner_height = max(0.12, shape.height - 0.15) * pixel_unit
        return ring_points((center[0], center_y), outer_width, outer_height, inner_width, inner_height, 0.030, segments)

    ring_faces = [
        (index, (index + 1) % segments, segments + (index + 1) % segments, segments + index)
        for index in range(segments)
    ]
    lip = create_shape_key_object("MouthLip", ring_for_shape(MOUTH_SHAPES["X"]), ring_faces, ring_for_shape, lip_material)

    def inner_for_shape(shape: MouthShape) -> list[tuple[float, float, float]]:
        center_y = center[1] + shape.center_y * pixel_unit
        return ellipse_points(
            (center[0], center_y),
            max(0.08, shape.width - 1.2) * pixel_unit,
            max(0.08, shape.height - 0.25) * pixel_unit,
            0.028,
            segments,
        )

    ellipse_faces = [(0, index + 1, (index + 1) % segments + 1) for index in range(segments)]
    inner = create_shape_key_object("MouthInner", inner_for_shape(MOUTH_SHAPES["X"]), ellipse_faces, inner_for_shape, inner_material)

    def teeth_for_shape(shape: MouthShape) -> list[tuple[float, float, float]]:
        center_y = center[1] + (shape.center_y + shape.height * 0.34) * pixel_unit
        return ellipse_points(
            (center[0], center_y),
            max(0.03, shape.teeth_width) * pixel_unit,
            max(0.03, shape.teeth_height) * pixel_unit,
            0.034,
            segments,
        )

    teeth = create_shape_key_object("MouthTeeth", teeth_for_shape(MOUTH_SHAPES["X"]), ellipse_faces, teeth_for_shape, teeth_material)

    def tongue_for_shape(shape: MouthShape) -> list[tuple[float, float, float]]:
        center_y = center[1] + (shape.center_y - shape.height * 0.47) * pixel_unit
        return ellipse_points(
            (center[0], center_y),
            max(0.03, shape.tongue_width) * pixel_unit,
            max(0.03, shape.tongue_height) * pixel_unit,
            0.036,
            segments,
        )

    tongue = create_shape_key_object("MouthTongue", tongue_for_shape(MOUTH_SHAPES["X"]), ellipse_faces, tongue_for_shape, tongue_material)
    return [inner, teeth, tongue, lip]


def create_skin_patch(width: int = 192, height: int = 104) -> Any:
    image = bpy.data.images.new("SkinPatch", width=width, height=height, alpha=True)
    skin = (0.988, 0.945, 0.914)
    pixels: list[float] = []
    for row in range(height):
        for column in range(width):
            x = (column + 0.5) / width * 2.0 - 1.0
            y = (row + 0.5) / height * 2.0 - 1.0
            radius = math.sqrt(x * x + y * y)
            alpha = 0.0 if radius >= 1.0 else 0.80 * smoothstep(1.0 - radius)
            pixels.extend((*skin, alpha))
    image.pixels.foreach_set(pixels)
    image.update()
    return image


def configure_cycles_gpu(scene: Any) -> str:
    scene.render.engine = "CYCLES"
    addon = bpy.context.preferences.addons.get("cycles")
    if addon is None:
        raise RuntimeError("Cycles GPU preferences are unavailable")
    preferences = addon.preferences
    selected_backend = ""
    selected_devices: list[str] = []
    for backend in ("OPTIX", "CUDA"):
        try:
            preferences.compute_device_type = backend
            preferences.get_devices()
        except Exception:
            continue
        devices = [device for device in preferences.devices if device.type != "CPU"]
        if not devices:
            continue
        for device in preferences.devices:
            device.use = device.type != "CPU"
        selected_backend = backend
        selected_devices = [device.name for device in devices]
        break
    if not selected_backend:
        raise RuntimeError("No CUDA or OPTIX device is available to Cycles")
    scene.cycles.device = "GPU"
    scene.cycles.samples = 1
    if hasattr(scene.cycles, "use_denoising"):
        scene.cycles.use_denoising = False
    return f"{selected_backend}: {', '.join(selected_devices)}"


def configure_scene(image_path: Path, fps: int) -> tuple[Any, tuple[float, float], float, str]:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    cycles_backend = configure_cycles_gpu(scene)
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.render.film_transparent = False
    scene.render.fps = fps
    scene.render.resolution_x = 576
    scene.render.resolution_y = 1024
    if scene.world is None:
        scene.world = bpy.data.worlds.new("World")
    scene.world.color = (1.0, 1.0, 1.0)
    try:
        scene.view_settings.look = "None"
    except TypeError:
        pass

    portrait = bpy.data.images.load(str(image_path), check_existing=False)
    width, height = portrait.size
    scene.render.resolution_x = width
    scene.render.resolution_y = height
    portrait.pack()
    portrait_width = 2.0 * width / height
    portrait_height = 2.0
    portrait_material = create_image_material("PortraitMaterial", portrait, transparent=False)
    plane_object("Portrait", (0.0, 0.0), portrait_width, portrait_height, 0.0, portrait_material)

    camera_data = bpy.data.cameras.new("Camera")
    camera = bpy.data.objects.new("Camera", camera_data)
    bpy.context.collection.objects.link(camera)
    camera.location = (0.0, 0.0, 10.0)
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = portrait_height
    scene.camera = camera
    return scene, (portrait_width, portrait_height), portrait_height / height, cycles_backend


def animate_shape_keys(objects: list[Any], curves: dict[str, list[float]]) -> None:
    frame_count = len(next(iter(curves.values())))
    for object_ in objects:
        key_blocks = object_.data.shape_keys.key_blocks
        for key in VISEME_KEYS:
            block = key_blocks[key]
            for frame, value in enumerate(curves[key], start=1):
                block.value = value
                block.keyframe_insert(data_path="value", frame=frame)
        action = object_.data.shape_keys.animation_data.action
        for curve in action.fcurves:
            for point in curve.keyframe_points:
                point.interpolation = "BEZIER"
            curve.update()
    bpy.context.scene.frame_start = 1
    bpy.context.scene.frame_end = frame_count


def render_frames(scene: Any, output_dir: Path, frame_count: int) -> Path:
    frames_dir = output_dir / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)
    for frame in range(1, frame_count + 1):
        scene.frame_set(frame)
        scene.render.filepath = str(frames_dir / f"frame_{frame:06d}.png")
        bpy.ops.render.render(write_still=True)
        if frame == 1 or frame % 25 == 0 or frame == frame_count:
            print(f"rendered frame {frame}/{frame_count}", flush=True)
    return frames_dir


def run_ffmpeg(command: list[str]) -> None:
    completed = subprocess.run(command, capture_output=True, text=True, check=False)
    if completed.returncode:
        raise RuntimeError(f"FFmpeg failed ({completed.returncode}): {completed.stderr[-1200:]}")


def encode_video(frames_dir: Path, audio_path: Path, output_path: Path, fps: int) -> None:
    run_ffmpeg(
        [
            "ffmpeg",
            "-y",
            "-loglevel",
            "error",
            "-framerate",
            str(fps),
            "-start_number",
            "1",
            "-i",
            str(frames_dir / "frame_%06d.png"),
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
    )


def make_contact_sheet(video_path: Path, output_path: Path) -> None:
    run_ffmpeg(
        [
            "ffmpeg",
            "-y",
            "-loglevel",
            "error",
            "-i",
            str(video_path),
            "-vf",
            "fps=1/1,scale=144:-1,tile=7x1",
            "-frames:v",
            "1",
            str(output_path),
        ]
    )


def serialize_curves(curves: dict[str, list[float]]) -> dict[str, list[float]]:
    return {key: [round(value, 5) for value in values] for key, values in curves.items()}


def main() -> None:
    args = parse_args()
    ensure_input_paths(args)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    audio_duration = wave_duration(args.audio)
    raw_payload = run_rhubarb(args.rhubarb, args.audio)
    cue_frames, optimize_report = process_cues(raw_payload, args.vendor_root, args.fps)
    boundaries = cue_boundaries(cue_frames, args.fps)
    curves = build_weight_curves(boundaries, audio_duration, args.fps)

    raw_path = args.output_dir / "rhubarb_raw.json"
    raw_path.write_text(json.dumps(raw_payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    timeline_path = args.output_dir / "mouth_timeline.json"
    timeline_path.write_text(
        json.dumps(
            {
                "source": "Rhubarb Lip Sync NG CueProcessor + continuous Shape Key adapter",
                "blend_ratio": BLEND_RATIO,
                "fps": args.fps,
                "optimization": optimize_report,
                "cues": boundaries,
                "weights": serialize_curves(curves),
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    scene, (portrait_width, portrait_height), pixel_unit, cycles_backend = configure_scene(args.image, args.fps)
    mouth_center = (
        (args.mouth_x / scene.render.resolution_x - 0.5) * portrait_width,
        portrait_height / 2.0 - args.mouth_y / scene.render.resolution_y * portrait_height,
    )
    skin_image = create_skin_patch()
    skin_image.pack()
    skin_material = create_image_material("SkinPatchMaterial", skin_image, transparent=True)
    plane_object("SkinPatch", mouth_center, 68.0 * pixel_unit, 37.0 * pixel_unit, 0.015, skin_material)
    mouth_objects = create_mouth_rig(mouth_center, pixel_unit)
    animate_shape_keys(mouth_objects, curves)
    blend_path = args.output_dir / "avatar_continuous.blend"
    bpy.ops.wm.save_as_mainfile(filepath=str(blend_path))

    render_started = time.perf_counter()
    source_frame_count = len(next(iter(curves.values())))
    frame_count = min(source_frame_count, args.frame_limit) if args.frame_limit > 0 else source_frame_count
    frames_dir = render_frames(scene, args.output_dir, frame_count)
    video_path = args.output_dir / "avatar_continuous.mp4"
    encode_video(frames_dir, args.audio, video_path, args.fps)
    contact_sheet_path = args.output_dir / "avatar_continuous_contact_sheet.png"
    make_contact_sheet(video_path, contact_sheet_path)
    elapsed = time.perf_counter() - started
    render_elapsed = time.perf_counter() - render_started
    metrics = {
        "renderer": "Blender Cycles GPU Shape Key rig",
        "cycles_backend": cycles_backend,
        "timing": "Rhubarb Lip Sync NG CueProcessor with smoothstep crossfades and SmoothDamp curves",
        "audio_duration_sec": round(audio_duration, 3),
        "fps": args.fps,
        "frame_count": source_frame_count,
        "rendered_frame_count": frame_count,
        "cue_count": len(boundaries),
        "optimization": optimize_report,
        "mouth_center": [args.mouth_x, args.mouth_y],
        "render_elapsed_sec": round(render_elapsed, 3),
        "total_elapsed_sec": round(elapsed, 3),
        "render_realtime_factor": round(render_elapsed / audio_duration, 3),
        "outputs": {
            "video": str(video_path),
            "contact_sheet": str(contact_sheet_path),
            "timeline": str(timeline_path),
            "blend": str(blend_path),
        },
    }
    metrics_path = args.output_dir / "metrics.json"
    metrics_path.write_text(json.dumps(metrics, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(metrics, ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    main()
