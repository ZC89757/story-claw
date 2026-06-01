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
    .map((name) => `  - ${name}.md`)
    .join("\n");

  return (
    `== 章节原文（含画面预设标注）==\n${presetText}\n\n` +
    `== 场景列表 ==\n${sceneNames.join("、")}\n\n` +
    `== 输出文件 ==\n` +
    `工作目录已设为剧本目录，write 工具的 path 只写文件名（不带目录），共 ${sceneNames.length} 个：\n` +
    `${sceneFilesDesc}\n\n` +
    OUTPUT_SCHEMAS["segment_script"]
  );
}
