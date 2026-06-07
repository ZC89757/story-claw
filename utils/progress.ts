/**
 * progress.ts — 改编进度记录
 *
 * 在 改编进度.json 的 episodes[集号].stages 里逐阶段记录完成情况，
 * 用于续跑时跳过已完成阶段、区分 render 的 images_only / done。
 *
 * 结构：
 *   episodes: {
 *     "1": {
 *       chapter: 1,
 *       stages: { visualPreset:"done", archive:"done", segment:"done",
 *                 storyboard:"done", render:"images_only"|"done" },
 *       sceneNames: ["场景1", ...],   // archive 完成时写入，供续跑重建
 *       updated_at: "ISO 时间"
 *     }
 *   }
 */

import fs from "node:fs/promises";
import { novelPaths } from "./paths.js";

export type StageName = "clean" | "visualPreset" | "archive" | "segment" | "storyboard" | "render";
export type StageStatus = "done" | "images_only";

export interface EpisodeRecord {
  chapter?: number;
  stages: Partial<Record<StageName, StageStatus>>;
  sceneNames?: string[];
  updated_at?: string;
}

export async function readProgress(novelName: string): Promise<any> {
  return JSON.parse(await fs.readFile(novelPaths.progress(novelName), "utf-8"));
}

async function writeProgress(novelName: string, prog: any): Promise<void> {
  await fs.writeFile(novelPaths.progress(novelName), JSON.stringify(prog, null, 4), "utf-8");
}

/** 读取某集的阶段记录（不存在则返回空 stages） */
export function getEpisodeRecord(prog: any, episode: number): EpisodeRecord {
  return prog?.episodes?.[String(episode)] ?? { stages: {} };
}

/** 标记某阶段完成（read-modify-write，调用方需保证串行，无并发） */
export async function markStage(
  novelName: string,
  episode: number,
  stage: StageName,
  status: StageStatus,
  extra?: { chapter?: number; sceneNames?: string[] },
): Promise<void> {
  const prog = await readProgress(novelName);
  prog.episodes ??= {};
  const key = String(episode);
  const rec: EpisodeRecord = prog.episodes[key] ?? { stages: {} };
  rec.stages = { ...rec.stages, [stage]: status };
  if (extra?.chapter !== undefined) rec.chapter = extra.chapter;
  if (extra?.sceneNames !== undefined) rec.sceneNames = extra.sceneNames;
  rec.updated_at = new Date().toISOString();
  prog.episodes[key] = rec;
  await writeProgress(novelName, prog);
}

/**
 * 整集完成：render 记 done，追加 adapted（集号递增），next_chapter +1。
 * 只在「完整渲染」成功后调用；images-only 不调用，故进度不推进、可原地续跑补视频。
 */
export async function finalizeEpisode(novelName: string, episode: number): Promise<void> {
  const prog = await readProgress(novelName);
  prog.episodes ??= {};
  const key = String(episode);
  const rec: EpisodeRecord = prog.episodes[key] ?? { stages: {} };
  rec.stages = { ...rec.stages, render: "done" };
  rec.updated_at = new Date().toISOString();
  prog.episodes[key] = rec;

  prog.adapted ??= [];
  if (!prog.adapted.some((a: any) => a?.episode === episode)) {
    prog.adapted.push({ episode });
  }
  prog.next_chapter = (prog.next_chapter ?? 1) + 1;
  await writeProgress(novelName, prog);
}
