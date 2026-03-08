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
 *         {小说名}_第1集.md        剧本
 *         scene_data.json          场景结构化数据（parse_script 输出）
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

  /** 短剧剧本：workspace/{名}/ep{XX}/{名}_第X集.md */
  script: (novelName: string, episodeNum: number) =>
    path.join(
      PATHS.workspace,
      novelName,
      `ep${String(episodeNum).padStart(2, "0")}`,
      `${novelName}_第${episodeNum}集.md`,
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

  /** 角色图完整路径 */
  characterImage: (novelName: string, charName: string) =>
    path.join(PATHS.workspace, novelName, "characters", `${charName}.png`),

  /** 场景底图完整路径 */
  sceneImage: (novelName: string, locationName: string) =>
    path.join(PATHS.workspace, novelName, "scenes", `${locationName}.png`),

  /** 合成帧图目录：workspace/{名}/ep{XX}/character_frames/ */
  characterFramesDir: (novelName: string, episodeNum: number) =>
    path.join(PATHS.workspace, novelName, `ep${String(episodeNum).padStart(2, "0")}`, "character_frames"),

  /** 分镜图片目录：workspace/{名}/ep{XX}/storyboard_panels/ */
  storyboardPanelsDir: (novelName: string, episodeNum: number) =>
    path.join(PATHS.workspace, novelName, `ep${String(episodeNum).padStart(2, "0")}`, "storyboard_panels"),
};
