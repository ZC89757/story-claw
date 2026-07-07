```
Technology ultimately has to serve people. True productivity does not lie in how many monkeys you raise with AI, but in how you use AI to create an effective tool for yourself.
```
# Story Claw

English | [中文](./README_CN.md)

**AI-powered novel-to-storyboard pipeline.** Feed in novel chapters, get fully illustrated storyboard panels automatically.

From raw novel text to visual storyboards, Story Claw wraps the entire pipeline into a single command: script adaptation → structured parsing → character/scene image generation → shot composition → final panel synthesis.

---

## How It Works

Story Claw orchestrates multiple AI agents to adapt novel text into short drama storyboards, episode by episode:

```
Novel Chapters (.txt)
    │
    ▼
┌──────────────────────────────────────────────────────┐
│  A  Script Writing    LLM agent adapts novel to script│
│  B  Script Parsing    LLM agent extracts structured   │
│  C  Asset Generation  Gemini generates character/scene │
│  E  Composite Frames  Character + scene → validation   │
│  F  Panel Rendering   LLM director → Gemini panels    │
└──────────────────────────────────────────────────────┘
    │
    ▼
Storyboard Panels + Script (.md) + Structured Data (.json)
```

### Key Features

- **End-to-end automation** — One command from novel text to storyboard images
- **Multi-LLM support** — OpenAI / Anthropic / Google, with custom API endpoint support
- **Agent architecture** — Each stage runs as a dedicated AI agent with tool-based invocation and full traceability
- **Incremental generation** — Character and scene images are shared across episodes; only new assets are generated
- **Progress continuity** — Tracks adapted episodes, plot summaries, and open hooks; supports resuming after interruption
- **Sliding window** — Automatically truncates long novels with an 80K character context budget to prevent token overflow
- **Validation loop** — Composite frames are validated by an AI agent; failed frames are retried up to 4 times
- **Parallel execution** — Scene-level and beat-level parallelism for maximum API throughput
- **Replaceable assets** — Custom mode pauses after asset generation so you can swap in your own character/scene images

---

## Installation

### Global Install (Recommended)

```bash
npm install -g story-claw
```

### Local Development

```bash
git clone https://github.com/ZC89757/story-claw.git
cd story-claw
npm install
npm start
```

### Requirements

- **Node.js** >= 18
- **LLM API Key** — OpenAI / Anthropic / Google (pick one)
- **Gemini API Key** — For image generation (must support `generateContent` with `IMAGE` output)

---

## Quick Start

### 1. First-Run Setup

```bash
story-claw
```

On first launch, an interactive setup wizard guides you through creating two config files:

| Config File | Purpose | Location |
|-------------|---------|----------|
| `config.json` | LLM agent (script writing / parsing / storyboard director) | `~/.story-claw/` |
| `image_gen_config.json` | Gemini image generation API | `~/.story-claw/` |

### 2. Prepare Novel Files

Create a novel folder with chapters split into `.txt` files:

```
my-novel/
├── 第1章 Beginning.txt
├── 第2章 Mystery.txt
├── 第3章 Truth.txt
└── ...
```

> File naming format: `第{N}章 {title}.txt` (Chinese chapter naming convention)

### 3. Run

```bash
cd your-working-directory
story-claw
```

Interactive CLI commands:

```
  /solo      Auto mode — select a novel and run the full pipeline
  /custom    Custom mode — pause after asset generation to swap images
  /status    View adaptation progress for all novels
```

### 4. Output Directory

Generated results are stored in `workspace/` under your working directory:

```
workspace/
└── my-novel/
    ├── 改编进度.json
    ├── characters/            Character reference images (shared across episodes)
    │   ├── Alice.png
    │   └── Bob.png
    ├── scenes/                Scene backgrounds (shared across episodes)
    │   ├── classroom.png
    │   └── playground.png
    └── ep01/                  Episode 1
        ├── my-novel_第1集.md       Script
        ├── scene_data.json         Structured scene data
        ├── panels_scene_01_beat01.json   Shot composition (per-frame descriptions)
        ├── panels_scene_01_beat02.json
        ├── ...
        ├── character_frames/       Composite frames (character + scene)
        │   ├── frame_01.png
        │   └── ...
        └── storyboard_panels/      Final storyboard images
            ├── panel_0001.png
            └── ...
```

**`panels_*.json` files bridge storyboard images and the script.** Each file corresponds to one beat of a scene and contains per-frame visual descriptions (shot type, characters, expressions, actions, background details). They serve as both the input prompts for panel generation and a ready-made storyboard reference for downstream video production — each frame prompt maps 1:1 to images in `storyboard_panels/`:

```json
{
  "scene_id": "scene_03",
  "beat_num": 1,
  "beat_title": "Wei Junxi meets the senior at the registration desk",
  "panel_count": 6,
  "panels": [
    {
      "id": 1,
      "prompt": "Wide shot of a university registration hallway. A young man in a white T-shirt with a shoulder bag stands at the visitor side of the desk..."
    },
    {
      "id": 2,
      "prompt": "Close-up of a young woman in a red volunteer vest over a white shirt, facing the camera..."
    }
  ]
}
```

---

## Configuration

### LLM Config (`~/.story-claw/config.json`)

```json
{
  "provider": "openai",
  "model": "gpt-4o",
  "api_key": "sk-...",
  "base_url": "https://your-proxy.com/v1"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `provider` | Yes | `openai` / `anthropic` / `google` |
| `model` | Yes | Model ID |
| `api_key` | Yes | API key |
| `base_url` | No | Custom endpoint; omit to use the official API |

### Image Generation Config (`~/.story-claw/image_gen_config.json`)

```json
{
  "api_key": "sk-...",
  "model": "gemini-2.0-flash-exp-image-generation",
  "base_url": "https://generativelanguage.googleapis.com"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `api_key` | Yes | Gemini API key |
| `model` | Yes | Gemini model with image generation support |
| `base_url` | Yes | API endpoint |

---

## Run Modes

### Solo Mode (`/solo`)

Fully automated, no manual intervention:

```
A Script Writing .... Done   my-novel_ep01.md
B Script Parsing .... Done   scene_data.json
C Asset Generation .. Done   chars:2 scenes:3 skipped:1
E+F Storyboard ...... In Progress
    Director   ████████░░░░░░░░ 5/10
    Rendering  ██████░░░░░░░░░░ 3/10
```

### Custom Mode (`/custom`)

Pauses after asset generation to let you review and replace images:

```
  ──────────────────────────────────────────────────
  Assets ready. Review and replace as needed:

  Character refs: workspace/my-novel/characters/
    Alice.png  Bob.png

  Scene backgrounds: workspace/my-novel/scenes/
    classroom.png  playground.png

  To replace: drop your own images into the directory with the same filename.
  ──────────────────────────────────────────────────
  Press Enter to continue generating storyboards...
```

---

## Pipeline Details

### Stage A — Script Writing

An LLM agent scans novel chapters and adapts them into a short drama script (Markdown format) from a professional screenwriter's perspective. Built-in adaptation principles: faithfulness to source material, scene continuity, cliffhangers at episode endings, inner thoughts converted to visuals, dialogue kept colloquial.

### Stage B — Script Parsing

An LLM agent parses the Markdown script into structured JSON (`scene_data.json`), extracting scenes, characters, locations, emotions, actions, and more.

### Stage C — Asset Generation

Calls the Gemini API to generate reference images for each new character (multi-angle + facial close-up) and empty background images for each new location. Existing assets are automatically skipped.

### Stage E — Composite Frames

Merges character reference images with scene backgrounds into "composite frames", which are then validated by an AI agent for character completeness and spatial correctness. Failed frames are automatically retried.

### Stage F — Panel Rendering

An LLM storyboard director agent designs shot composition for each beat (wide / medium / close-up / extreme close-up) and generates complete visual description prompts. Gemini then renders the final storyboard panels using composite frames as reference.

---

## Project Structure

```
story-claw/
├── bin/cli.js              CLI entry point (shebang)
├── cli.ts                  Interactive command-line interface
├── agent.ts                Agent infrastructure (Session / Sub-agent)
├── runner/
│   ├── pipeline.ts         Core pipeline (Stages A/B/C/E+F)
│   ├── solo.ts             Full automation mode
│   └── custom.ts           Custom mode with pause
├── tools/
│   ├── scan-novel.ts       Novel scanner (sliding window)
│   ├── save-script.ts      Script persistence + progress updates
│   ├── parse-script.ts     Script structured parsing
│   ├── generate-character.ts  Character reference image generation
│   ├── generate-scene.ts   Scene background generation
│   ├── direct-storyboard.ts  Shot composition design
│   ├── generate-images.ts  Composite frames + panel images + validation
│   ├── schemas.ts          JSON Schema definitions
│   └── index.ts            Tool exports
├── ui/
│   ├── welcome.ts          Startup screen
│   ├── select.ts           Novel selection / creation
│   ├── status.ts           Progress display
│   └── progress.ts         Real-time progress bars
└── utils/
    ├── run-python.ts       Global path constants (CONFIG_DIR / WORK_DIR)
    ├── paths.ts            Centralized path management
    ├── image-gen.ts        Gemini image generation interface
    └── setup.ts            First-run setup wizard
```

---

## FAQ

### What novel formats are supported?

Currently `.txt` files with the naming pattern `第{N}章 {title}.txt`.

### Will long novels cause token overflow?

No. A built-in sliding window mechanism limits each read to ~80K characters. When adapting continuously, the system automatically loads review chapters from the last 2 episodes plus upcoming chapters to be adapted.

### Can I use a China-based API proxy?

Yes. Set `base_url` in both `config.json` and `image_gen_config.json`.

### What if I'm not happy with the generated images?

Use `/custom` mode. It pauses after asset generation so you can replace character/scene images with your own, then continues storyboard generation.

### What if the pipeline fails midway?

Progress is saved in `改编进度.json`. Re-running will continue from the next episode. Character and scene assets are not regenerated.

### Sample Output

<img width="1204" height="820" alt="image" src="https://github.com/user-attachments/assets/2f7e1053-8a72-42d7-abad-6e0d6120c2d9" />

---

## Tech Stack

- **Runtime** — Node.js + [tsx](https://github.com/privatenumber/tsx)
- **Agent Framework** — [@mariozechner/pi-coding-agent](https://www.npmjs.com/package/@mariozechner/pi-coding-agent)
- **Image Generation** — Google Gemini API (txt2img / img2img)
- **Schema Validation** — [@sinclair/typebox](https://github.com/sinclairzx81/typebox)

---

## License

MIT
