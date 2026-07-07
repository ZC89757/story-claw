```
科技最终还是要服务于人的。真正的生产力不在于你用AI养了多少只猴子，而在于你用AI为自己打造出一把趁手的兵器。
```
# Story Claw

<p>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen" alt="Node >= 18">
  <img src="https://img.shields.io/github/last-commit/ZC89757/story-claw" alt="Last commit">
</p>

[English](./README.md) | 中文

丢一个小说章节文件夹进去，一条命令拿回一集配好音、配好乐、加了音效的成片短剧。如果你想把网文改编成短剧，又不想为视频生成按秒付费、也不想自己盯着人物一致性手动纠错，这个工具就是照着这个需求做的。

[![演示视频](assets/demo-thumb.jpg)](https://github.com/ZC89757/story-claw/raw/main/assets/demo.mp4)

*点击播放。以上为 Story Claw 全自动生成的成片，未做任何手动剪辑：剧本改编 → 角色/场景生图 → 分镜构图 → 配音+BGM+音效 → 视频渲染。*

---

## 用 AI 改编一部两百章小说会踩的坑

自己动手做过小说转视频自动化的人，做到很多章的时候总会遇到人物腿断了或者受伤了，但是参考图还是初始的样子；每个角色说话的声音都一样，音色一致性无法保证；同一段视频重复抽卡。

Story Claw 的流水线就是针对这些问题设计的：

- **角色和场景按阶段演进。** 每个角色只生成一张原型图，只有当**服装或随身道具**发生真正的视觉变化时才补一张"造型图"——开学报到背单肩包 → 出事故后坐轮椅 → 打完架衣服脏破。场景同理，光线/时间/道具变了定义为新阶段（"教室，开学第一天，明亮的下午" vs "教室，考试夜晚，只有一盏灯闪烁"）。是否需要新阶段由每章内容判断，两百章的小说不会每章都重新生图，角色的状态也会随着剧情的变化而变化。
- **每段视频出片前都要过视觉大模型的审核。** 一个自定义 ComfyUI 节点会在生成流程内部，把每段视频的首尾帧让 VLM 判断：主体人物首尾是否是同一个人？有没有凭空多长出一张脸？去完字幕之后画面上还有没有残留的文字鬼影？没通过就在流程内静默重来。
- **一个角色从头到尾一个声音。** 角色第一次开口时，会从音色池里分配一个 TTS 音色，写进这部小说专属的音色映射表；之后不管第几章、第几集，都按角色名查表复用同一个音色。旁白有专属音色，不会跟角色池混用。
- **视频模型跑在自己的 GPU 上。** 渲染阶段是自己部署的 [ComfyUI](https://github.com/comfyanonymous/ComfyUI) + LTX-2.3 图生视频工作流，中间没有可灵、Seedance 那种按秒计费的商业接口。
- **画面实际生成用 `gpt-image-2`。** 面对这套流水线常见的那种"人物身份+姿态+构图+光影"多约束同时给出的密集提示词，对比其他模型gpt-image2效果最好。

---

## 工作原理

每一集按顺序跑五个阶段，分别由 LLM 子智能体或直接的 API 调用驱动：

```
小说章节 (.txt)
    │
    ▼
┌────────────────────────────────────────────────────────────┐
│ 1  画面预设   逐句标注：场景/人物/景别/角度/镜头运动/情绪     │
│ 2  资源建档   识别角色与场景；生成带阶段感知的参考图 + 分配音色│
│ 3  剧本分场   按场景把原文切分为独立剧本                      │
│ 4  分镜制作   逐场景设计分镜，产出图片/视频 prompt            │
│ 5  渲染合成   TTS → BGM → 音效 → 分镜图片 → 视频片段          │
│              （经 VLM 质检）→ 最终成片                        │
└────────────────────────────────────────────────────────────┘
    │
    ▼
ep{N}.mp4
```

---

## 安装

### 全局安装（推荐）

```bash
npm install -g story-claw
```

### 本地开发

```bash
git clone https://github.com/ZC89757/story-claw.git
cd story-claw
npm install
npm start
```

### 环境要求

- **Node.js** >= 18
- **LLM API Key** — OpenAI / Anthropic / Google 任选其一，驱动全部子智能体
- **图像生成 API** — 推荐 `gpt-image-2`，也可用 Gemini 系图像模型
- **TTS API Key** — 用于配音与台词合成
- **一个 ComfyUI 实例**（自己部署，本地机器或租用 GPU 均可），跑 LTX 图生视频工作流
- *（可选）* BGM 生成接口 + 本地音效库（`.mp3`/`.wav`），用于背景音乐和音效

---

## 快速开始

### 1. 首次运行配置

```bash
story-claw
```

首次运行会进入交互式配置向导，引导你填写所需配置文件（见下方[配置](#配置)），统一存放在 `~/.story-claw/`。

### 2. 准备小说文件

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
story-claw
```

```
  /solo      全自动模式 — 选择小说，改编并渲染下一集
  /status    查看所有小说的改编进度
  /help      查看帮助
  /exit      退出
```

### 4. 产物目录

```
workspace/
└── 我的小说/
    ├── 改编进度.json          # 跨集进度
    ├── voice_map.json         # 角色 → TTS 音色映射（跨集共享，全剧统一）
    ├── characters/            # 角色参考图（跨集共享）
    │   ├── 张三.json
    │   ├── 张三_原型.png          # 基础原型
    │   └── 张三_{阶段}.png        # 造型阶段变体（服装/道具变化时才生成）
    ├── scenes/                # 场景底图（跨集共享）
    │   ├── 教室.json
    │   └── 教室.png
    └── ep01/                  # 第1集
        ├── 画面预设.txt
        ├── scripts/               # 分场剧本
        ├── storyboards/           # 各场景分镜数据（图片/视频 prompt）
        ├── render_{场景名}/       # 分镜图片、分镜/场景视频片段、配音音频
        ├── render.log
        └── ep01.mp4               # 最终渲染成片
```

---

## 配置

所有配置文件都放在 `~/.story-claw/`，首次运行的配置向导会引导你逐个创建。

| 配置文件 | 用途 |
|----------|------|
| `config.json` | 驱动全部子智能体的 LLM provider/model/API key |
| `image_gen_config.json` | 图像生成 API（推荐 `gpt-image-2`） |
| `video_config.json` | ComfyUI 地址、LTX 工作流路径、视频时长/并发 |
| `tts_config.json` | TTS provider、可分配音色池、专属旁白音、并发度 |
| `sfx/`（可选） | 本地音效库 — 放入 `.mp3`/`.wav` 文件，标签取自文件名 |

<details>
<summary>示例：<code>config.json</code></summary>

```json
{
  "provider": "openai",
  "model": "gpt-4o",
  "api_key": "sk-...",
  "base_url": "https://your-proxy.com/v1"
}
```
</details>

<details>
<summary>示例：<code>image_gen_config.json</code></summary>

```json
{
  "api_key": "sk-...",
  "model": "openai/gpt-image-2",
  "base_url": "https://your-api-endpoint.com/api/vertex-ai"
}
```
</details>

---

## 常见问题

### 支持哪些小说格式？

目前支持 `.txt` 格式，文件名需匹配 `第{N}章 {标题}.txt`。

### 生视频要另外付费吗？

不需要。生视频阶段调用的是你自己部署的 ComfyUI 实例（跑 LTX 图生视频工作流），算力自备，不是按次计费的商业视频 API。

### 角色什么时候会补生成新的参考图？

只有服装或随身道具发生真正的视觉变化时才会——从"刚入学"变成"出事故后坐轮椅"算，情绪、地点、光线的变化不算。这样长篇小说不会一直重复生图，但也不会漏掉真正的造型变化。

### 视频模型生成的某段视频翻车了怎么办？

有一道基于 VLM 的质检 Gate，检查每段视频首尾帧的人物一致性、有没有凭空捏造人脸，以及去字幕后有没有残留文字。没通过会在限定次数内自动重新生成；到了重试上限就放行，不会卡住整集渲染。

### 中途失败了怎么办？

进度按集、按阶段记录在 `改编进度.json` 中，重新运行同一集会跳过已完成的阶段，只补齐缺失的部分。

---

## 技术栈

- **Runtime** — Node.js + [tsx](https://github.com/privatenumber/tsx)
- **Agent Framework** — [@mariozechner/pi-coding-agent](https://www.npmjs.com/package/@mariozechner/pi-coding-agent)
- **图像生成** — `gpt-image-2`（主力），Gemini 系图像模型（降级）
- **视频生成** — 自建 [ComfyUI](https://github.com/comfyanonymous/ComfyUI) + LTX-2.3 图生视频，自定义节点实现 VLM 质检
- **语音合成** — 支持字级时间戳的 TTS（驱动音效精确定位）+ 全剧统一的角色音色分配
- **Schema 校验** — [@sinclair/typebox](https://github.com/sinclairzx81/typebox)

---

## License

MIT
