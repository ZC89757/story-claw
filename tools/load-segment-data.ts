/**
 * 分场数据加载
 *
 * 读取画面预设文件（已含原文+画面标注），拼接 segment agent 的 task prompt。
 */

import fs from "node:fs/promises";
import { novelPaths } from "../utils/paths.js";
import { OUTPUT_SCHEMAS } from "./schemas.js";

export async function loadSegmentData(
  novelName: string,
  episodeNum: number,
  sceneNames: string[],
  visualPresetPath: string,
): Promise<string> {
  const presetText = await fs.readFile(visualPresetPath, "utf-8");

  const sceneFilesDesc = sceneNames
    .map((name) => `  - ${novelPaths.sceneScript(novelName, episodeNum, name)}`)
    .join("\n");

  return (
    `== 章节原文（含画面预设标注）==\n${presetText}\n\n` +
    `== 场景列表 ==\n${sceneNames.join("、")}\n\n` +
    `== 输出路径 ==\n` +
    `每个场景保存为一个文件，共 ${sceneNames.length} 个：\n` +
    `${sceneFilesDesc}\n\n` +
    OUTPUT_SCHEMAS["segment_script"]
  );
}
