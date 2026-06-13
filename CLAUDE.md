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

Defined in `runner/pipeline.ts`, orchestrated by `runner/solo.ts`（**唯一模式，全自动**；旧的 `/custom` 模式已删除）。进度按集·按阶段记录在 `改编进度.json` 的 `episodes[ep].stages`，重跑同一集时跳过已完成阶段（见「进度记录与续跑」）。

| 阶段 | 函数 | 描述 |
|------|------|------|
| 画面预设 | `visualPreset()` | LLM sub-agent 逐句标注【场景\|人物\|景别\|角度\|镜头运动\|光影\|情绪\|语言\|独白】，输出 `画面预设.txt` |
| 资源建档 | `archive()` | LLM sub-agent 识别角色/场景，输出 `archive-tasks` JSON；代码据此**批量分配音色**（`assignVoices`，写 `voice_map.json`）并调 `generateCharacterTool` / `generateSceneTool` 直接生图（并行） |
| 剧本分场 | `segment()` | LLM sub-agent 按场景将原文切分为多个 `.md`；sub-agent 的 cwd 设为 `scripts/`，只写裸文件名 `{场景名}.md` |
| 分镜制作 | `storyboard()` | 每个场景独立 LLM sub-agent，喂入角色名单**与音效库标签清单**，用 `append_group` 工具逐句写入 `storyboards/*.jsonl`；`image_prompt` 用 `[角色名·阶段]` 内联标注人物身份；可选在 group 加 `sfx` 字段标注字级音效（见「音效（SFX）」） |
| 全局排序 | `assignGlobalOrder()` | storyboard 完成后、render 前调用。读取 `画面预设.txt` 的原文行序，与各 JSONL group 的 `text` 做子串匹配，为每个 group 写入 `global_order` 字段；未匹配的 group 打印警告日志并置为 999 |
| 渲染合成 | `renderScene()` | 无 LLM agent。**先逐 group 配音**（`runGroupTtsPipeline`）拿真实音频时长 `d_g`，**再以 `d_g` 驱动该组 panel 视频时长**；各场景并行，组内 TTS→视频串行。配音时按 group `sfx` 字段在子片段层叠入字级音效（见「音效（SFX）」） |

## Architecture

### Entry Points
- `bin/cli.js` → `cli.ts`: CLI，命令 `/solo`、`/status`、`/help`、`/exit`
- `agent.ts`: sub-agent 基础设施（创建 session、执行、返回结果）。`runSubAgent`/`createSession` 接受可选 `cwd`（默认 `agent-data/`）；sub-agent 写相对路径时落在该 cwd（分场阶段据此传入 `scripts/`）

### Configuration
Stored in `~/.story-claw/` (not in the repo):
- `config.json`: LLM provider/model/api_key/base_url
- `image_gen_config.json`: `{ api_key, model, base_url }` — 当前 model 为 `openai/gpt-image-2:openai`，base_url 为 `https://zenmux.ai/api/vertex-ai`
- `video_config.json`: ComfyUI base_url、workflow_path、duration、concurrency
- `tts_config.json`: 豆包语音（火山引擎 语音合成大模型 V3，HTTP Chunked 单向流式）api_key（X-Api-Key）、base_url（`https://openspeech.bytedance.com/api/v3/tts/unidirectional`）、resource_id（`seed-tts-1.0`，决定可用音色版本与计费）、voices（`{voice_type: 性别}` 可分配音色池，key 为豆包 voice_type，**不应包含旁白音**）、narrator_voice（旁白专用 voice_type，独立于 voices 池）、concurrency、assign_character_voice（可选，默认 `true`；设为 `false` 时音色照常分配，但 TTS 合成时全部强制用 narrator_voice，相当于全程旁白音）、sfx_enabled（可选，默认 `true`；关闭后音效全程跳过）、sfx_volume（可选，默认 `0.7`；音效相对人声的音量 0–1）
- `sfx/`（目录，可选）: 全局音效库，放 `*.mp3`/`*.wav`，**标签 = 去扩展名的文件名**（可含空格，如 `玻璃破碎 心碎时刻`）。增删文件即增删标签，代码无需改（见「音效（SFX）」）

### Key Utilities
- `utils/paths.ts`: 所有输出路径的集中管理，**构造路径时必须使用此文件**
- `utils/image-gen.ts`: Node.js 生图统一入口，调用 `gpt-image-gen.py`（3次重试），失败后降级 `gemini-image-gen.py`
- `utils/gpt-image-gen.py`: 主力生图脚本，使用 Google GenAI SDK（Vertex AI 模式）调用 `openai/gpt-image-2:openai`
- `utils/gemini-image-gen.py`: 降级生图脚本，使用 `google/gemini-3.1-flash-image-preview`
- `utils/run-python.ts`: 导出 `CONFIG_DIR`（`~/.story-claw/`）、`WORK_DIR`（cwd）和 `PROJECT_ROOT`（别名）
- `utils/progress.ts`: 改编进度读写（`readProgress` / `getEpisodeRecord` / `markStage` / `finalizeEpisode`），记录每集每阶段完成状态

### Image Generation Flow

**路径一：资源建档**（角色原型图、角色造型图、场景底图）
1. LLM sub-agent（ARCHIVE_SYSTEM）分析画面预设文本，输出 `archive-tasks` JSON 块
2. `pipeline.ts:archive()` 用正则解析 JSON，**代码直接**调用 `generateCharacterTool.execute()` / `generateSceneTool.execute()`（不是 LLM 调工具）
3. 工具内部拼接完整 prompt，调 `utils/image-gen.ts:generateImage(prompt, outputPath, images, "16:9")`
4. `image-gen.ts` 用 async `spawn` 调 `gpt-image-gen.py`，失败重试 3 次，超时 600s
5. 3 次全败 → `image-gen.ts` 改调 `gemini-image-gen.py`（只试一次）

**路径二：渲染合成**（每个 panel 的分镜静态图）
1. 分镜制作阶段 LLM sub-agent 已将每个 panel 的 `image_prompt` 写入 `storyboards/*.jsonl`；`image_prompt` 中名单角色用 `[角色名·阶段]` 内联标注身份
2. `render.ts:renderScene()` 读取 JSONL，所有 panel 通过 `Promise.all` 并行执行（panel 时长由所属 group 的 `d_g` 决定，见「Render Pipeline Detail」）
3. 每个 panel 独立流程：`selectResources()` → `generateImage()` → `generateVideo()`
   - `selectResources()`：代码主动发 chat.completions。LLM **读 `[角色名·阶段]` 标签锁定身份、从该角色现有图里按阶段挑参考图**，并把整个 `[...]` 替换为 `the person in image N`、把背景替换为 `the background in image N`，返回参考图路径 + 改写后 prompt
   - 候选资源来自 `buildResourceCatalog()`，它**扫 `characters/` 与 `scenes/` 目录**列出所有 `{name}_*.png` / `{loc}*.png`，因此用户手动放入的真人参考图也会被纳入候选
   - `render.ts` 还有兜底：若选择器漏剥离 `[...]`，按是否有参考图替换为 `the person (in image 1)`，避免中文身份词污染生图
   - `is_continuation=true` 的 panel 跳过生图，等待 `videoEvents` 前驱事件后提取尾帧作为参考
4. 代码调 `render.ts:generateImage(imgSem, ...)`，async `spawn` 调 `gpt-image-gen.py`，失败重试 3 次
5. 3 次全败 → 代码改调 `gemini-image-gen.py`（只试一次）

**两条路径的共同点**：LLM 只负责生成数据，**生图始终由 Node.js 代码主动调 Python 脚本**，LLM 不直接触发生图。降级逻辑在 Node.js 侧，Python 脚本本身没有降级。

**自定义参考图约定**：用户可手动把 `{角色名}_原型.png`（角色）或 `{场景名}.png` / `{场景名}_变体.png`（场景）放进 `characters/` / `scenes/`。`buildResourceCatalog` 扫目录后这些图会作为候选（描述标注为「用户提供的真实参考图」）；`list_resources` 也会在「角色/场景现有图片」段列出每个资源磁盘上现有的 PNG。角色音色以 `_原型.png` 对应的角色为单位分配（见「音色分配」）。

**尺寸规则**：
- 资源建档固定 `16:9` → `1536×1024`
- 渲染分镜使用用户选择的 `aspectRatio`（`9:16` 或 `16:9`），通过 `NovelSelection.aspectRatio` 透传到 `render.ts`
- `aspectRatio` 通过 `--aspect` 传入 Python，映射：`9:16` → `1024×1536`，`16:9` → `1536×1024`

### Output Directory Structure
```
workspace/
└── {novelName}/
    ├── 改编进度.json          # 跨集进度（next_chapter、source_path、adapted）+ episodes[ep].stages 阶段记录
    ├── voice_map.json         # TTS 角色→音色映射（跨集复用；旁白不入表，用 narrator_voice）
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
        │   ├── g{XX}_tts.mp3     # 每个 group 的配音（按说话人切分后拼接）
        │   ├── tts_segments/     # group 内各子片段音频 g{XX}_s{YY}.mp3
        │   ├── _video_only.mp4
        │   ├── _tts_{sceneName}.mp3   # 全部 group 音频按序拼接
        │   └── final.mp4
        ├── render.log
        └── ep{XX}.mp4            # 集最终视频（多场景合并）
```

### Novel Input Convention
Chapter files: `第{N}章 {title}.txt`，放在用户指定的小说文件夹中。

### 全局排序（`assignGlobalOrder`，storyboard 完成后）
分镜制作阶段按场景独立产出 JSONL，但渲染拼接时需要按**原文阅读顺序**而非场景文件顺序。`assignGlobalOrder` 通过文本匹配恢复正确顺序：
1. 解析 `画面预设.txt` 每行原文（去掉 `【...】` 标注），行号即原始顺序
2. 遍历所有场景 JSONL，提取每个 group 的 `text` 字段
3. 子串匹配：group 文本包含 preset 文本（正向，得分=文本长度）或 preset 包含 group（反向，得分×0.5），取最高分的行号作为 `global_order`
4. 匹配不到的 group 置为 `999` 并打印 `[assignGlobalOrder] 未匹配` 警告日志
5. 写回 JSONL 文件的 `global_order` 字段

> 大多数情况下 storyboard 保留原文，文本完全一致，子串匹配是过度防御但无副作用。

### Render Pipeline Detail (`runner/render.ts`)
`renderScene()` 的执行流程（音频驱动视频时长）：
1. **逐 group 配音**（`runGroupTtsPipeline`，先于视频）：每个 group 由 LLM 按说话人把原文切成有序 `[{text,voice,style}]`（旁白/角色查 `voice_map`，未命中→`narrator_voice`），并行合成子片段（`ttsExecApi`，TTS 信号量限流），拼成 `g{XX}_tts.mp3` 并用 `ffprobe` 量出真实时长 `d_g`；全部组音频按序拼成 `_tts_{sceneName}.mp3`。返回每组 `d_g` 数组。**若该 group 有 `sfx`，子片段合成时开字级时间戳并在拼接前叠入音效（见「音效（SFX）」），子片段时长不变、`d_g` 不受影响。**
2. **所有 panel 并行**（`Promise.all`）：每个 panel 目标时长 = 所属 group 的 `d_g` 按 panel **分数秒**均分（`distributePanelDurations`，不取整、无地板，取代旧的 `secs_per_char` 估算）
   - `is_continuation=false`：`selectResources()` + `generateImage()`（imgSem，默认并发 4）
   - `is_continuation=true`：跳过生图，等待 `videoEvents` 前驱事件，提取尾帧后生视频
   - 生视频：`generateVideo()`（vidSem，默认并发 6），**duration 传入 `d_g` 派生的分数秒**，调用 ComfyUI LTX i2v workflow（时长→帧数换算见「视频时长控制」）
3. **group 拼接**（顺序）：按 group 顺序将 panel 视频拼为 group 视频，再拼成 `_video_only.mp4`
4. **全局对齐**（`globalAlignAndMerge`，在 `solo.ts` 调用）：收集各场景的 `_video_only.mp4` + `_tts_{scene}.mp3`，相向调速后拼为集视频。因逐组时长已精确贴合（每组误差 ≤ 半个帧栅格），调速比趋近 ×1.00，听感不受影响。

> 注意：`imagesOnly` 模式（用户在 `/solo` 选「只生分镜图」）会跳过 TTS、生视频、拼接与合并，只产出 panel 静态图，且不推进进度，便于 ComfyUI 未就绪时先出图、之后重跑补视频。

### 视频时长控制（`tryGenerateVideoComfyUI` / `durationToFrames`）
LTX 帧数必须为 `8k+1`（latent 时间维 8× 压缩，模型架构属性，常量 `LTX_FRAME_STEP=8`），故输出时长按 **`LTX_FRAME_STEP/fps` 的栅格**量化（25fps 时 0.32s/步），**无法精确到 0.1s**。
- **fps 单一真值**：从 workflow 节点 `320:300` 读取（`getVideoFps`），它同时驱动输出帧率与帧数换算。**改帧率只改这一个节点，代码自动适配，切勿在别处硬编码 fps。**
- **秒→帧**：`durationToFrames(durSec, fps)` 取最近的 `8k+1` 帧数（`k≥1`），误差 ≤ 半个栅格（25fps 时 ±0.16s）。
- **注入方式**：直接把帧数写入 latent 长度的两个消费节点 `320:295.length`（视频）与 `320:305.frames_number`（音频，须同帧数），**绕过** workflow 内 `320:323` 的 `a*fps+1` 整数秒瓶颈（注入后 `320:301`/`320:323` 成孤立节点，不影响执行）。
- **设计取舍**：误差从旧版「短组被 4s 地板撑长、单向累积」变为「每组随机 ±0.16s、整段近乎抵消」，使统一调速（步骤 4）趋近 ×1.00、听感无损。若要清零残差只能给视频侧逐组 setpts 微调（≤±4%，画面无感），通常不需要。

### 音色分配（`assignVoices`，archive 阶段）
- 在 `archive()` 解析出 `archive-tasks` 后、生图前调用，**一次性为本章新角色分配音色**（无并发竞态）。
- LLM 输入：new_characters 的 `{name, base_prompt, gender}` + 现有 `voice_map`（作已占用上下文）+ 可分配音色池；**只输出新增** `{角色:音色}`，代码合并写回 `voice_map.json`，LLM 失败时按性别规则兜底。
- **旁白不参与分配、不入表**：TTS 时旁白直接用 `tts_config.narrator_voice`；角色查 `voice_map`，别名由 LLM 在配音切分时自匹配，查不到则回退旁白音。

### 音效（SFX）（`loadSfxCatalog` / `mixSfx`，render.ts）
在配音的**精准字级位置**叠入短音效（如念到"拔"字时触发"砍杀"声）。可行性：`seed-tts-1.0` 在 `audio_params.enable_timestamp=true` 时返回 `sentence.words[]`（`{word, startTime, endTime}`，驼峰、秒），见 `scripts/test_tts_timestamp.py`。

- **音效库 + 闭合清单**：`~/.story-claw/sfx/` 放 `*.mp3`/`*.wav`，`loadSfxCatalog()` 扫目录得 `Map<标签, 路径>`（标签=去扩展名文件名）。`storyboard()` 把标签清单注入分镜 agent，其 `sfx.sound` **只能从清单里选**；库为空时提示勿输出 sfx。
- **分镜阶段标注**：storyboard agent 在 group JSON 加可选 `sfx: [{anchor, sound}]`（不额外加 LLM 调用）。`anchor` 必须是该 group `text` 里**逐字出现的纯中文子串**（数字/英文会被 TN 读开导致 token≠原文）；`sound` 是音效标签。`append_group` 原样落盘，render 侧 `parseJsonl` 自然可读。
- **叠音位置：子片段层**（TTS 刚合成、拼接前）。靠拼接天然保持定位，不累加偏移、不受全局调速影响：
  1. 仅当 `SFX_ENABLED && 该 group 有 sfx && 库非空` 时，子片段合成才开 `timestamp`（`ttsExecApi` 返回 `{words}`），无音效请求行为完全不变。
  2. 按字展开 words 建 char→startTime 映射，`indexOf(anchor)` 定位首字得 `triggerTime`；找不到→跳过+日志。
  3. **放不下就跳过**：`子片段时长 − triggerTime < 音效时长`（精确到小数点后两位）→ 跳过+日志，保证子片段时长零变化、`d_g`/视频时长不受影响。
  4. 命中且放得下：`mixSfx` 用 ffmpeg `adelay`+`amix`（`duration=first`）把音效延迟 `triggerTime` 后混入，**输出临时文件再覆盖原子片段**（ffmpeg 不能原地读写）。
- **消费规则**：每项 sfx 落在**第一个**含其 anchor 的子片段，命中即消费、不重复；匹配/跳过/未匹配各打一行日志。
- **续跑/兜底**：group 音频已存在则直接跳过（含音效的旧文件天然复用）；库为空或 `sfx_enabled=false` 时全程跳过，行为与未加该功能时一致。

### 进度记录与续跑（`utils/progress.ts`）
- `改编进度.json` 的 `episodes[ep].stages` 记录五阶段完成状态（`visualPreset`/`archive`/`segment`/`storyboard`/`render`）；`render` 取值 `images_only` 或 `done`。
- `solo.ts` 每阶段完成调 `markStage`；整集完整渲染后调 `finalizeEpisode`（`render=done` + 追加 `adapted` + `next_chapter+1`）。
- 重跑同一集：已 `done` 的阶段跳过（`archive` 跳过时其 `sceneNames` 从记录重建）；`render=images_only` 时重跑会补视频。`images_only` 不推进进度，故集号停留可原地续跑。

### Agent Data
- `agent-data/`: pi-coding-agent 框架自动创建的 session 状态
- `agent-logs/`: 各 sub-agent 的执行日志
