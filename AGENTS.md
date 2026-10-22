# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview

**Story Claw** is an AI-powered pipeline that transforms stories or argumentative articles into short-form videos. Story projects plan textual storyboards, prepare existing character/scene references and generate videos directly with MiniMax H3. Essay projects use the same H3 backend for generated video and retain their HTML-driven MG planning pipeline. Story `imagesOnly` still generates static storyboard images.

## Commands

```bash
# Install dependencies
npm install

# Run the CLI
npm start

# Global install for development
npm install -g .
```

TypeScript is run directly via `tsx` at runtime. Use `npm run typecheck` for the project type check and `npm run test:mg` for MG template and orchestration tests.

## Pipeline Stages

Defined in `runner/pipeline.ts`, orchestrated by `runner/solo.ts`（**唯一模式，全自动**；旧的 `/custom` 模式已删除）。进度按集·按阶段记录在 `改编进度.json` 的 `episodes[ep].stages`，重跑同一集时跳过已完成阶段（见「进度记录与续跑」）。

| 阶段 | 函数 | 描述 |
|------|------|------|
| 原文清理 | `cleanText()` | LLM sub-agent 清理原文，输出 `原文_clean.txt` |
| MG 语义标注（仅议论文） | `annotateEssayMg()` | 第一次 AI 调用。把完整清稿逐字保留在 HTML 中，只添加 MG 标签及样式 `group`、可选实例 `order`、`mode=together\|split`、节点 `value`；同类标签只有一个实例时禁止输出 `order`，此阶段禁止输出 `at` |
| 画面预设 | `visualPreset()` | LLM sub-agent 逐句标注【场景\|人物\|景别\|角度\|镜头运动\|光影\|情绪\|语言\|独白】，输出 `画面预设.txt` |
| 资源建档 | `archive()` | LLM sub-agent 识别角色/场景，输出 `archive-tasks` JSON；代码据此**批量分配音色**（`assignVoices`，写 `voice_map.json`）并调 `generateCharacterTool` / `generateSceneTool` 直接生图（并行） |
| 剧本分场 | `segment()` | LLM sub-agent 按场景将原文切分为多个 `.md`；sub-agent 的 cwd 设为 `scripts/`，只写裸文件名 `{场景名}.md` |
| 分镜制作 | `storyboard()` | 每个故事场景独立 LLM sub-agent，喂入角色名单**与音效库标签清单**，用 `append_group` 逐句写入 `storyboards/*.jsonl`；`image_prompt` 用 `[实际参考图文件名去掉.png]` 锁定人物；保留静态构图与动态描述，供 H3 准备 Agent 融合。完整渲染与 `imagesOnly` 使用同一 H3 拆镜上限；可选在 group 加 `sfx` |
| 全局排序 | `assignGlobalOrder()` | storyboard 完成后、render 前调用。读取 `画面预设.txt` 的原文行序，与各 JSONL group 的 `text` 做子串匹配，为每个 group 写入 `global_order` 字段；未匹配的 group 打印警告日志并置为 999 |
| 原画渲染 | `renderScene()` | 故事**先逐 group 配音**拿真实时长 `d_g`，按 24 fps 分配 panel 时间；共享场景空间约定 → 子 Agent 读图、裁剪、复看 → 短英文融合提示词 → H3 多参考图直接生视频，跳过分镜图生图。议论文的动态画面与 SC Video / SC Longtake 统一使用 H3；MG 标注/规划独立 |
| 原画母版 | `buildEpisodeMaster()` | 拼接无声原画为不可覆盖的 `epXX_raw.mp4`，输出对齐音轨、`article_timeline.json` 和全局字幕；此时尚未加入 MG、字幕或音轨 |
| MG Function Calling（仅议论文） | `planEssayMg()` | 第二次 AI 调用。AI 读取已审核 HTML 与真实字级时间轴，每个逻辑实例恰好调用一次模板函数，只为内部元素填写绝对 `at`；宿主统一从标签计算实例 start/end，根参数不接受 `at`、`startTime` 或 `endTime` |
| MG 渲染（仅议论文） | `renderAndAssembleEssayMg()` | 按 `mode` 编译动画窗口：`together` 连续渲染，`split` 只在节点运动区间显示；支持标题/重点大字嵌套覆盖，输出 `mg/epXX_mg_raw.mp4` |
| 最终封装 | `finalizeEpisodeMedia()` | 在 MG 原片上烧字幕、合入对齐音轨，再执行议论文 BGM/倍速或故事后处理；绝不修改 `epXX_raw.mp4` |

议论文的画面预设仍只读取 `原文_clean.txt`，不传入或解析 MG HTML。当前阶段结构按新项目数据设计，不提供旧 `改编进度.json` 或旧 MG 产物迁移。

## Architecture

### Entry Points
- `bin/cli.js` → `cli.ts`: CLI，命令 `/solo`、`/status`、`/help`、`/exit`
- `agent.ts`: sub-agent 基础设施（创建 session、执行、返回结果）。`runSubAgent`/`createSession` 接受可选 `cwd`（默认 `agent-data/`）；sub-agent 写相对路径时落在该 cwd（分场阶段据此传入 `scripts/`）

### Configuration
Stored in `~/.story-claw/` (not in the repo):
- `config.json`: LLM provider/model/api_key/base_url
- `image_gen_config.json`: `{ api_key, model, base_url, api_format? }` — 当前 model 为 `openai/gpt-image-2:openai`，base_url 为 `https://zenmux.ai/api/vertex-ai`；`api_format` 可显式选 `vertex` / `openai`
- `video_config.json`: 故事固定 H3，无 `story_backend` 选择。`h3_base_url` 默认 `http://127.0.0.1:8188`，必须是 ComfyUI 原生服务，不能接 LTX wrapper 的 8191；`h3_workflow_path` 留空使用内置 `workflows/minimax-h3-reference-api.json`；`h3_max_duration` 默认 15 秒。可选 `h3_concurrency=1`、`h3_max_retries=2`、`h3_poll_interval_ms=5000`、`h3_timeout_ms=1800000`。故事、议论文动态 panel 与 SC Video / SC Longtake 共用以上 H3 参数；旧 `base_url`、`workflow_path` 和 LTX 任务参数不再被生产链路读取。示例见 `video_config.example.json`
- `tts_config.json`: 豆包语音（火山引擎 语音合成大模型 V3，HTTP Chunked 单向流式）api_key（X-Api-Key）、base_url（`https://openspeech.bytedance.com/api/v3/tts/unidirectional`）、resource_id（`seed-tts-1.0`，决定可用音色版本与计费）、voices（`{voice_type: 性别}` 可分配音色池，key 为豆包 voice_type，**不应包含旁白音**）、narrator_voice（旁白专用 voice_type，独立于 voices 池）、concurrency、assign_character_voice（可选，默认 `true`；设为 `false` 时音色照常分配，但 TTS 合成时全部强制用 narrator_voice，相当于全程旁白音）、sfx_enabled（可选，默认 `true`；关闭后音效全程跳过）、sfx_volume（可选，默认 `0.7`；音效相对人声的音量 0–1）
- `sfx/`（目录，可选）: 全局音效库，放 `*.mp3`/`*.wav`，**标签 = 去扩展名的文件名**（可含空格，如 `玻璃破碎 心碎时刻`）。增删文件即增删标签，代码无需改（见「音效（SFX）」）

### Key Utilities
- `utils/paths.ts`: 所有输出路径的集中管理，**构造路径时必须使用此文件**
- `utils/image-gen.ts`: 纯 Node.js 生图统一入口，直接调用 OpenAI-compatible Images API 或 Google GenAI Vertex 网关；主模型重试 3 次后降级 `google/gemini-3.1-flash-lite-image`
- `utils/runtime-paths.ts`: 导出 `CONFIG_DIR`（默认 `~/.story-claw/`）和可由 `STORY_CLAW_WORK_DIR` 覆盖的 `WORK_DIR`
- `utils/media-binaries.ts`: 统一解析应用内置的 FFmpeg / FFprobe，并兼容 Electron `app.asar.unpacked`
- `utils/gpu-lifecycle.ts`: 纯 TypeScript CompShare 实例查询、启动、停止、状态轮询及 ComfyUI 轻量自检
- `utils/story-video-config.ts`: 独立读取故事 H3 配置、定位源码或桌面安装包中的内置 API 工作流
- `utils/h3-video.ts`: H3 多参考图上传、可选首帧 guide、工作流参数注入、有界重试、下载与 24 fps 时间轴标准化；H3 自检只读节点/模型和服务器必填输入，不提交生成任务。内置 API 从 Comfy-Org 官方 `video_minimax_h3_r2v.json` 默认非 Lightning 分支导出，来源见 `workflows/minimax-h3-reference-api.provenance.json`；保留官方 0.4 MP 分辨率选择器、INT8 视频 VAE、FP32 音频 VAE 与音视频解码/封装。原生音频保存在 `native.mp4`，panel 标准化仍移除原生音轨，最终声音由 TTS 提供
- `runner/h3-panel-preparer.ts` / `tools/h3-reference-tools.ts`: 共享场景空间约定与逐镜头参考图准备；实际读图、受限裁剪、复看后才允许提交参考图和短英文视频提示词
- `runner/story-prompt-constraints.ts`: 原分镜规划与 H3 准备共用镜头约束；H3 接收完整 `image_prompt`、`video_prompt` 和连续性上下文，裁剪服务于原镜头，不得重新设计景别、角度或动作。保留原计划合法运镜，包括满足组内可朗读字数条件的小幅拉远；guide 仅适用于同机位局部推近
- `utils/video-speed.ts`: 无丢帧视频倍速、音轨变速、可选 BGM 混音及结果校验
- `utils/title-watermark.ts`: 故事标题设计、生图、dominant-color 抠图、标题/署名水印和倍速
- `utils/progress.ts`: 改编进度读写（`readProgress` / `getEpisodeRecord` / `markStage` / `finalizeEpisode`），记录每集每阶段完成状态

### Image Generation Flow

**路径一：资源建档**（角色原型图、角色造型图、场景底图）
1. LLM sub-agent（ARCHIVE_SYSTEM）分析画面预设文本，输出 `archive-tasks` JSON 块
2. `pipeline.ts:archive()` 用正则解析 JSON，**代码直接**调用 `generateCharacterTool.execute()` / `generateSceneTool.execute()`（不是 LLM 调工具）
3. 工具内部拼接完整 prompt，调 `utils/image-gen.ts:generateImage(prompt, outputPath, images, "16:9")`
4. `image-gen.ts` 直接从 Node.js 调图像 API，失败重试 3 次，超时 600s
5. 3 次全败 → `image-gen.ts` 改调 Gemini 图像模型（只试一次）

**路径二：故事 `imagesOnly`**（每个 panel 的分镜静态图）
1. 分镜制作阶段已将每个 panel 的 `image_prompt` 写入 `storyboards/*.jsonl`；名单人物用 `[实际参考图文件名去掉.png]` 锁定身份。故事完整渲染与 `imagesOnly` 使用相同的 H3 拆镜上限
2. `render.ts:renderScene()` 读取 JSONL；`imagesOnly` 不启动 GPU、TTS 或 H3 视频生成，所有 panel 生成静态图，包括规划为 continuation 的 panel
3. 每个 panel 独立流程：`selectResources()` → `generateImage()`
   - `selectResources()`：代码主动发 chat.completions。LLM **读 `[角色名·阶段]` 标签锁定身份、从该角色现有图里按阶段挑参考图**，并把整个 `[...]` 替换为 `the person in image N`、把背景替换为 `the background in image N`，返回参考图路径 + 改写后 prompt
   - 候选资源来自 `buildResourceCatalog()`，它**扫 `characters/` 与 `scenes/` 目录**列出所有 `{name}_*.png` / `{loc}*.png`，因此用户手动放入的真人参考图也会被纳入候选
   - `render.ts` 还有兜底：若选择器漏剥离 `[...]`，按是否有参考图替换为 `the person (in image 1)`，避免中文身份词污染生图
   - `imagesOnly` 不执行尾帧接续；先生成所有静态图。之后转完整渲染时，H3 重新准备原有角色/场景参考图，不把这些静态分镜图当成必需中间输入
4. 代码调 `render.ts:generateImage(imgSem, ...)`，由共享 `utils/image-gen.ts` 直接请求图像 API，失败重试 3 次
5. 3 次全败 → 代码改调 Gemini 图像模型（只试一次）

**两条路径的共同点**：LLM 只负责生成数据，**生图始终由 Node.js 代码直接调用远程 API**，LLM 不直接触发生图。本机生产链路不需要 Python；旧 Python 辅助脚本仅作开发/历史参考，不进入桌面安装包。

**路径三：故事完整渲染**（现有资源直接生成 H3 视频）
1. 保留分镜 JSONL 的 `image_prompt`、`video_prompt`、`shot_type`、`end_positions` 与 `is_continuation`；它们是镜头计划，不再要求先生成 panel 静态图
2. 场景准备子 Agent 根据当前场景名、原文、分镜与资源目录选择实际场景源图，调用 `read_reference` 看图，再提交共享空间约定及审核过的场景源图。约定区分图中已有空间事实与本段采用的人物站位、机位侧别；后续 panel 只用这些场景源图
3. 每个 panel 准备子 Agent 只选择当前入画人物的精确角色参考图。先读源图 → 决定裁剪 → `crop_reference` → 再读裁片 → 自检身份、入画范围、动作需要的部位、场景线索和单一视角。原图已是合格单体可整图使用；四拼/多视图角色资源须裁为单一视角；每源最多三次裁剪
4. 手部等局部镜头只参考需要的部位和袖口，不带脸或全身；单人镜头不引入画外人物姓名/行为；近景只保留必要场景切片，但机位所需窗、桌、过道线索不能全部裁掉
5. 所有裁片复看通过后，再写短英文视频提示词；以 `<Picture N>` 标明用途，按共享约束继承原静态构图与动态动作，包括景别、角度、姿态、位置、必要光影/情绪、一个主要动作和原计划合法运镜。裁剪和简化不得改变镜头设计；参考图提供的外貌、服装和风格不重复。禁止新增、移动、复制家具；不加入无关人物/道具、字幕或叠加文字；对白、独白交给 TTS，不送台词原文或画外音解释到 H3
6. continuation 等待前驱视频完成，提取实际用于剪辑的标准化视频尾帧。子 Agent 必须读此帧；只有同机位局部推近且所需主体/角度已在尾帧里时提交 `guide`，由 H3 独立的 frame-zero guide 输入锁首帧；正反打、换角度或信息不足则提交 `independent`，直接用按需参考图生成
7. Node.js 上传参考图并提交 H3 API 工作流，不调用图像生成 API。输出原生视频、实际请求、标准化 panel MP4 与独立预览 PNG；参考图审核是生成前审核，不能宣称已自动保证生成视频的越轴/动作质量

**自定义参考图约定**：用户可手动把 `{角色名}_原型.png`（角色）或 `{场景名}.png` / `{场景名}_变体.png`（场景）放进 `characters/` / `scenes/`。`buildResourceCatalog` 扫目录后这些图会作为候选（描述标注为「用户提供的真实参考图」）；`list_resources` 也会在「角色/场景现有图片」段列出每个资源磁盘上现有的 PNG。角色音色以 `_原型.png` 对应的角色为单位分配（见「音色分配」）。

**尺寸规则**：
- 资源建档固定 `16:9` → `1536×1024`
- 渲染分镜使用用户选择的 `aspectRatio`（`9:16` 或 `16:9`），通过 `NovelSelection.aspectRatio` 透传到 `render.ts`
- `aspectRatio` 直接传给 TS API 适配层，目标映射：`9:16` → `1024×1536`，`16:9` → `1536×1024`

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
        ├── mg_annotation.html      # 议论文第一次 AI 的 MG 标签 HTML
        ├── article_timeline.json   # 最终倍速前的整集字级绝对时间轴
        ├── global_subtitles.json
        ├── global_subtitles.ass
        ├── ep{XX}_raw.mp4          # 不可覆盖：无 MG、无字幕、无音轨、无倍速
        ├── ep{XX}_aligned_audio.wav
        ├── mg/
        │   ├── function_calls.json
        │   ├── mg_plan.json
        │   ├── render_bundle.json
        │   ├── specs/
        │   ├── clips/
        │   └── ep{XX}_mg_raw.mp4   # 已插 MG，仍无字幕/音轨/倍速
        ├── scripts/
        │   └── {sceneName}.md
        ├── storyboards/
        │   └── storyboard_{sceneName}.jsonl
        ├── render_{sceneName}/
        │   ├── g{XX}_p{YY}.png   # imagesOnly 静态图，H3 完整渲染不要求它
        │   ├── g{XX}_p{YY}.mp4   # 标准化 H3 panel 视频，24 fps
        │   ├── g{XX}_p{YY}_preview.png # 从视频抽帧的独立预览，不覆盖静态 PNG
        │   ├── g{XX}_p{YY}_lastframe.png # continuation 实际前驱尾帧
        │   ├── story_video_backend.json # 记录已有场景视频来源，防旧 LTX 视频误复用
        │   ├── h3/
        │   │   ├── scene_plan.json # 已读场景源图、空间约定及输入哈希
        │   │   └── g{XX}_p{YY}/
        │   │       ├── {裁片标识}.png
        │   │       ├── references.json # 参考图顺序/裁剪/来源哈希/复看结论/续接策略
        │   │       ├── prompt_en.txt # 实际融合英文提示词
        │   │       ├── request.json # 实际提交的 H3 API 工作流
        │   │       ├── native.mp4 # H3 原生生成结果
        │   │       └── completed.json # panel 完成指纹与视频哈希
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
2. **故事 H3 参考准备与视频生成**：`distributeH3PanelDurations` 先将 `d_g` 换成最近的整组 24 fps 帧数，再近似均分给 panels，保证各 panel 帧数之和等于组帧数。实际目标超出 `h3_max_duration` 时在参考准备/视频请求前失败并要求增加分镜
   - 先用子 Agent 实际读取场景图，建立共享空间/机位侧别约定；逐 panel 读图、裁剪、复看，再编译短英文融合提示词
   - 普通镜头直接将按需参考图送 H3，不先生成分镜静态图
   - continuation 等待前驱 `videoEvent`，提取标准化前驱视频尾帧，再由准备子 Agent 审核 `guide` 或 `independent`；前驱失败不得用旧视频伪续接
   - `generateH3Video()` 使用独立 H3 服务/工作流/并发参数，按 `<Picture N>` 顺序上传；失败有界重试并重新随机种子。原生结果裁成目标帧数的无声 24 fps panel 视频
   - panel 缓存绑定计划、参考图/源图像素、工作流、时长、画幅与实际视频哈希；完整性失败时停止拼接
3. **group 拼接**（顺序）：统一 panel 画幅、24 fps 和 SAR，按 panel 顺序拼成 `g{XX}.mp4`；携带对应的 group 音轨和 `global_order` 返回整集合成
4. **整集母版与最终封装**：`buildEpisodeMaster()` 收集各场景 group，保持视频原速拼成无声母版，只对音频做轻微 `atempo` 对齐。故事由 `globalAlignAndMerge()` 立即调用 `finalizeEpisodeMedia()`；议论文先生成字级时间轴并插入 MG，之后才烧字幕和 mux 音轨。

> 注意：`imagesOnly` 模式仍使用与完整故事相同的 H3 拆镜上限，但跳过 GPU、TTS、H3 参考准备、生视频、拼接与合并，所有 panel 都生成静态图，且不推进章节。切换完整渲染后复用文本分镜与跨集资源，H3 直接参考现有角色/场景资源，不经过已有静态分镜图。

### GPU 启动与 H3 实际预热

`utils/gpu-lifecycle.ts:startGpu()` 先按 `gpu_config.json` 启动已配置的 CompShare 实例，再等待原生 ComfyUI 的节点和模型可用，最后实际生成一段最小合法长度的 H3 视频。预热只将采样步数降为 1，保留 0.4 MP、124 帧、视频和音频 VAE 解码链；下载原生视频、核验至少 124 帧 / 24 fps 并完整解码成功后才放行正式任务。预热失败不视作就绪，也不重复提交状态不明的任务。

`provider=external/manual` 明确跳过云实例启停；保存 API 凭据不会自动覆盖此配置。托管启动需要 `provider=compshare` 和明确的 `instance_id`。实例启动受 `start_timeout` 限制，容量不足时有界重试，超时后保留失败状态。流水线在 finally 中关机。

`scripts/grab_gpu.py` 仅兼容转调 `scripts/gpu-service.ts start`，使用同一条 H3 启动和预热路径。GPU 服务器的 `scripts/setup_autostart.sh` 安装 `systemd/story-claw-services.conf` 和 `scripts/start-h3-service.sh`，由 supervisor 在实例开机时自动启动原生 ComfyUI；可通过 `COMFYUI_DIR`、`H3_PYTHON`、`H3_PORT` 指定服务器安装位置。部署前检查现有服务，不运行旧 wrapper 启动逻辑。

旧 `pipeline_wrapper.py`、LTX 工作流及人物 Gate 脚本仅保留为历史开发资料，不被生产入口调用、打包或自动启动；H3 不继承旧 LTX 去字幕或人物 Gate 能力。

### 故事 H3 视频时长控制（`utils/h3-video.ts`）
- 帧率固定 24 fps；原生帧数为 `17k+5`，当前工作流训练/验证范围为最少 124 帧、最多 362 帧，约 5.17–15.08 秒
- 目标秒数先向上取能覆盖它的合法原生帧数，短镜头至少生成 124 帧；故事单 panel 目标最多 15 秒，可通过 `h3_max_duration` 设更低上限
- 原生视频生成后保持运动速度，按 24 fps 裁到目标帧数；异常短尾用末帧补齐，不将整段拉伸变速。最终时长精度是一帧，即约 0.0417 秒，而不是原生生成的 `17/24` 秒栅格
- group 配音时长先取最近的整组帧数，再分给 panels；全部 panel 目标帧数之和必须等于 group 帧数
- 文本分镜按同一 H3 上限留出真实 TTS 余量；`imagesOnly` 不改变拆镜上限。真实音频分配后超上限就报错，不能提交一条 18 秒 H3 请求

### 议论文与 MG H3 视频窗口

`utils/h3-clip.ts` 接收一个完整的 HTML 视频窗口，按 24 fps 总帧数分配为不超过 `h3_max_duration` 的内部片段。各段分别生成，后续段使用上一段实际剪辑尾帧作为 frame-zero guide，再拼成一个精确总帧数的视频；HTML 标签、Function Calling 参数和实例数量不拆。首帧和后续引导只约束参考，不代表自动保证无缝运镜，需要审片。

SC Video / SC Longtake 的缓存签名包含 H3 后端、工作流字节和单段上限；旧 LTX 缓存不会被复用。H3 自身处理有界重试，MG 外层不再重复重试 H3 生成，避免状态不明时再次排入 GPU 队列。既有配音、字级时间轴与字幕累计逻辑保持原样，已发现的编码填充累计问题按用户要求仍待核验。

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
- 故事阶段：`clean` / `visualPreset` / `archive` / `segment` / `storyboard` / `render`；`render` 是整集终态。
- 议论文额外阶段：`mgAnnotate` / `mgPlan` / `mgRender` / `finalize`。其中 `render=done` 只表示原画母版、对齐音轨和时间轴就绪，只有 `finalize=done` 才推进章节。
- `finalizeEpisode()` 在一次写入中设置对应终态、追加 `adapted` 并执行 `next_chapter+1`。`images_only` 不生成母版、不执行 MG，也不推进进度。
- 议论文原画完成后立即关闭远端 GPU；仅续跑 `mgPlan` / `mgRender` / `finalize` 时不会再次申请 GPU。

### Agent Data
- `agent-data/`: pi-coding-agent 框架自动创建的 session 状态
- `agent-logs/`: 各 sub-agent 的执行日志
