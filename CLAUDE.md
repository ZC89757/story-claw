# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Story Claw** is an AI-powered pipeline that transforms web novel chapters into short-form drama storyboard panels. It orchestrates multiple AI agents and the Gemini image generation API through a staged pipeline: script adaptation → structured parsing → asset generation → composite frame creation → storyboard panel rendering.

## Commands

```bash
# Install dependencies
npm install

# Run the CLI
npm start

# Build (TypeScript compilation check only - no emit)
npx tsc --noEmit

# Global install for development
npm install -g .
```

There are no automated tests or lint scripts defined in package.json.

## Architecture

### Entry Points
- `bin/cli.js` → `cli.ts`: Interactive CLI with commands `/solo`, `/custom`, `/status`, `/help`, `/exit`
- `agent.ts`: Core agent infrastructure — loads config, creates sessions, runs sub-agents

### Pipeline Stages
The pipeline is defined in `runner/pipeline.ts` and orchestrated by:
- `runner/solo.ts`: Full automation (stages A→B→C→E→F)
- `runner/custom.ts`: Pauses after stage C for manual asset replacement

| Stage | File | Description |
|-------|------|-------------|
| A | `tools/scan-novel.ts` + `tools/save-script.ts` | LLM agent reads chapters (80K char sliding window) and writes a Markdown script |
| B | `tools/parse-script.ts` | LLM agent parses Markdown script into `scene_data.json` |
| C | `tools/generate-character.ts` + `tools/generate-scene.ts` | Direct Gemini API calls (no LLM agent) to generate reference images |
| E | `tools/generate-images.ts` | Composite frames (character + scene background), with AI validation and up to 4 retries |
| F | `tools/direct-storyboard.ts` + `tools/generate-images.ts` | Storyboard director designs shots, then renders final panels via Gemini |

### Configuration
Stored in `~/.story-claw/` (not in the repo):
- `config.json`: LLM provider (`openai`/`anthropic`/`google`), model, api_key, optional base_url
- `image_gen_config.json`: Gemini image generation api_key, model, base_url

Config loading lives in `agent.ts`. The setup wizard is in `utils/setup.ts`.

### Key Utilities
- `utils/paths.ts`: Centralized path management for all output files — always use this when constructing file paths
- `utils/image-gen.ts`: Unified Gemini image generation interface (txt2img and img2img)
- `utils/run-python.ts`: Exports global path constants `CONFIG_DIR` (`~/.story-claw/`) and `WORK_DIR` (`process.cwd()`)
- `tools/schemas.ts`: TypeBox JSON schemas for all tool input/output types

### Output Directory Structure
```
workspace/
└── {novelName}/
    ├── 改编进度.json          # Progress tracking (episodes, next chapter, summary, hooks)
    ├── characters/            # Shared across all episodes
    ├── scenes/                # Shared across all episodes
    └── ep{XX}/
        ├── {title}.md         # Script (Markdown)
        ├── scene_data.json    # Structured scene/beat data
        ├── panels_scene_XX_beat{YY}.json
        ├── character_frames/  # Composite frames
        └── storyboard_panels/ # Final output panels
```

### Novel Input Convention
Chapter files must follow the naming pattern `第{N}章 {title}.txt` (Chinese chapter convention) placed in the project working directory.

### Parallel Execution
Stages E and F process scenes and beats in parallel using `Promise.all`. The validation/retry loop in `tools/generate-images.ts` also runs per-frame in parallel.

### Agent Data
- `agent-data/`: Agent session state and model registry (auto-created by the pi-coding-agent framework)
- `agent-logs/`: Sub-agent execution logs per run
