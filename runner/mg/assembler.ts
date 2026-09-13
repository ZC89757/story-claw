import fs from "node:fs/promises";
import type {NovelSelection} from "../../ui/select.js";
import {novelPaths} from "../../utils/paths.js";
import {assertMgVideoFrames} from "./media.js";
import type {MgRenderBundle, VisualFunctionRecord} from "./types.js";

/**
 * Validate the full-episode composition produced from visual-tag clips.
 */
export async function assembleEssayMg(sel: NovelSelection): Promise<string> {
  const records = JSON.parse(await fs.readFile(novelPaths.mgFunctionCalls(sel.novelName, sel.episode), "utf-8")) as VisualFunctionRecord[];
  const bundle = JSON.parse(await fs.readFile(novelPaths.mgRenderBundle(sel.novelName, sel.episode), "utf-8")) as MgRenderBundle;
  const outputPath = novelPaths.episodeMgRawVideo(sel.novelName, sel.episode);
  const incomplete = records.filter((record) => record.status !== "completed");
  if (incomplete.length) throw new Error(`仍有 ${incomplete.length} 个视觉视频任务未完成`);
  const nodes = bundle.nodes ?? [];
  if (nodes.length !== records.length) {
    throw new Error(`合成节点数量 ${nodes.length} 与 Function Call 数量 ${records.length} 不一致`);
  }
  for (const node of nodes) await fs.access(node.videoPath);
  await assertMgVideoFrames(outputPath, bundle.durationFrames, bundle.fps);
  return outputPath;
}

export async function renderAndAssembleEssayMg(sel: NovelSelection): Promise<string> {
  const {renderEssayMgEpisode} = await import("./renderer.js");
  await renderEssayMgEpisode(sel);
  return assembleEssayMg(sel);
}
