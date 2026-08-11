"""按指定倍速调整视频，并可选混入 BGM；保留全部视频帧且不覆盖输入文件。"""

import argparse
import json
import math
import shutil
import subprocess
import tempfile
from pathlib import Path


def run(cmd: list[str], capture: bool = False) -> str:
    result = subprocess.run(
        cmd,
        check=False,
        capture_output=capture,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if result.returncode != 0:
        detail = result.stderr.strip() if capture else ""
        raise RuntimeError(f"命令失败（{result.returncode}）: {' '.join(cmd)}\n{detail}")
    return result.stdout.strip() if capture else ""


def ffprobe_json(ffprobe: str, path: Path, count_packets: bool = False) -> dict:
    cmd = [ffprobe, "-v", "error"]
    if count_packets:
        cmd.append("-count_packets")
    cmd += ["-show_streams", "-show_format", "-of", "json", str(path)]
    return json.loads(run(cmd, capture=True))


def video_info(ffprobe: str, path: Path) -> tuple[int, float, float]:
    data = ffprobe_json(ffprobe, path, count_packets=True)
    stream = next(s for s in data["streams"] if s["codec_type"] == "video")
    packets = int(stream["nb_read_packets"])
    duration = float(stream.get("duration") or data["format"]["duration"])
    frame_rate = stream.get("avg_frame_rate", "0/1")
    numerator, denominator = (int(x) for x in frame_rate.split("/"))
    fps = numerator / denominator if denominator and numerator else 25.0
    return packets, duration, fps


def stream_timings(ffprobe: str, path: Path) -> dict[str, tuple[float, float]]:
    data = ffprobe_json(ffprobe, path)
    timings = {}
    for stream in data["streams"]:
        kind = stream.get("codec_type")
        if kind in {"video", "audio"}:
            timings[kind] = (
                float(stream.get("start_time") or 0),
                float(stream.get("duration") or data["format"]["duration"]),
            )
    return timings


def atempo_chain(speed: float) -> str:
    factors = []
    remaining = speed
    while remaining > 2.0:
        factors.append(2.0)
        remaining /= 2.0
    while remaining < 0.5:
        factors.append(0.5)
        remaining /= 0.5
    factors.append(remaining)
    return ",".join(f"atempo={factor:.9f}" for factor in factors)


def default_output(input_path: Path, speed: float, has_bgm: bool) -> Path:
    speed_text = f"{speed:g}".replace(".", "p")
    suffix = f"_{speed_text}x" + ("_bgm" if has_bgm else "")
    return input_path.with_name(f"{input_path.stem}{suffix}{input_path.suffix}")


def main() -> None:
    parser = argparse.ArgumentParser(description="无丢帧调整视频速度，并可选混入 BGM。")
    parser.add_argument("input", type=Path, help="输入视频")
    parser.add_argument("--speed", type=float, required=True, help="倍速，必须大于 0")
    parser.add_argument("--bgm", type=Path, help="可选 BGM 文件")
    parser.add_argument("--bgm-volume-db", type=float, default=-18.0, help="BGM 音量（dB，默认 -18）")
    parser.add_argument("--fade-out", type=float, default=3.0, help="BGM 结尾淡出秒数（默认 3）")
    parser.add_argument("--output", type=Path, help="输出路径；默认按倍速自动命名")
    parser.add_argument("--ffmpeg", default="ffmpeg", help="ffmpeg 路径")
    parser.add_argument("--ffprobe", default="ffprobe", help="ffprobe 路径")
    args = parser.parse_args()

    source = args.input.resolve()
    bgm = args.bgm.resolve() if args.bgm else None
    output = (args.output or default_output(args.input, args.speed, bgm is not None)).resolve()

    if args.speed <= 0 or not math.isfinite(args.speed):
        raise SystemExit("--speed 必须是大于 0 的有限数值")
    if args.fade_out < 0 or not math.isfinite(args.fade_out):
        raise SystemExit("--fade-out 必须是 >= 0 的有限数值")
    if not source.is_file():
        raise SystemExit(f"输入视频不存在：{source}")
    if bgm and not bgm.is_file():
        raise SystemExit(f"BGM 不存在：{bgm}")
    if output == source:
        raise SystemExit("输出路径不能与输入视频相同")
    if output.exists():
        raise SystemExit(f"输出文件已存在，拒绝覆盖：{output}")

    output.parent.mkdir(parents=True, exist_ok=True)
    input_packets, _, _ = video_info(args.ffprobe, source)

    try:
        with tempfile.TemporaryDirectory(prefix="story-claw-speed-") as temp_dir:
            temp = Path(temp_dir)
            video_tmp = temp / "video.mp4"
            audio_tmp = temp / "audio.m4a"
            output_tmp = temp / "output.mp4"

            run([
                args.ffmpeg, "-y", "-v", "warning",
                "-itsscale", f"{1 / args.speed:.15f}", "-i", str(source),
                "-map", "0:v:0", "-an", "-c:v", "copy",
                "-avoid_negative_ts", "make_zero", str(video_tmp),
            ])
            video_packets, video_duration, fps = video_info(args.ffprobe, video_tmp)
            if video_packets != input_packets:
                raise RuntimeError(f"视频帧包丢失：输入 {input_packets}，变速后 {video_packets}")

            voice = f"[0:a:0]{atempo_chain(args.speed)},aresample=44100:first_pts=0[voice]"
            if bgm:
                fade = min(args.fade_out, video_duration)
                fade_start = max(0.0, video_duration - fade)
                bgm_filters = (
                    f"[1:a:0]aloop=loop=-1:size=2e+09,volume={args.bgm_volume_db:g}dB,aresample=44100:first_pts=0,"
                    f"atrim=0:{video_duration:.9f}"
                )
                if fade > 0:
                    bgm_filters += f",afade=t=out:st={fade_start:.9f}:d={fade:.9f}"
                filter_complex = (
                    f"{voice};{bgm_filters}[bgm];"
                    f"[voice][bgm]amix=inputs=2:duration=longest:dropout_transition=0,"
                    f"atrim=0:{video_duration:.9f},asetpts=N/SR/TB[mix]"
                )
                audio_inputs = ["-i", str(source), "-i", str(bgm)]
            else:
                filter_complex = (
                    f"{voice};[voice]atrim=0:{video_duration:.9f},asetpts=N/SR/TB[mix]"
                )
                audio_inputs = ["-i", str(source)]

            run([
                args.ffmpeg, "-y", "-v", "warning", *audio_inputs,
                "-filter_complex", filter_complex, "-map", "[mix]",
                "-c:a", "aac", "-b:a", "192k", str(audio_tmp),
            ])
            run([
                args.ffmpeg, "-y", "-v", "warning",
                "-i", str(video_tmp), "-i", str(audio_tmp),
                "-map", "0:v:0", "-map", "1:a:0", "-c", "copy",
                "-t", f"{video_duration:.9f}", "-movflags", "+faststart", str(output_tmp),
            ])

            output_packets, _, _ = video_info(args.ffprobe, output_tmp)
            timings = stream_timings(args.ffprobe, output_tmp)
            if output_packets != input_packets:
                raise RuntimeError(f"最终视频帧包不一致：输入 {input_packets}，输出 {output_packets}")
            if "video" not in timings or "audio" not in timings:
                raise RuntimeError("最终文件缺少视频流或音频流")
            video_start, final_video_duration = timings["video"]
            audio_start, final_audio_duration = timings["audio"]
            tolerance = max(1 / fps, 0.05)
            if abs(video_start - audio_start) > tolerance:
                raise RuntimeError(f"音视频起始时间不一致：视频 {video_start:.6f}s，音频 {audio_start:.6f}s")
            if abs(final_video_duration - final_audio_duration) > tolerance:
                raise RuntimeError(
                    f"音视频时长差超限：视频 {final_video_duration:.6f}s，"
                    f"音频 {final_audio_duration:.6f}s，容差 {tolerance:.6f}s"
                )

            shutil.move(str(output_tmp), str(output))
    except Exception:
        output.unlink(missing_ok=True)
        raise

    print(f"完成：{output}")
    print(f"视频帧包：{input_packets} → {input_packets}（无丢帧）")
    print(f"音视频时长：{final_video_duration:.6f}s / {final_audio_duration:.6f}s")


if __name__ == "__main__":
    main()
