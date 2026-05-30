# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Story Claw** is an AI-powered pipeline that transforms web novel chapters into short-form drama videos. It runs five sequential stages — each driven by LLM sub-agents or direct API calls — to produce a fully rendered episode with narration, image panels, and video clips.

## Commands

```bash
# Install dependencies
npm install

# Run the CLI
npm start

# Global install for development
npm install -g .
```

There are no automated tests or lint scripts defined in package.json. TypeScript is run directly via `tsx` at runtime (no compile step).

## Pipeline Stages

Defined in `runner/pipeline.ts`, orchestrated by `runner/solo.ts` (full auto) and `runner/custom.ts` (pauses before 渲染合成 for manual asset review).

| 阶段 | 函数 | 描述 |
|------|------|------|
| 画面预设 | `visualPreset()` | LLM sub-agent 逐句标注【场景\|人物\|景别\|角度\|镜头运动\|光影\|情绪\|语言\|独白】，输出 `画面预设.txt` |
| 资源建档 | `archive()` | LLM sub-agent 识别角色/场景，调用 `generateCharacterTool` / `generateSceneTool` 直接生图（并行） |
| 剧本分场 | `segment()` | LLM sub-agent 按场景将原文切分为多个 `.md` 文件，保存到 `scripts/` |
| 分镜制作 | `storyboard()` | 每个场景独立 LLM sub-agent，用 `append_group` 工具逐句写入 `storyboards/*.jsonl` |
| 渲染合成 | `renderScene()` | 无 LLM agent，直接 API：生图 → 生视频 → TTS → ffmpeg 合并，各场景并行 |

## Architecture

### Entry Points
- `bin/cli.js` → `cli.ts`: CLI，命令 `/solo`、`/custom`、`/status`、`/help`、`/exit`
- `agent.ts`: sub-agent 基础设施（创建 session、执行、返回结果）

### Configuration
Stored in `~/.story-claw/` (not in the repo):
- `config.json`: LLM provider/model/api_key/base_url
- `image_gen_config.json`: `{ api_key, model, base_url }` — 当前 model 为 `openai/gpt-image-2:openai`，base_url 为 `https://zenmux.ai/api/vertex-ai`
- `video_config.json`: ComfyUI base_url、workflow_path、duration、concurrency
- `tts_config.json`: MiMo TTS api_key、voices、narrator_voice、concurrency

### Key Utilities
- `utils/paths.ts`: 所有输出路径的集中管理，**构造路径时必须使用此文件**
- `utils/image-gen.ts`: Node.js 生图统一入口，调用 `gpt-image-gen.py`（3次重试），失败后降级 `gemini-image-gen.py`
- `utils/gpt-image-gen.py`: 主力生图脚本，使用 Google GenAI SDK（Vertex AI 模式）调用 `openai/gpt-image-2:openai`
- `utils/gemini-image-gen.py`: 降级生图脚本，使用 `google/gemini-3.1-flash-image-preview`
- `utils/run-python.ts`: 导出 `CONFIG_DIR`（`~/.story-claw/`）和 `PROJECT_ROOT`

### Image Generation Flow

**路径一：资源建档**（角色原型图、角色造型图、场景底图）
1. LLM sub-agent（ARCHIVE_SYSTEM）分析画面预设文本，输出 `archive-tasks` JSON 块
2. `pipeline.ts:archive()` 用正则解析 JSON，**代码直接**调用 `generateCharacterTool.execute()` / `generateSceneTool.execute()`（不是 LLM 调工具）
3. 工具内部拼接完整 prompt，调 `utils/image-gen.ts:generateImage(prompt, outputPath, images, "16:9")`
4. `image-gen.ts` 用 `spawnSync` 调 `gpt-image-gen.py`，失败重试 3 次
5. 3 次全败 → `image-gen.ts` 改调 `gemini-image-gen.py`（只试一次）

**路径二：渲染合成**（每个 panel 的分镜静态图）
1. 分镜制作阶段 LLM sub-agent 已将每个 panel 的 `image_prompt` 写入 `storyboards/*.jsonl`
2. `render.ts:renderScene()` 读取 JSONL，逐 group 调 `processGroup()`
3. 每个 panel 先调 `selectResources()`：代码**主动发一次普通 chat.completions**（非 agent/工具调用），LLM 返回 JSON（选好的参考图路径 + 改写后的 prompt，人物/背景文字描述 → `the person/background in image N`）
4. 代码调 `render.ts:generateImage(imgSem, imagePrompt, refPaths, outputPath, aspectRatio)`
5. `spawnSync` 调 `gpt-image-gen.py`，失败重试 3 次
6. 3 次全败 → 代码改调 `gemini-image-gen.py`（只试一次）

**两条路径的共同点**：LLM 只负责生成数据，**生图始终由 Node.js 代码主动调 Python 脚本**，LLM 不直接触发生图。降级逻辑在 Node.js 侧，Python 脚本本身没有降级。

**尺寸规则**：
- 资源建档固定 `16:9` → `1536×1024`
- 渲染分镜使用用户选择的 `aspectRatio`（`9:16` 或 `16:9`），通过 `NovelSelection.aspectRatio` 透传到 `render.ts`
- `aspectRatio` 通过 `--aspect` 传入 Python，映射：`9:16` → `1024×1536`，`16:9` → `1536×1024`

### Output Directory Structure
```
workspace/
└── {novelName}/
    ├── 改编进度.json          # 跨集进度（next_chapter、source_path 等）
    ├── voice_map.json         # TTS 角色声音映射（跨集复用）
    ├── characters/            # 跨集共享
    │   ├── {name}.json
    │   ├── {name}_原型.png
    │   └── {name}_{stage}.png
    ├── scenes/                # 跨集共享
    │   ├── {location}.json
    │   └── {location}.png
    └── ep{XX}/
        ├── 画面预设.txt
        ├── scripts/
        │   └── {sceneName}.md
        ├── storyboards/
        │   └── storyboard_{sceneName}.jsonl
        ├── render_{sceneName}/
        │   ├── g{XX}_p{YY}.png   # panel 静态图
        │   ├── g{XX}_p{YY}.mp4   # panel 视频
        │   ├── g{XX}.mp4         # group 拼接视频
        │   ├── tts_segments/
        │   ├── _video_only.mp4
        │   ├── _tts_{sceneName}.mp3
        │   └── final.mp4
        ├── render.log
        └── ep{XX}.mp4            # 集最终视频（多场景合并）
```

### Novel Input Convention
Chapter files: `第{N}章 {title}.txt`，放在用户指定的小说文件夹中。

### Render Pipeline Detail (`runner/render.ts`)
每个 group 的处理流程（`processGroup`）：
1. **资源选择**（`selectResources`）：LLM 根据 `shot_type` 和场景上下文选参考图，改写 `image_prompt`（人物/背景描述 → `the person/background in image N`）
2. **生图**（`generateImage`）：信号量并发（默认 4），调用 `gpt-image-gen.py`，3次失败降级 `gemini-image-gen.py`
3. **生视频**（`generateVideo`）：信号量并发（默认 2），调用 ComfyUI LTX-2.3 i2v workflow
4. **TTS 管线**（`runTtsPipeline`）：Phase1 标注 → Phase2 分配声音 → Phase3 并行合成 → Phase4 拼接
5. **音视频合并**（`mergeVideoAudio`）：ffmpeg setpts 对齐时长
6. **全局对齐**（`globalAlignAndMerge`）：多场景相向调速后拼为集视频

### Agent Data
- `agent-data/`: pi-coding-agent 框架自动创建的 session 状态
- `agent-logs/`: 各 sub-agent 的执行日志
