import fs from "node:fs/promises";
import type {NovelSelection} from "../../ui/select.js";
import {novelPaths} from "../../utils/paths.js";
import {assertMgVideoFrames, sha256File} from "./media.js";
import type {MgPlan} from "./types.js";

/**
 * MG is rendered as one full-episode composition. This is intentionally not a
 * concat step: overlay layers remain in the same alpha-capable compositor as
 * the raw master until the final H.264 encode.
 */
export async function assembleEssayMg(sel: NovelSelection): Promise<string> {
  const plan = JSON.parse(await fs.readFile(novelPaths.mgPlan(sel.novelName, sel.episode), "utf-8")) as MgPlan;
  const rawVideoPath = novelPaths.episodeRawVideo(sel.novelName, sel.episode);
  const outputPath = novelPaths.episodeMgRawVideo(sel.novelName, sel.episode);
  if (await sha256File(rawVideoPath) !== plan.source.sha256) throw new Error("原画母版与 MG 计划哈希不一致，停止合成");
  await assertMgVideoFrames(outputPath, plan.source.durationFrames, plan.source.fps);
  return outputPath;
}

export async function renderAndAssembleEssayMg(sel: NovelSelection): Promise<string> {
  const {renderEssayMgEpisode} = await import("./renderer.js");
  return renderEssayMgEpisode(sel);
}
