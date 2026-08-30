# 视频言出法随编辑（多段绿幕特效叠加）方案

本方案基于 `story-claw` 项目技术栈（Node.js/Python 管道、LLM 文本分析、VLM 视觉大模型、ComfyUI LTX 视频生成、FFmpeg 音视频处理），实现输入视频路径及语音指令后，自动识别多段特效及其双锚点范围、精确定位起止帧与点位，并通过**两阶段图生图**（先原图风格融合生成，再提取背景换绿幕）保证特效与原视频画风光影完美统一，最后生成固定镜头绿幕视频并抠图叠加合成。

---

## 一、 整体架构与流程

```
[输入原视频]
    │
    ▼
【阶段 1：字幕解析与多特效双锚点范围识别（纯 ASR + LLM）】
    ├── 1.1 ASR/字幕提取（从音频获取带时间戳文本）
    └── 1.2 LLM 文本分析（识别出 N 段特效需求，输出各特效的起始与结束锚点范围列表）
    │
    ▼
【阶段 2~5：多段特效独立循环处理 (Loop per Effect)】
    ┌─ 遍历每段特效 effect_i (i = 01, 02, ... N)：
    │   ├── 2. VLM 精确定位起止锚点：得出该特效的精确 t_start 与 t_end
    │   ├── 3. 起锚点打点与定位图：截取 t_start 帧，VLM 坐标打点并绘制颜色标记点
    │   │
    │   ├── 4. 两阶段图生图（保证风格融合 + 提取绿幕）
    │   │   ├── 4.1 阶段一图生图（风格融合）：在定位图上生成特效，使其与原图画风、光影、透视完美贴合
    │   │   └── 4.2 阶段二图生图/抠图（背景换绿幕）：保留该特效，将非特效背景（人物/场景）替换为纯绿幕 (#00FF00)
    │   │
    │   └── 5. 固定镜头绿幕视频生成：依据 D=t_end-t_start 换算帧数，固定镜头 Prompt 生成绿幕视频
    └─────────────────────────────────────────────────────
    │
    ▼
【阶段 6：多特效抠图与统一图层叠加合成】
    ├── 6.1 批量 FFmpeg Chromakey：扣除每段特效视频的绿幕背景，生成各自 Alpha 透明视频
    └── 6.2 FFmpeg 多图层 Overlay：通过 filter_complex 将 N 个透明特效视频按各自 [t_start, t_end] 叠加至原视频
    │
    ▼
[导出最终编辑视频]
```

---

## 二、 核心阶段与多段特效设计

### 阶段 1：字幕解析与多特效双锚点范围识别（纯 ASR + LLM）
1. **字幕提取**：FFmpeg 从视频抽离音频，ASR 提取带时间戳字幕。
2. **LLM 解析多特效**：纯 LLM 分析字幕，输出特效列表（包含 `start_anchor_window` 与 `end_anchor_window`）。

---

### 阶段 2：VLM 精确定位起止锚点
VLM 扫描该特效的 `start_anchor_window` 与 `end_anchor_window` 帧序列，判定精确的 $t_{start}$ 与 $t_{end}$。

---

### 阶段 3：起锚点关键帧打点与定位图生成（VLM）
截取该特效 $t_{start}$ 单帧 `frame_start.png`，VLM 输出坐标点，绘制颜色标记生成定位图 `location_ref.png`。

---

### 阶段 4：两阶段图生图（风格融合 + 提取绿幕特效图）
为了解决直出绿幕导致特效与原视频画风、光影割裂的问题，采用**两阶段图生图**策略：

1. **第一阶段：风格融合图生图（原图上下文融合）**
   - **输入**：定位图 `location_ref.png`。
   - **Prompt**：“将红色的点替换为[特效描述]，保持与原图完全一致的艺术风格、光影照射和透视关系”。
   - **输出**：`effect_in_scene.png`（特效完美融入原场景的合影图，画风与光影 100% 匹配原视频）。

2. **第二阶段：提取特效并替换绿幕**
   - **输入**：第一阶段产出的 `effect_in_scene.png`。
   - **Prompt / 处理**：“仅保留图像中的[特效部分]，将所有背景、人物和原场景全部替换为纯绿幕 (chroma key green screen background, #00FF00)”。
   - **输出**：`effect_init_green.png`（具备原视频同款画风与光影、且背景为纯绿幕的特效起始状态图）。

---

### 阶段 5：固定镜头绿幕特效视频生成
1. 依据 $D = t_{end} - t_{start}$ 换算 LTX 帧数 ($8k+1$)。
2. 视频 Prompt 描述特效从起始形态演变的动态过程，**强制要求镜头固定（fixed camera, static shot）**。
3. 以 `effect_init_green.png` 为参考图，提交 ComfyUI LTX i2v 生成 `greenscreen_effect.mp4`。

---

### 阶段 6：多特效抠图与统一图层叠加合成
1. **批量 FFmpeg Chromakey**：扣除绿幕背景生成透明视频 `keyed_effect.mov`。
2. **多图层 Overlay 叠加**：构建 FFmpeg `filter_complex` 表达式，按各自 $[t_{start\_i}, t_{end\_i}]$ 时间段一次性叠加回原视频 `original_video.mp4`。

---

## 三、 如何整合到 Story Claw 项目架构

### 1. 新建管道工作流文件 (`runner/video-editor.ts`)
在 `runner/` 目录下新建 `video-editor.ts`，编排 ASR $\to$ LLM解析 $\to$ VLM打点 $\to$ **两阶段图生图** $\to$ LTX视频生成 $\to$ FFmpeg抠图合成的流水线，并记录 `edit_progress.json`。

### 2. CLI 命令与入口扩展 (`cli.ts` / `bin/cli.js`)
新增 `/edit <video_path>` 命令，中间文件与产物统一存储至 `output_videos/edits/{task_id}/`。

### 3. LLM/VLM Sub-Agent 协作分工设计

| Sub-Agent 角色 | 模型类型 | 核心职责 | 输入 / 输出 |
| :--- | :--- | :--- | :--- |
| **1. 字幕指令解析 Agent** (`SUB_SUBTITLE_PARSER`) | **纯 LLM** | 分析 ASR 字幕，识别特效意图，输出多段特效的【起始锚点范围】与【结束锚点范围】窗口 | **入**：字幕 JSON<br>**出**：`effects_manifest.json` |
| **2. 视觉锚点与打点 Agent** (`SUB_VISUAL_LOCATOR`) | **VLM** | 1. 扫描双锚点窗口内图片帧，精确判定起止时间戳 $t_{start}, t_{end}$<br>2. 分析 $t_{start}$ 帧图像，输出特效落点坐标 `Point(x,y)` | **入**：窗口图片帧序列<br>**出**：精确 $t_{start}, t_{end}$ 及落点坐标 |
| **3. 特效提示词专家 Agent** (`SUB_PROMPT_DESIGNER`) | **纯 LLM** | 1. 生成**第一阶段 Prompt**（红点替换为特效，融合原图画风光影）<br>2. 生成**第二阶段 Prompt**（仅保留特效，背景换纯绿幕 #00FF00）<br>3. 生成**视频 Prompt**（动态描述 + **强制指定镜头固定**） | **入**：特效需求与坐标<br>**出**：`image_prompt_stage1`, `image_prompt_stage2`, `video_prompt` |

---

## 四、 多特效文件与目录结构设计

```
workspace/video_edits/
└── {task_id}/
    ├── original_video.mp4          # 原始输入视频
    ├── audio.wav                   # 抽离音频
    ├── subtitle.json               # ASR 字幕
    ├── effects_manifest.json       # 多段特效配置与起止时间总表
    ├── effects/                    # 多特效隔离目录
    │   ├── effect_01/              # 特效 1 专属目录
    │   │   ├── frame_start.png     # 特效 1 起锚点 t_start 帧
    │   │   ├── location_ref.png    # 特效 1 标记点定位图
    │   │   ├── effect_in_scene.png # 【新增】阶段一：画风光影融合的场景特效图
    │   │   ├── effect_init_green.png # 【新增】阶段二：背景换纯绿幕的特效起始图
    │   │   ├── greenscreen_effect.mp4 # 特效 1 固定镜头绿幕视频
    │   │   └── keyed_effect.mov    # 特效 1 Chroma Keying 透明视频
    │   │
    │   ├── effect_02/              # 特效 2 专属目录
    │   │   ├── frame_start.png
    │   │   ├── location_ref.png
    │   │   ├── effect_in_scene.png
    │   │   ├── effect_init_green.png
    │   │   ├── greenscreen_effect.mp4
    │   │   └── keyed_effect.mov
    │   │
    │   └── ...
    └── output_edited.mp4           # 最终多特效叠加合成视频
```

---

## 五、 复用当前项目组件

| 功能模块 | 复用现有代码/组件 | 多特效与两阶段图生图适配说明 |
| :--- | :--- | :--- |
| **字幕/文本分析** | 现有 LLM 流程 (`agent.ts`) | Agent 1 提取多段特效数组及双锚点范围 |
| **生图 (图生图)** | `utils/image-gen.ts` | 连续调用两阶段图生图：第一阶段画风融合，第二阶段提取纯绿幕 |
| **视频生成** | `pipeline_wrapper.py` + LTX 工作流 | 以第二阶段产出的绿幕图为参考，生成固定镜头绿幕视频 |
| **视觉打点/锚点决策** | VLM 接口 | Agent 2 独立进行双锚点精确决策与起锚点坐标打点 |
| **音视频合成** | FFmpeg 交互逻辑 | 封装多输入 `filter_complex` 实现多层透明视频叠加 |
