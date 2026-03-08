/**
 * 流水线执行逻辑
 *
 * 提供各阶段的独立执行函数，供 solo/custom 模式调用。
 * A/B/E 阶段通过 sub-agent 执行（需要 LLM 推理），
 * C/F 阶段直接调用 tool.execute()。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { runSubAgent } from "../agent.js";
import { novelPaths } from "../utils/paths.js";
import type { NovelSelection } from "../ui/select.js";

// 导入 sub-agent 需要的工具
import { scanNovelTool } from "../tools/scan-novel.js";
import { saveScriptTool } from "../tools/save-script.js";
import { parseScriptTool } from "../tools/parse-script.js";
import { generateCharacterTool } from "../tools/generate-character.js";
import { generateSceneTool } from "../tools/generate-scene.js";
import { directStoryboardTool } from "../tools/direct-storyboard.js";
import { generateCompositeFrames, generatePanelImages } from "../tools/generate-images.js";

// ── Sub-agent 系统提示 ────────────────────────────────────────

const WRITE_SCRIPT_SYSTEM = `你是短剧编剧专员。你的唯一任务是将小说改编成短剧剧本：

1. 调用 scan_novel 工具，扫描小说章节和改编进度
2. 根据返回的章节内容和改编原则，生成一集完整的短剧剧本
3. 调用 save_script 工具保存剧本
4. 在最终回复的**最后一行**写明（格式固定，方便解析）：
   剧本文件路径: <save_script 返回的绝对路径>

完成后直接结束，不要询问用户任何问题。`;

const PARSE_SCRIPT_SYSTEM = `你是剧本解析专员。你的唯一任务是将短剧剧本解析为结构化 JSON：

1. 调用 parse_script 工具，读取剧本内容（工具会告诉你 scene_data.json 的保存路径）
2. 根据工具返回的格式规范，将剧本解析为完整的结构化 JSON
3. 用内置 write 工具将 JSON 保存到 parse_script 指定的路径（scene_data.json）
4. 在最终回复的**最后一行**写明（格式固定，方便解析）：
   scene_data.json 路径: <保存的绝对路径>

严格约束：
- locations 只能是物理空间名（房间、建筑、户外区域），禁止包含景别、道具或动作描述
- 若某空间是已有 location 的子区域，直接使用父空间名，不得新建 location
- 每个 beat 只在有角色入/出画时才创建

完成后直接结束，不要询问用户任何问题。`;

const STORYBOARD_SYSTEM = `你是分镜导演。任务：为单个 beat 设计分镜，输出可直接用于生图的完整 prompt。

核心理念：该 beat 已经有一张合成好的人物帧图片（场景 + 角色），分镜的本质是在这张真实画面中移动摄像机。

步骤（严格按顺序执行）：
1. 用内置 read 工具读取 task 中的剧本文件，找到对应场景段落，记忆该场景的台词和视觉细节
2. 用内置 read 工具查看 task 中提供的合成帧图片，理解场景的整体环境布局，观察每个角色的位置和姿态，并推理不同机位下各角色身后的背景
3. 调用 direct_storyboard 工具，参数 scene_json、scene_id、beat_num 按 task 中提供的值传入
4. 综合剧本 + 合成帧实际画面 + direct_storyboard 返回的 beat 数据，为该 beat 生成 panels JSON：
   - 每个 panel 直接写完整的生图 prompt（不要写画幅比例和摄影风格，代码会自动追加）
   - 分镜数量只能是 1、4、6 三种之一
5. 用内置 write 工具将 panels JSON 保存到 task 指定的路径
6. 完成后在最终回复末行写明：panels JSON 路径: <保存的绝对路径>

完成后直接结束，不要询问用户任何问题。`;

// ── Stage A：剧本创作 ─────────────────────────────────────────

export async function stageA(sel: NovelSelection): Promise<string> {
  const expectedPath = novelPaths.script(sel.novelName, sel.episode);

  await runSubAgent(
    [scanNovelTool, saveScriptTool],
    WRITE_SCRIPT_SYSTEM,
    `请为小说「${sel.novelName}」生成下一集短剧剧本。`,
    "[Sub-A 编剧]",
  );

  // 路径由 novelPaths 确定性计算，不依赖 LLM 输出
  try {
    await fs.access(expectedPath);
  } catch {
    throw new Error(`Sub-A 完成但剧本文件不存在: ${expectedPath}`);
  }
  return expectedPath;
}

// ── Stage B：剧本解析 ─────────────────────────────────────────

export async function stageB(sel: NovelSelection, scriptFile: string): Promise<string> {
  const expectedPath = novelPaths.sceneData(sel.novelName, sel.episode);

  await runSubAgent(
    [parseScriptTool],
    PARSE_SCRIPT_SYSTEM,
    `请解析剧本文件：${scriptFile}`,
    "[Sub-B 解析]",
  );

  try {
    await fs.access(expectedPath);
  } catch {
    throw new Error(`Sub-B 完成但 scene_data.json 不存在: ${expectedPath}`);
  }
  return expectedPath;
}

// ── Stage C：资源生成 ─────────────────────────────────────────

export interface StageCResult {
  newChars: number;
  newScenes: number;
  skipped: number;
}

export async function stageC(
  sel: NovelSelection,
  sceneDataFile: string,
  onProgress?: (msg: string) => void,
): Promise<StageCResult> {
  const sceneData = JSON.parse(await fs.readFile(sceneDataFile, "utf-8"));
  const locations: string[] = sceneData.locations ?? [];
  const characters: any[] = sceneData.characters ?? [];

  const progressPath = novelPaths.progress(sel.novelName);

  let progress: any = { established_characters: [], established_locations: [] };
  try {
    progress = JSON.parse(await fs.readFile(progressPath, "utf-8"));
    progress.established_characters ??= [];
    progress.established_locations ??= [];
  } catch { /* 进度文件不存在 */ }

  const newLocations = locations.filter((l) => !progress.established_locations.includes(l));
  const newChars = characters.filter((c: any) => !progress.established_characters.includes(c.name ?? c));
  const skipped = (locations.length - newLocations.length) + (characters.length - newChars.length);

  let charsDone = 0;
  let scenesDone = 0;

  // 生成角色
  for (const c of newChars) {
    const name = c.name ?? c;
    onProgress?.(`角色 ${++charsDone}/${newChars.length}: ${name}`);

    await generateCharacterTool.execute("", {
      novel_name: sel.novelName,
      name,
      age_desc: c.age_desc ?? "",
      clothing: c.clothing ?? "",
    });

    try {
      await fs.access(novelPaths.characterImage(sel.novelName, name));
      if (!progress.established_characters.includes(name)) {
        progress.established_characters.push(name);
      }
      await fs.writeFile(progressPath, JSON.stringify(progress, null, 4), "utf-8");
    } catch { /* 生成失败 */ }
  }

  // 生成场景
  for (const loc of newLocations) {
    onProgress?.(`场景 ${++scenesDone}/${newLocations.length}: ${loc}`);

    await generateSceneTool.execute("", {
      novel_name: sel.novelName,
      location_name: loc,
      scene_json: sceneDataFile,
    });

    try {
      await fs.access(novelPaths.sceneImage(sel.novelName, loc));
      if (!progress.established_locations.includes(loc)) {
        progress.established_locations.push(loc);
      }
      await fs.writeFile(progressPath, JSON.stringify(progress, null, 4), "utf-8");
    } catch { /* 生成失败 */ }
  }

  return { newChars: newChars.length, newScenes: newLocations.length, skipped };
}

// ── Stage E+F 进度 ───────────────────────────────────────────────────────

export interface StageEFProgress {
  storyboard: { done: number; total: number };
  panels: { done: number; total: number };
}

// ── Stage E+F：合成帧 → 分镜导演(per-beat) → 分镜图（按 scene 并行）───

export async function stageEF(
  sel: NovelSelection,
  sceneDataFile: string,
  scriptFile: string,
  onProgress?: (p: StageEFProgress) => void,
): Promise<void> {
  const sceneData = JSON.parse(await fs.readFile(sceneDataFile, "utf-8"));
  const scenes: any[] = sceneData.scenes ?? [];
  const episodeDir = novelPaths.episodeDir(sel.novelName, sel.episode);

  // 统计总 beat 数
  const totalBeats = scenes.reduce((sum: number, s: any) => sum + (s.beats?.length ?? 0), 0);
  const progress: StageEFProgress = {
    storyboard: { done: 0, total: totalBeats },
    panels: { done: 0, total: totalBeats },
  };
  onProgress?.(progress);

  await Promise.all(
    scenes.map(async (scene: any) => {
      const sceneId: string = scene.id;
      const beats: any[] = scene.beats ?? [];

      // Step 1：生成合成帧 + Step 2：分镜导演（合成帧是分镜导演的前置步骤）
      const compositeResult = await generateCompositeFrames(
        sceneData, sceneId, sel.novelName, sel.episode, runSubAgent,
      );

      const beatPanelsMap = new Map<number, any[]>();

      await Promise.all(
        beats.map(async (beat: any) => {
          const beatNum: number = beat.num;
          const beatPanelsPath = path.join(episodeDir, `panels_${sceneId}_beat${String(beatNum).padStart(2, "0")}.json`);

          // 找到该 beat 对应的合成帧路径
          const frameKey = `${sceneId}_${String(beatNum).padStart(2, "0")}`;
          const framePath = compositeResult.framePaths.get(frameKey);

          const frameInfo = framePath
            ? `合成帧图片路径（请用 read 工具查看）：${framePath}`
            : `该 beat 无合成帧（可能是 effects 或无角色场景）`;

          await runSubAgent(
            [directStoryboardTool],
            STORYBOARD_SYSTEM,
            [
              `剧本文件路径：${scriptFile}`,
              `scene_data.json 路径：${sceneDataFile}`,
              `scene_id：${sceneId}`,
              `beat_num：${beatNum}`,
              `panels JSON 保存路径：${beatPanelsPath}`,
              frameInfo,
            ].join("\n"),
            `[Sub-E:${sceneId}:b${beatNum}]`,
          );

          // 读取该 beat 的 panels JSON
          try {
            const panelsJson = JSON.parse(await fs.readFile(beatPanelsPath, "utf-8"));
            beatPanelsMap.set(beatNum, panelsJson.panels ?? []);
          } catch {
            console.log(`[${sceneId}] beat ${beatNum} panels 文件读取失败，跳过`);
          }

          progress.storyboard.done++;
          onProgress?.(progress);
        }),
      );

      // Step 3：分镜图生成（逐 beat 完成后递增 panels 进度）
      await generatePanelImages(
        sceneData, sceneId, sel.novelName, sel.episode, beatPanelsMap, runSubAgent,
      );

      // 该 scene 的所有 beat 分镜图已生成
      progress.panels.done += beats.length;
      onProgress?.(progress);
    }),
  );
}

// ── 获取资源文件列表（供 custom 模式展示）─────────────────────────

export async function listResources(novelName: string): Promise<{
  characters: string[];
  scenes: string[];
}> {
  const charDir = novelPaths.charactersDir(novelName);
  const sceneDir = novelPaths.scenesDir(novelName);

  let characters: string[] = [];
  let scenes: string[] = [];

  try {
    characters = (await fs.readdir(charDir))
      .filter((f) => f.endsWith(".png"))
      .map((f) => f.replace(/\.png$/, ""));
  } catch { /* 目录不存在 */ }

  try {
    scenes = (await fs.readdir(sceneDir))
      .filter((f) => f.endsWith(".png"))
      .map((f) => f.replace(/\.png$/, ""));
  } catch { /* 目录不存在 */ }

  return { characters, scenes };
}
