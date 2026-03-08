# Vision Builder

[English](./README.md) | 中文

**AI 驱动的小说转短剧分镜生成工具。** 输入网文章节，全自动输出带画面的分镜图片。

从小说原文到可视化分镜，Vision Builder 将完整流水线封装为一条命令：剧本改编 → 结构化解析 → 角色/场景图生成 → 分镜构图 → 最终画面合成。

---

## 工作原理

Vision Builder 通过多个 AI 智能体协作，将小说文本逐集改编为短剧分镜：

```
小说章节 (.txt)
    │
    ▼
┌─────────────────────────────────────────────┐
│  A  剧本创作    LLM 智能体改编为短剧剧本     │
│  B  剧本解析    LLM 智能体提取结构化数据      │
│  C  资源生成    Gemini 生成角色参考图/场景底图  │
│  E  合成帧      角色 + 场景底图合成 → 校验     │
│  F  分镜画面    LLM 导演构图 → Gemini 生成面板  │
└─────────────────────────────────────────────┘
    │
    ▼
分镜图片 + 剧本 (.md) + 结构化数据 (.json)
```

### 核心特性

- **全流程自动化** — 一条命令完成从小说到分镜图片的全部工作
- **多 LLM 支持** — OpenAI / Anthropic / Google，可配置自定义 API 端点
- **智能体架构** — 每个阶段由专门的 AI 智能体执行，工具化调用，可追溯
- **增量生成** — 角色和场景图跨集复用，只生成新增资源
- **进度续编** — 记录已改编集数、剧情摘要、悬念线索，支持中断后继续
- **滑动窗口** — 超长小说自动截断，上下文预算 80K 字符，避免 token 溢出
- **校验循环** — 合成帧经 AI 校验，不合格自动重试（最多 4 次）
- **并行执行** — 场景级和 beat 级并行，充分利用 API 并发
- **资源可替换** — Custom 模式下暂停，手动替换角色/场景图后再继续

---

## 安装

### 全局安装（推荐）

```bash
npm install -g vision-builder
```

### 本地开发

```bash
git clone https://github.com/ZC89757/vision-builder.git
cd vision-builder
npm install
npm start
```

### 环境要求

- **Node.js** >= 18
- **LLM API Key** — OpenAI / Anthropic / Google 任选其一
- **Gemini API Key** — 用于图像生成（需支持 `generateContent` + `IMAGE` 输出）

---

## 快速开始

### 1. 首次运行配置

```bash
vision-builder
```

首次运行会进入交互式配置向导，引导你填写两个配置文件：

| 配置文件 | 用途 | 存储位置 |
|----------|------|----------|
| `config.json` | LLM 智能体（剧本改编/解析/分镜导演） | `~/.vision-builder/` |
| `image_gen_config.json` | Gemini 图像生成 API | `~/.vision-builder/` |

### 2. 准备小说文件

在任意目录下创建小说文件夹，按章节拆分为 `.txt` 文件：

```
我的小说/
├── 第1章 开端.txt
├── 第2章 迷雾.txt
├── 第3章 真相.txt
└── ...
```

> 文件名格式：`第{N}章 {标题}.txt`

### 3. 运行

```bash
cd 你的工作目录
vision-builder
```

进入交互界面后：

```
  /solo      全自动模式 — 选择小说后一键完成
  /custom    自定义模式 — 资源生成后暂停，可手动替换图片
  /status    查看所有小说的改编进度
```

### 4. 产物目录

生成结果存放在工作目录的 `workspace/` 下：

```
workspace/
└── 我的小说/
    ├── 改编进度.json
    ├── characters/            角色参考图（跨集共享）
    │   ├── 张三.png
    │   └── 李四.png
    ├── scenes/                场景底图（跨集共享）
    │   ├── 教室.png
    │   └── 操场.png
    └── ep01/                  第1集
        ├── 我的小说_第1集.md       剧本
        ├── scene_data.json         结构化场景数据
        ├── panels_scene_01_beat01.json   分镜构图（含每帧画面描述）
        ├── panels_scene_01_beat02.json
        ├── ...
        ├── character_frames/       合成帧（角色+场景）
        │   ├── frame_01.png
        │   └── ...
        └── storyboard_panels/      最终分镜图片
            ├── panel_0001.png
            └── ...
```

**`panels_*.json` 是连接分镜图片与剧本的关键文件。** 每个文件对应一个场景的一个 beat，内含逐帧的完整画面描述（景别、角色、表情、动作、背景细节）。它既是生成分镜图片的输入 prompt，也可以直接作为后续视频制作的分镜脚本——每帧 prompt 与 `storyboard_panels/` 下的图片一一对应：

```json
{
  "scene_id": "scene_03",
  "beat_num": 1,
  "beat_title": "魏俊熙与学姐在报到台前",
  "panel_count": 6,
  "panels": [
    {
      "id": 1,
      "prompt": "以全景景别拍摄，大学新生报到处走廊，穿白色短袖T恤背单肩包的男生站在报到台来访侧..."
    },
    {
      "id": 2,
      "prompt": "以近景景别拍摄，穿红色志愿者马甲内搭白色衬衫的女生，面对镜头..."
    }
  ]
}
```

---

## 配置

### LLM 配置 (`~/.vision-builder/config.json`)

```json
{
  "provider": "openai",
  "model": "gpt-4o",
  "api_key": "sk-...",
  "base_url": "https://your-proxy.com/v1"
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `provider` | 是 | `openai` / `anthropic` / `google` |
| `model` | 是 | 模型 ID |
| `api_key` | 是 | API 密钥 |
| `base_url` | 否 | 自定义端点，不填则使用官方 API |

### 图像生成配置 (`~/.vision-builder/image_gen_config.json`)

```json
{
  "api_key": "sk-...",
  "model": "gemini-2.0-flash-exp-image-generation",
  "base_url": "https://generativelanguage.googleapis.com"
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `api_key` | 是 | Gemini API 密钥 |
| `model` | 是 | 支持图像生成的 Gemini 模型 |
| `base_url` | 是 | API 端点 |

---

## 运行模式

### Solo 模式 (`/solo`)

全自动执行，无需人工干预：

```
A 剧本创作 .......... 完成  我的小说_第1集.md
B 剧本解析 .......... 完成  scene_data.json
C 资源生成 .......... 完成  角色2 场景3 跳过1
E+F 分镜与画面 ...... 进行中
    分镜导演  ████████░░░░░░░░ 5/10
    画面合成  ██████░░░░░░░░░░ 3/10
```

### Custom 模式 (`/custom`)

资源生成后暂停，展示角色和场景图目录，你可以用自己的图片替换：

```
  ──────────────────────────────────────────────────
  资源已就绪，请检查并按需替换：

  角色参考图: workspace/我的小说/characters/
    张三.png  李四.png

  场景底图:   workspace/我的小说/scenes/
    教室.png  操场.png

  替换方法：将自己的图片放入目录，同名覆盖即可。
  ──────────────────────────────────────────────────
  按 Enter 继续生成分镜...
```

---

## 流水线详解

### Stage A — 剧本创作

LLM 智能体扫描小说章节，从专业编剧角度决定改编范围，生成短剧剧本（Markdown 格式）。内置改编原则：忠于原著、场景连贯、每集必须有钩子、内心转视觉、台词口语化。

### Stage B — 剧本解析

LLM 智能体将剧本 Markdown 解析为结构化 JSON（`scene_data.json`），提取场景、角色、位置、情绪、动作等信息。

### Stage C — 资源生成

调用 Gemini API 为每个新角色生成参考图（多角度 + 面部特写），为每个新场景生成空背景底图。已有资源自动跳过。

### Stage E — 合成帧

将角色参考图与场景底图合成为「合成帧」，经 AI 校验智能体检查人物完整性和空间合理性。校验不通过则自动重试。

### Stage F — 分镜画面

LLM 分镜导演智能体为每个 beat 设计镜头构图（远景/中景/近景/特写），生成完整的画面描述 prompt。然后调用 Gemini 以合成帧为参考，生成最终分镜图片。

---

## 项目结构

```
vision-builder/
├── bin/cli.js              CLI 入口（shebang）
├── cli.ts                  交互式命令行界面
├── agent.ts                智能体基础设施（Session / Sub-agent）
├── runner/
│   ├── pipeline.ts         核心流水线（Stage A/B/C/E+F）
│   ├── solo.ts             全自动模式
│   └── custom.ts           自定义模式
├── tools/
│   ├── scan-novel.ts       小说扫描（滑动窗口读取）
│   ├── save-script.ts      剧本保存 + 进度更新
│   ├── parse-script.ts     剧本结构化解析
│   ├── generate-character.ts  角色参考图生成
│   ├── generate-scene.ts   场景底图生成
│   ├── direct-storyboard.ts  分镜构图设计
│   ├── generate-images.ts  合成帧 + 分镜图片 + 校验
│   ├── schemas.ts          JSON Schema 定义
│   └── index.ts            工具导出
├── ui/
│   ├── welcome.ts          启动界面
│   ├── select.ts           小说选择/创建
│   ├── status.ts           进度展示
│   └── progress.ts         实时进度条
└── utils/
    ├── run-python.ts       全局路径常量（CONFIG_DIR / WORK_DIR）
    ├── paths.ts            统一路径管理
    ├── image-gen.ts        Gemini 图像生成接口
    └── setup.ts            首次运行引导
```

---

## 常见问题

### 支持哪些小说格式？

目前支持 `.txt` 格式，文件名需匹配 `第{N}章 {标题}.txt`。

### 超长小说会不会 token 爆炸？

不会。内置滑动窗口机制，单次最多读取约 80K 字符。连续改编时自动加载上 2 集的回顾章节 + 后续待改编章节。

### 可以用国内 API 代理吗？

可以。在 `config.json` 和 `image_gen_config.json` 中设置 `base_url` 即可。

### 生成的图片质量不满意怎么办？

使用 `/custom` 模式，在资源生成后暂停，用你自己的角色图/场景图替换，再继续生成分镜。

### 中途失败了怎么办？

进度保存在 `改编进度.json` 中，重新运行会从上次的下一集继续。角色和场景资源不会重复生成。

### 生成效果

<img width="1204" height="820" alt="image" src="https://github.com/user-attachments/assets/2f7e1053-8a72-42d7-abad-6e0d6120c2d9" />

---


## 技术栈

- **Runtime** — Node.js + [tsx](https://github.com/privatenumber/tsx)
- **Agent Framework** — [@mariozechner/pi-coding-agent](https://www.npmjs.com/package/@mariozechner/pi-coding-agent)
- **Image Generation** — Google Gemini API (txt2img / img2img)
- **Schema Validation** — [@sinclair/typebox](https://github.com/sinclairzx81/typebox)

---

## License

MIT
