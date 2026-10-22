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
import { WORK_DIR } from "./runtime-paths.js";

// ── 固定路径（绝对路径） ────────────────────────────────────────────
export const PATHS = {
  /** Agent 对话历史、认证、模型注册表 */
  agentData: path.join(WORK_DIR, "agent-data"),

  /** 小说改编中间文件根目录 */
  workspace: path.join(WORK_DIR, "workspace"),

  /** search_web 保存的最终网页；模板按 URL 读取同一份快照 */
  webSnapshots: path.join(WORK_DIR, "workspace", ".web-snapshots"),
  h3Warmups: path.join(WORK_DIR, "work", "h3-warmups"),
};

export const h3ClipPaths = (output: string) => ({
  directory: `${output}.h3`,
  completion: `${output}.h3/completed.json`,
  part: (index: number) => path.join(`${output}.h3`, `part-${index}.mp4`),
  native: (index: number) => path.join(`${output}.h3`, `native-${index}.mp4`),
  request: (index: number) => path.join(`${output}.h3`, `request-${index}.json`),
  lastFrame: (index: number) => path.join(`${output}.h3`, `last-${index}.png`),
  concat: `${output}.h3/concat.txt`,
  pending: `${output}.h3/pending.mp4`,
});

/**
 * Disposable MG media is kept outside the durable C: workspace when the
 * scheduled AI HOT runner sets STORY_CLAW_MG_SCRATCH_DIR.  Leaving the
 * override unset preserves the normal Story Claw layout for interactive
 * runs and existing projects.
 */
const mgScratchEpisodeDir = (novelName: string, episodeNum: number): string => {
  const configured = process.env.STORY_CLAW_MG_SCRATCH_DIR?.trim();
  const episode = `ep${String(episodeNum).padStart(2, "0")}`;
  return configured
    ? path.join(path.resolve(configured), novelName, episode)
    : path.join(PATHS.workspace, novelName, episode, "mg");
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

  /** 议论文第一阶段 MG 标注 HTML */
  mgAnnotation: (novelName: string, episodeNum: number) =>
    path.join(PATHS.workspace, novelName, `ep${String(episodeNum).padStart(2, "0")}`, "mg_annotation.html"),

  /** 议论文全文字级时间轴：workspace/{名}/ep{XX}/article_timeline.json */
  articleTimeline: (novelName: string, episodeNum: number) =>
    path.join(PATHS.workspace, novelName, `ep${String(episodeNum).padStart(2, "0")}`, "article_timeline.json"),

  /** 议论文全文 TTS 中间目录：workspace/{名}/ep{XX}/essay_audio/ */
  essayAudioDir: (novelName: string, episodeNum: number) =>
    path.join(PATHS.workspace, novelName, `ep${String(episodeNum).padStart(2, "0")}`, "essay_audio"),

  /** 整集全局字幕事件：workspace/{名}/ep{XX}/global_subtitles.json */
  globalSubtitlesJson: (novelName: string, episodeNum: number) =>
    path.join(PATHS.workspace, novelName, `ep${String(episodeNum).padStart(2, "0")}`, "global_subtitles.json"),

  /** 整集全局字幕 ASS：workspace/{名}/ep{XX}/global_subtitles.ass */
  globalSubtitlesAss: (novelName: string, episodeNum: number) =>
    path.join(PATHS.workspace, novelName, `ep${String(episodeNum).padStart(2, "0")}`, "global_subtitles.ass"),

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

  /** 集原画视频：无音轨、无字幕、无倍速 */
  episodeRawVideo: (novelName: string, episodeNum: number) =>
    path.join(PATHS.workspace, novelName, `ep${String(episodeNum).padStart(2, "0")}`, `ep${String(episodeNum).padStart(2, "0")}_raw.mp4`),

  /** 与原画母版时长精确对齐的旁白音轨 */
  episodeAlignedAudio: (novelName: string, episodeNum: number) =>
    path.join(PATHS.workspace, novelName, `ep${String(episodeNum).padStart(2, "0")}`, `ep${String(episodeNum).padStart(2, "0")}_aligned_audio.wav`),

  /** 本集 MG 中间产物目录 */
  mgDir: (novelName: string, episodeNum: number) =>
    path.join(PATHS.workspace, novelName, `ep${String(episodeNum).padStart(2, "0")}`, "mg"),

  /** 第二阶段 AI 的最终 Function Calls */
  mgFunctionCalls: (novelName: string, episodeNum: number) =>
    path.join(PATHS.workspace, novelName, `ep${String(episodeNum).padStart(2, "0")}`, "mg", "function_calls.json"),

  /** Remotion 渲染所需的完整场景数据 */
  mgRenderBundle: (novelName: string, episodeNum: number) =>
    path.join(PATHS.workspace, novelName, `ep${String(episodeNum).padStart(2, "0")}`, "mg", "render_bundle.json"),

  /** Disposable MG media root; durable Function Calls and render bundle stay on C:. */
  mgScratchDir: (novelName: string, episodeNum: number) =>
    mgScratchEpisodeDir(novelName, episodeNum),

  mgClipsDir: (novelName: string, episodeNum: number) =>
    path.join(mgScratchEpisodeDir(novelName, episodeNum), "clips"),

  mgPropsDir: (novelName: string, episodeNum: number) =>
    path.join(mgScratchEpisodeDir(novelName, episodeNum), "render-props"),

  mgNormalizedDir: (novelName: string, episodeNum: number) =>
    path.join(mgScratchEpisodeDir(novelName, episodeNum), "normalized"),

  /** 已插入 MG、仍无音轨/字幕/倍速的原片 */
  episodeMgRawVideo: (novelName: string, episodeNum: number) =>
    path.join(
      mgScratchEpisodeDir(novelName, episodeNum),
      `ep${String(episodeNum).padStart(2, "0")}_mg_raw.mp4`,
    ),

  /** 视频后处理临时输出：workspace/{名}/ep{XX}/.postprocess.mp4 */
  postprocessTempVideo: (novelName: string, episodeNum: number) =>
    path.join(PATHS.workspace, novelName, `ep${String(episodeNum).padStart(2, "0")}`, ".postprocess.mp4"),

  /** 视频后处理完成标记：workspace/{名}/ep{XX}/.postprocess_done.json */
  postprocessMarker: (novelName: string, episodeNum: number) =>
    path.join(PATHS.workspace, novelName, `ep${String(episodeNum).padStart(2, "0")}`, ".postprocess_done.json"),

  /** 渲染输出目录：workspace/{名}/ep{XX}/render_{场景名}/ */
  renderDir: (novelName: string, episodeNum: number, sceneName: string) =>
    path.join(PATHS.workspace, novelName, `ep${String(episodeNum).padStart(2, "0")}`, `render_${sceneName}`),

  /** H3 preparation is separate from static storyboard PNGs. */
  h3SceneDir: (novelName: string, episodeNum: number, sceneName: string): string =>
    path.join(novelPaths.renderDir(novelName, episodeNum, sceneName), "h3"),
  h3ScenePlan: (novelName: string, episodeNum: number, sceneName: string): string =>
    path.join(novelPaths.h3SceneDir(novelName, episodeNum, sceneName), "scene_plan.json"),
  h3PanelDir: (novelName: string, episodeNum: number, sceneName: string, group: number, panel: number): string =>
    path.join(novelPaths.h3SceneDir(novelName, episodeNum, sceneName), `g${String(group).padStart(2, "0")}_p${String(panel).padStart(2, "0")}`),
  h3PanelPlan: (novelName: string, episodeNum: number, sceneName: string, group: number, panel: number): string =>
    path.join(novelPaths.h3PanelDir(novelName, episodeNum, sceneName, group, panel), "references.json"),
  h3PanelPrompt: (novelName: string, episodeNum: number, sceneName: string, group: number, panel: number): string =>
    path.join(novelPaths.h3PanelDir(novelName, episodeNum, sceneName, group, panel), "prompt_en.txt"),
  h3PanelNativeVideo: (novelName: string, episodeNum: number, sceneName: string, group: number, panel: number): string =>
    path.join(novelPaths.h3PanelDir(novelName, episodeNum, sceneName, group, panel), "native.mp4"),
  h3PanelRequest: (novelName: string, episodeNum: number, sceneName: string, group: number, panel: number): string =>
    path.join(novelPaths.h3PanelDir(novelName, episodeNum, sceneName, group, panel), "request.json"),
  h3PanelCompletion: (novelName: string, episodeNum: number, sceneName: string, group: number, panel: number): string =>
    path.join(novelPaths.h3PanelDir(novelName, episodeNum, sceneName, group, panel), "completed.json"),
  h3ReferenceFile: (outputDir: string, id: string) => path.join(outputDir, `${id}.png`),
  h3AgentSession: (outputDir: string, id: string) => path.join(outputDir, `agent_${id}.jsonl`),
  storyMasterManifest: (rawVideoPath: string) => `${rawVideoPath}.h3.json`,
  storyRenderBackend: (novelName: string, episodeNum: number, sceneName: string): string =>
    path.join(novelPaths.renderDir(novelName, episodeNum, sceneName), "story_video_backend.json"),
  panelVideoPreview: (novelName: string, episodeNum: number, sceneName: string, group: number, panel: number) =>
    path.join(novelPaths.renderDir(novelName, episodeNum, sceneName), `g${String(group).padStart(2, "0")}_p${String(panel).padStart(2, "0")}_preview.png`),

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

  /** 字幕重建测试的全局字幕事件 */
  subtitleRebuildGlobalSubtitlesJson: (novelName: string, episodeNum: number) =>
    path.join(
      PATHS.workspace,
      novelName,
      `ep${String(episodeNum).padStart(2, "0")}`,
      "subtitle_rebuild",
      "global_subtitles.json",
    ),

  /** 字幕重建测试的全局字幕 ASS */
  subtitleRebuildGlobalSubtitlesAss: (novelName: string, episodeNum: number) =>
    path.join(
      PATHS.workspace,
      novelName,
      `ep${String(episodeNum).padStart(2, "0")}`,
      "subtitle_rebuild",
      "global_subtitles.ass",
    ),

  /** voice_map：workspace/{名}/voice_map.json（跨集共享） */
  voiceMap: (novelName: string) =>
    path.join(PATHS.workspace, novelName, "voice_map.json"),
};
