"""
gen_tts.py - 从分镜 JSONL 提取原文并生成 TTS 音频

用法:
    python gen_tts.py <storyboard.jsonl> [--voice VOICE] [--output OUTPUT]

参数:
    storyboard.jsonl  分镜 JSONL 文件路径（默认自动搜索）
    --voice           edge-tts 声音名称（默认: zh-CN-XiaoxiaoNeural）
    --output          输出音频文件路径（默认: 与 JSONL 同目录的 tts_narration.mp3）
    --list-voices     列出所有可用中文声音后退出
"""

import argparse
import asyncio
import json
import re
import sys
from pathlib import Path


def strip_preset_blocks(text: str) -> str:
    """去掉【画面预设】块，保留原文台词。"""
    return re.sub(r'【[^】]*】', '', text).strip()


def extract_full_text(jsonl_path: Path) -> str:
    """从 JSONL 读取所有 group 的 text，拼成完整旁白文本。"""
    lines = []
    with open(jsonl_path, encoding='utf-8') as f:
        for raw in f:
            raw = raw.strip()
            if not raw:
                continue
            group = json.loads(raw)
            text = group.get('text', '')
            clean = strip_preset_blocks(text)
            if clean:
                lines.append(clean)
    return '\n'.join(lines)


async def list_chinese_voices():
    import edge_tts
    voices = await edge_tts.list_voices()
    zh_voices = [v for v in voices if v['Locale'].startswith('zh-')]
    for v in zh_voices:
        print(f"{v['ShortName']:40s}  {v['Gender']:7s}  {v['FriendlyName']}")


async def generate_tts(text: str, voice: str, output_path: Path):
    import edge_tts
    print(f"声音: {voice}")
    print(f"输出: {output_path}")
    print(f"文本 ({len(text)} 字):")
    print('-' * 60)
    print(text)
    print('-' * 60)

    tts = edge_tts.Communicate(text, voice=voice)
    await tts.save(str(output_path))
    print(f"\n已生成: {output_path}")


def find_default_jsonl() -> Path | None:
    """在 workspace 目录下搜索最新修改的 storyboard_*.jsonl。"""
    base = Path(__file__).parent / 'workspace'
    if not base.exists():
        return None
    candidates = list(base.rglob('storyboard_*.jsonl'))
    if not candidates:
        return None
    return max(candidates, key=lambda p: p.stat().st_mtime)


def main():
    parser = argparse.ArgumentParser(description='从分镜 JSONL 生成旁白 TTS 音频')
    parser.add_argument('jsonl', nargs='?', help='分镜 JSONL 文件路径')
    parser.add_argument('--voice', default='zh-CN-XiaoxiaoNeural',
                        help='edge-tts 声音名称（默认: zh-CN-XiaoxiaoNeural）')
    parser.add_argument('--output', help='输出音频文件路径')
    parser.add_argument('--list-voices', action='store_true', help='列出所有可用中文声音')
    args = parser.parse_args()

    if args.list_voices:
        asyncio.run(list_chinese_voices())
        return

    # 确定 JSONL 路径
    if args.jsonl:
        jsonl_path = Path(args.jsonl)
    else:
        jsonl_path = find_default_jsonl()
        if jsonl_path is None:
            print('错误: 找不到 storyboard_*.jsonl，请手动指定路径', file=sys.stderr)
            sys.exit(1)
        print(f'使用 JSONL: {jsonl_path}')

    if not jsonl_path.exists():
        print(f'错误: 文件不存在: {jsonl_path}', file=sys.stderr)
        sys.exit(1)

    # 确定输出路径
    if args.output:
        output_path = Path(args.output)
    else:
        output_path = jsonl_path.parent / (jsonl_path.stem.replace('storyboard_', 'tts_') + '.mp3')

    # 提取文本
    text = extract_full_text(jsonl_path)
    if not text:
        print('错误: JSONL 中没有提取到文本', file=sys.stderr)
        sys.exit(1)

    # 生成 TTS
    asyncio.run(generate_tts(text, args.voice, output_path))


if __name__ == '__main__':
    main()
