/**
 * paths.ts — 所有产物的存储路径
 *
 * 这是项目中唯一定义路径的地方。
 * 所有工具直接引用这里的常量，不在各自文件里硬编码。
 *
 * 目录结构（相对于项目根目录）：
 *
 *   agent-data/                    Agent 运行数据（对话历史、模型注册表）
 *   workspace/                     小说改编中间文件
 *     {小说名}/
 *       改编进度.json              跨集进度（含 source_path 指向小说原始目录）
 *       characters/                角色图      {角色名}.png（跨集共享）
 *       scenes/                    场景底图    {场景名}.png（跨集共享）
 *       ep01/                      第1集
 *         scene_data.json          场景结构化数据
 *         scripts/                 分场剧本（每场景一个文件）
 *           {场景名}.md
 *         panels_scene_XX.json     分镜构图（direct_storyboard 输出）
 *         character_frames/        合成帧图    frame_XX.png（按集隔离）
 *         storyboard_panels/       分镜图片    panel_*.png（按集隔离）
 *       ep02/
 *         ...
 */

import path from "node:path";
import { WORK_DIR } from "./run-python.js";

// ── 固定路径（绝对路径） ────────────────────────────────────────────
export const PATHS = {
  /** Agent 对话历史、认证、模型注册表 */
  agentData: path.join(WORK_DIR, "agent-data"),

  /** 小说改编中间文件根目录 */
  workspace: path.join(WORK_DIR, "workspace"),
};

// ── workspace 内的动态路径（函数形式） ─────────────────────────────
export const novelPaths = {
  /** 小说 workspace 根目录：workspace/{名}/ */
  workspaceDir: (novelName: string) =>
    path.join(PATHS.workspace, novelName),

  /** 集目录：workspace/{名}/ep{XX}/ */
  episodeDir: (novelName: string, episodeNum: number) =>
    path.join(PATHS.workspace, novelName, `ep${String(episodeNum).padStart(2, "0")}`),

  /** 改编进度：workspace/{名}/改编进度.json */
  progress: (novelName: string) =>
    path.join(PATHS.workspace, novelName, "改编进度.json"),

  /** 分场剧本目录：workspace/{名}/ep{XX}/scripts/ */
  scriptsDir: (novelName: string, episodeNum: number) =>
    path.join(
      PATHS.workspace,
      novelName,
      `ep${String(episodeNum).padStart(2, "0")}`,
      "scripts",
    ),

  /** 单场景剧本文件：workspace/{名}/ep{XX}/scripts/{场景名}.md */
  sceneScript: (novelName: string, episodeNum: number, sceneName: string) =>
    path.join(
      PATHS.workspace,
      novelName,
      `ep${String(episodeNum).padStart(2, "0")}`,
      "scripts",
      `${sceneName}.md`,
    ),

  /** 场景结构化数据：workspace/{名}/ep{XX}/scene_data.json */
  sceneData: (novelName: string, episodeNum: number) =>
    path.join(
      PATHS.workspace,
      novelName,
      `ep${String(episodeNum).padStart(2, "0")}`,
      "scene_data.json",
    ),

  /** 角色图目录：workspace/{名}/characters/ */
  charactersDir: (novelName: string) =>
    path.join(PATHS.workspace, novelName, "characters"),

  /** 场景底图目录：workspace/{名}/scenes/ */
  scenesDir: (novelName: string) =>
    path.join(PATHS.workspace, novelName, "scenes"),

  /** 角色 JSON 路径：workspace/{名}/characters/{角色名}.json */
  characterJson: (novelName: string, charName: string) =>
    path.join(PATHS.workspace, novelName, "characters", `${charName}.json`),

  /** 角色原型图路径：workspace/{名}/characters/{角色名}_原型.png */
  characterProtoImage: (novelName: string, charName: string) =>
    path.join(PATHS.workspace, novelName, "characters", `${charName}_原型.png`),

  /** 角色造型图路径：workspace/{名}/characters/{角色名}_{阶段}.png */
  characterStageImage: (novelName: string, charName: string, stage: string) =>
    path.join(PATHS.workspace, novelName, "characters", `${charName}_${stage}.png`),

  /** 角色图完整路径（兼容旧接口，等同于原型图） */
  characterImage: (novelName: string, charName: string) =>
    path.join(PATHS.workspace, novelName, "characters", `${charName}_原型.png`),

  /** 场景 JSON 路径：workspace/{名}/scenes/{场景名}.json */
  sceneJson: (novelName: string, locationName: string) =>
    path.join(PATHS.workspace, novelName, "scenes", `${locationName}.json`),

  /** 场景底图完整路径 */
  sceneImage: (novelName: string, locationName: string) =>
    path.join(PATHS.workspace, novelName, "scenes", `${locationName}.png`),

  /** 合成帧图目录：workspace/{名}/ep{XX}/character_frames/ */
  characterFramesDir: (novelName: string, episodeNum: number) =>
    path.join(PATHS.workspace, novelName, `ep${String(episodeNum).padStart(2, "0")}`, "character_frames"),

  /** 分镜图片目录：workspace/{名}/ep{XX}/storyboard_panels/ */
  storyboardPanelsDir: (novelName: string, episodeNum: number) =>
    path.join(PATHS.workspace, novelName, `ep${String(episodeNum).padStart(2, "0")}`, "storyboard_panels"),

  /** 画面预设文件：workspace/{名}/ep{XX}/画面预设.txt */
  visualPreset: (novelName: string, episodeNum: number) =>
    path.join(PATHS.workspace, novelName, `ep${String(episodeNum).padStart(2, "0")}`, "画面预设.txt"),

  /** 清理后的原文：workspace/{名}/ep{XX}/原文_clean.txt */
  cleanedText: (novelName: string, episodeNum: number) =>
    path.join(PATHS.workspace, novelName, `ep${String(episodeNum).padStart(2, "0")}`, "原文_clean.txt"),

  /** 分镜 JSONL 目录：workspace/{名}/ep{XX}/storyboards/ */
  storyboardsDir: (novelName: string, episodeNum: number) =>
    path.join(PATHS.workspace, novelName, `ep${String(episodeNum).padStart(2, "0")}`, "storyboards"),

  /** 分镜 JSONL：workspace/{名}/ep{XX}/storyboards/storyboard_{场景名}.jsonl */
  storyboardJsonl: (novelName: string, episodeNum: number, sceneName: string) =>
    path.join(PATHS.workspace, novelName, `ep${String(episodeNum).padStart(2, "0")}`, "storyboards", `storyboard_${sceneName}.jsonl`),

  /** 集最终视频：workspace/{名}/ep{XX}/ep{XX}.mp4 */
  episodeVideo: (novelName: string, episodeNum: number) =>
    path.join(PATHS.workspace, novelName, `ep${String(episodeNum).padStart(2, "0")}`, `ep${String(episodeNum).padStart(2, "0")}.mp4`),

  /** 渲染输出目录：workspace/{名}/ep{XX}/render_{场景名}/ */
  renderDir: (novelName: string, episodeNum: number, sceneName: string) =>
    path.join(PATHS.workspace, novelName, `ep${String(episodeNum).padStart(2, "0")}`, `render_${sceneName}`),

  /** 场景最终视频（含TTS）：workspace/{名}/ep{XX}/render_{场景名}/final.mp4 */
  sceneFinalVideo: (novelName: string, episodeNum: number, sceneName: string) =>
    path.join(PATHS.workspace, novelName, `ep${String(episodeNum).padStart(2, "0")}`, `render_${sceneName}`, "final.mp4"),

  /** voice_map：workspace/{名}/voice_map.json（跨集共享） */
  voiceMap: (novelName: string) =>
    path.join(PATHS.workspace, novelName, "voice_map.json"),
};
