```
Technology ultimately has to serve people. True productivity does not lie in how many monkeys you raise with AI, but in how you use AI to create an effective tool for yourself.
```
# Story Claw

<p>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen" alt="Node >= 18">
  <img src="https://img.shields.io/github/last-commit/ZC89757/story-claw" alt="Last commit">
</p>

English | [中文](./README_CN.md)

Point it at a folder of novel chapters. It hands back a finished short-drama episode — narrated, scored, sound-effected, rendered — with one command. If you want to turn a web novel into short-drama episodes without paying per second for video generation or babysitting character consistency by hand, this is built for exactly that.

[![Demo](assets/demo-thumb.jpg)](https://github.com/ZC89757/story-claw/raw/main/assets/demo.mp4)

*Click to play. Generated end-to-end by Story Claw, zero manual editing: script adaptation → character/scene art → shot composition → voice + BGM + sfx → video render.*

---

## The problem with AI-adapting a 200-chapter novel

Anyone who has hand-built a novel-to-video pipeline runs into the same handful of problems after enough chapters: a character breaks a leg or gets injured, but their reference image still shows them intact; every character sounds the same because voice consistency was never enforced; the same clip gets re-rolled over and over.

Story Claw's pipeline is built specifically around these problems:

- **Characters and scenes evolve in stages.** Each character gets one base reference image, plus a new "stage" image only when their *outfit or carried items* meaningfully change — school uniform → hospital gown after an injury → battle-worn after a fight. Scenes get the same treatment for lighting/time-of-day/props ("classroom, first day, bright afternoon" vs. "classroom, exam night, one flickering light"). The pipeline decides per chapter whether a new stage is actually needed, so a 200-chapter novel doesn't regenerate art every chapter, and a character's look still evolves with the plot.
- **Every video clip is graded by a vision model before it's accepted.** A custom ComfyUI node pipes each generated clip's first/last frame to a VLM right inside the render graph: does the main subject stay the same person start to finish? Did the model hallucinate an extra face? After subtitle removal, is there still a ghost of text on screen? A clip that fails gets silently regenerated inside the pipeline.
- **One voice per character, for the whole show.** The first time a character speaks, they're assigned a TTS voice from the pool and it's written to a per-novel voice map — every later chapter, every later episode, looks them up by name and reuses the same voice. The narrator gets a dedicated voice, never picked from the character pool.
- **The video model runs on your own GPU.** Rendering is a self-hosted [ComfyUI](https://github.com/comfyanonymous/ComfyUI) + LTX-2.3 image-to-video workflow — no Seedance/Kling-style per-second billing sitting between you and an episode.
- **`gpt-image-2` for the actual pixels.** Against the other models we tried, it's the one that best holds up under the kind of dense, multi-constraint prompt this pipeline throws at it — locked character identity + pose + composition + lighting, all at once.

---

## How It Works

Five stages per episode, each driven by an LLM sub-agent or direct API calls:

```
Novel Chapter (.txt)
    │
    ▼
┌────────────────────────────────────────────────────────────────┐
│ 1  Visual Preset       Tag every line: scene / character /      │
│                        shot size / angle / camera move / mood   │
│ 2  Asset Archiving     Identify characters & scenes; generate   │
│                        stage-aware reference images + voices    │
│ 3  Script Segmentation Split the chapter into per-scene scripts │
│ 4  Storyboard Direction Design shot-by-shot panels with         │
│                        image/video prompts, per scene           │
│ 5  Render              TTS → BGM → sfx → panel images → video   │
│                        clips (VLM-graded) → final episode video │
└────────────────────────────────────────────────────────────────┘
    │
    ▼
ep{N}.mp4
```

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
- **LLM API Key** — OpenAI / Anthropic / Google (pick one, drives all sub-agents)
- **Image generation API** — `gpt-image-2` (recommended) or a Gemini image model
- **TTS API Key** — for narration and dialogue synthesis
- **A ComfyUI instance** (self-hosted, local or rented GPU) running an LTX image-to-video workflow
- *(Optional)* A BGM generation endpoint and a local sound-effect library (`.mp3`/`.wav`) for background music and sfx

---

## Quick Start

### 1. First-Run Setup

```bash
story-claw
```

On first launch, an interactive setup wizard walks you through the required config files (see [Configuration](#configuration)), all stored under `~/.story-claw/`.

### 2. Prepare Novel Files

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

```
  /solo      Fully automated mode — select a novel, adapt and render the next episode
  /status    View adaptation progress for all novels
  /help      Show help
  /exit      Exit
```

### 4. Output Directory

```
workspace/
└── my-novel/
    ├── 改编进度.json          # Cross-episode progress
    ├── voice_map.json         # Character → TTS voice mapping (shared across episodes)
    ├── characters/            # Character reference images (shared across episodes)
    │   ├── Alice.json
    │   ├── Alice_原型.png          # base reference
    │   └── Alice_{stage}.png       # per-stage variant (outfit/props changed)
    ├── scenes/                # Scene backgrounds (shared across episodes)
    │   ├── classroom.json
    │   └── classroom.png
    └── ep01/                  # Episode 1
        ├── 画面预设.txt
        ├── scripts/               # Per-scene scripts
        ├── storyboards/           # Per-scene shot data (image/video prompts)
        ├── render_{sceneName}/    # Panel images, panel/scene video clips, TTS audio
        ├── render.log
        └── ep01.mp4               # Final rendered episode
```

---

## Configuration

All config files live in `~/.story-claw/` and are created by the first-run setup wizard.

| Config File | Purpose |
|-------------|---------|
| `config.json` | LLM provider/model/API key driving all sub-agents |
| `image_gen_config.json` | Image generation API (`gpt-image-2` recommended) |
| `video_config.json` | ComfyUI endpoint, LTX workflow path, video duration/concurrency |
| `tts_config.json` | TTS provider, voice pool, dedicated narrator voice, concurrency |
| `sfx/` (optional) | Local sound-effect library — drop `.mp3`/`.wav` files here, tagged by filename |

<details>
<summary>Example: <code>config.json</code></summary>

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
<summary>Example: <code>image_gen_config.json</code></summary>

```json
{
  "api_key": "sk-...",
  "model": "openai/gpt-image-2",
  "base_url": "https://your-api-endpoint.com/api/vertex-ai"
}
```
</details>

---

## FAQ

### What novel formats are supported?

Currently `.txt` files with the naming pattern `第{N}章 {title}.txt`.

### Do I need to pay for a video generation API?

No. The video stage talks to your own ComfyUI instance running an LTX image-to-video workflow — you provide the GPU, not a per-second-billed commercial API.

### How does it decide when a character needs a new reference image?

Only when their outfit or carried items change in a way that's visually meaningful — going from "just enrolled" to "in a wheelchair after an accident" gets a new stage image; changing emotion, location, or lighting does not. This keeps art generation cheap across a long novel while still tracking real visual changes.

### What happens when the video model messes up a clip?

A VLM-based gate checks the clip's first/last frame for subject consistency and fabricated faces (and, separately, leftover subtitle text after removal). Failures trigger an automatic re-render up to a configurable retry limit; once the limit is hit, the clip is accepted as-is rather than stalling the whole episode.

### What if the pipeline fails midway?

Progress is tracked per episode and per stage in `改编进度.json`. Re-running the same episode skips stages that already completed, and only regenerates what's missing.

---

## Tech Stack

- **Runtime** — Node.js + [tsx](https://github.com/privatenumber/tsx)
- **Agent Framework** — [@mariozechner/pi-coding-agent](https://www.npmjs.com/package/@mariozechner/pi-coding-agent)
- **Image Generation** — `gpt-image-2` (primary), Gemini image models (fallback)
- **Video Generation** — self-hosted [ComfyUI](https://github.com/comfyanonymous/ComfyUI) + LTX-2.3 image-to-video, with custom nodes for VLM-based quality gating
- **Voice Synthesis** — TTS with word-level timestamps (drives sound-effect placement) and persistent per-character voice assignment
- **Schema Validation** — [@sinclair/typebox](https://github.com/sinclairzx81/typebox)

---

## License

MIT
