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
 *         scripts/                 分场剧本（每场景一个文件）
 *           {场景名}.md
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

  /** 角色图目录：workspace/{名}/characters/ */
  charactersDir: (novelName: string) =>
    path.join(PATHS.workspace, novelName, "characters"),

  /** 场景底图目录：workspace/{名}/scenes/ */
  scenesDir: (novelName: string) =>
    path.join(PATHS.workspace, novelName, "scenes"),

  /** 议论文封面参考资源目录：workspace/{名}/resource/ */
  resourceDir: (novelName: string) =>
    path.join(PATHS.workspace, novelName, "resource"),

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

  /** 每集封面目录：workspace/{名}/ep{XX}/covers/ */
  coversDir: (novelName: string, episodeNum: number) =>
    path.join(PATHS.workspace, novelName, `ep${String(episodeNum).padStart(2, "0")}`, "covers"),

  /** 横版封面：workspace/{名}/ep{XX}/covers/cover_landscape.png */
  coverLandscape: (novelName: string, episodeNum: number) =>
    path.join(PATHS.workspace, novelName, `ep${String(episodeNum).padStart(2, "0")}`, "covers", "cover_landscape.png"),

  /** 竖版封面：workspace/{名}/ep{XX}/covers/cover_portrait.png */
  coverPortrait: (novelName: string, episodeNum: number) =>
    path.join(PATHS.workspace, novelName, `ep${String(episodeNum).padStart(2, "0")}`, "covers", "cover_portrait.png"),

  /** 封面策划记录：workspace/{名}/ep{XX}/covers/cover_plan.json */
  coverPlan: (novelName: string, episodeNum: number) =>
    path.join(PATHS.workspace, novelName, `ep${String(episodeNum).padStart(2, "0")}`, "covers", "cover_plan.json"),

  /** 集最终视频：workspace/{名}/ep{XX}/ep{XX}.mp4 */
  episodeVideo: (novelName: string, episodeNum: number) =>
    path.join(PATHS.workspace, novelName, `ep${String(episodeNum).padStart(2, "0")}`, `ep${String(episodeNum).padStart(2, "0")}.mp4`),

  /** 视频后处理临时输出：workspace/{名}/ep{XX}/.postprocess.mp4 */
  postprocessTempVideo: (novelName: string, episodeNum: number) =>
    path.join(PATHS.workspace, novelName, `ep${String(episodeNum).padStart(2, "0")}`, ".postprocess.mp4"),

  /** 视频后处理完成标记：workspace/{名}/ep{XX}/.postprocess_done.json */
  postprocessMarker: (novelName: string, episodeNum: number) =>
    path.join(PATHS.workspace, novelName, `ep${String(episodeNum).padStart(2, "0")}`, ".postprocess_done.json"),

  /** 渲染输出目录：workspace/{名}/ep{XX}/render_{场景名}/ */
  renderDir: (novelName: string, episodeNum: number, sceneName: string) =>
    path.join(PATHS.workspace, novelName, `ep${String(episodeNum).padStart(2, "0")}`, `render_${sceneName}`),

  /** 字幕重建测试目录：workspace/{名}/ep{XX}/subtitle_rebuild/ */
  subtitleRebuildDir: (novelName: string, episodeNum: number) =>
    path.join(PATHS.workspace, novelName, `ep${String(episodeNum).padStart(2, "0")}`, "subtitle_rebuild"),

  /** 字幕重建测试成片（无 BGM） */
  subtitleRebuildVideo: (novelName: string, episodeNum: number) =>
    path.join(
      PATHS.workspace,
      novelName,
      `ep${String(episodeNum).padStart(2, "0")}`,
      `ep${String(episodeNum).padStart(2, "0")}_subtitle_fixed_no_bgm.mp4`,
    ),

  /** voice_map：workspace/{名}/voice_map.json（跨集共享） */
  voiceMap: (novelName: string) =>
    path.join(PATHS.workspace, novelName, "voice_map.json"),
};
