"""
merge_tts.py - 用 TTS 音频替换视频声音，调整视频速度与音频时长对齐

用法:
    python merge_tts.py <final.mp4> <tts.mp3> [--output OUTPUT]
"""

import argparse
import subprocess
import sys
from pathlib import Path


def get_duration(path: Path) -> float:
    result = subprocess.run(
        ['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
         '-of', 'csv=p=0', str(path)],
        capture_output=True, text=True
    )
    return float(result.stdout.strip())


def merge(video: Path, audio: Path, output: Path):
    video_dur = get_duration(video)
    audio_dur = get_duration(audio)
    ratio = audio_dur / video_dur

    print(f"视频时长: {video_dur:.2f}s")
    print(f"音频时长: {audio_dur:.2f}s")
    print(f"视频速度调整: {ratio:.4f}x")
    print(f"输出: {output}")

    cmd = [
        'ffmpeg', '-y',
        '-i', str(video),
        '-i', str(audio),
        '-filter:v', f'setpts={ratio:.6f}*PTS',
        '-map', '0:v',
        '-map', '1:a',
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
        '-c:a', 'aac', '-b:a', '192k',
        '-shortest',
        str(output)
    ]

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print("ffmpeg 错误:", result.stderr[-1000:], file=sys.stderr)
        sys.exit(1)

    final_dur = get_duration(output)
    print(f"完成，输出时长: {final_dur:.2f}s")


def main():
    parser = argparse.ArgumentParser(description='用 TTS 替换视频声音并调整速度')
    parser.add_argument('video', help='输入视频 (.mp4)')
    parser.add_argument('audio', help='TTS 音频 (.mp3)')
    parser.add_argument('--output', help='输出文件路径（默认: final_tts.mp4）')
    args = parser.parse_args()

    video = Path(args.video)
    audio = Path(args.audio)

    if args.output:
        output = Path(args.output)
    else:
        output = video.parent / (video.stem + '_tts.mp4')

    merge(video, audio, output)


if __name__ == '__main__':
    main()
