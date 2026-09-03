import fs from "node:fs/promises";
import type {NovelSelection} from "../../ui/select.js";
import {novelPaths} from "../../utils/paths.js";
import {assertMgVideoFrames} from "./media.js";
import type {MgPlan} from "./types.js";

/**
 * Validate the full-episode composition produced from visual-tag clips.
 */
export async function assembleEssayMg(sel: NovelSelection): Promise<string> {
  const plan = JSON.parse(await fs.readFile(novelPaths.mgPlan(sel.novelName, sel.episode), "utf-8")) as MgPlan;
  const outputPath = novelPaths.episodeMgRawVideo(sel.novelName, sel.episode);
  const incomplete = plan.functionCalls.filter((record) => !("status" in record) || record.status !== "completed");
  if (incomplete.length) throw new Error(`仍有 ${incomplete.length} 个视觉视频任务未完成`);
  const nodes = plan.nodes ?? [];
  if (nodes.length !== plan.functionCalls.length) {
    throw new Error(`合成节点数量 ${nodes.length} 与 Function Call 数量 ${plan.functionCalls.length} 不一致`);
  }
  for (const node of nodes) await fs.access(node.videoPath);
  await assertMgVideoFrames(outputPath, plan.source.durationFrames, plan.source.fps);
  return outputPath;
}

export async function renderAndAssembleEssayMg(sel: NovelSelection): Promise<string> {
  const {renderEssayMgEpisode} = await import("./renderer.js");
  await renderEssayMgEpisode(sel);
  return assembleEssayMg(sel);
}
