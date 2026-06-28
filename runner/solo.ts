/**
 * Solo 模式 — 全自动执行 A→B→E→F
 */

import fs from "node:fs/promises";
import type { NovelSelection } from "../ui/select.js";
import { createProgress, progressBar } from "../ui/progress.js";
import { cleanText, visualPreset, archive, segment, storyboard, renderScene, assignGlobalOrder } from "./pipeline.js";
import type { RenderProgress, SceneRenderResult } from "./pipeline.js";
import { initRenderLog, globalAlignAndMerge } from "./render.js";
import { novelPaths } from "../utils/paths.js";
import { readProgress, getEpisodeRecord, markStage, finalizeEpisode } from "../utils/progress.js";

export async function runSolo(sel: NovelSelection) {
  const title = `${sel.novelName} 第${sel.episode}集`;
  const ep = sel.episode;
  const p = createProgress();

  try {
    // 读取本集已记录的阶段进度，用于跳过已完成阶段（续跑）
    const epRec = getEpisodeRecord(await readProgress(sel.novelName), ep);

    // 原文清理
    p.start(0, title);
    if (epRec.stages.clean === "done") {
      p.done(0, title, "已完成，跳过");
    } else {
      await cleanText(sel);
      await markStage(sel.novelName, ep, "clean", "done", { chapter: sel.nextChapter });
      p.done(0, title, "原文_clean.txt");
    }

    // 画面预设
    p.start(1, title);
    let presetPath = novelPaths.visualPreset(sel.novelName, ep);
    if (epRec.stages.visualPreset === "done") {
      p.done(1, title, "已完成，跳过");
    } else {
      presetPath = await visualPreset(sel);
      await markStage(sel.novelName, ep, "visualPreset", "done", { chapter: sel.nextChapter });
      p.done(1, title, "画面预设.txt");
    }

    // 资源建档
    p.start(2, title);
    let archiveResult: { sceneNames: string[] };
    if (epRec.stages.archive === "done") {
      archiveResult = { sceneNames: epRec.sceneNames ?? [] };
      p.done(2, title, `已完成，跳过（场景${archiveResult.sceneNames.length}个）`);
    } else {
      archiveResult = await archive(sel, presetPath);
      await markStage(sel.novelName, ep, "archive", "done", { sceneNames: archiveResult.sceneNames });
      p.done(2, title, `场景${archiveResult.sceneNames.length}个`);
    }

    // 剧本分场
    p.start(3, title);
    let scriptsDir = novelPaths.scriptsDir(sel.novelName, ep);
    if (epRec.stages.segment === "done") {
      p.done(3, title, "已完成，跳过");
    } else {
      scriptsDir = await segment(sel, archiveResult, presetPath);
      await markStage(sel.novelName, ep, "segment", "done");
      p.done(3, title, "scripts/");
    }

    // 分镜制作
    p.start(4, title);
    if (epRec.stages.storyboard === "done") {
      p.done(4, title, "已完成，跳过");
    } else {
      await storyboard(sel, scriptsDir, (prog) => {
        p.updateSubLines(4, title, [
          `分镜  ${progressBar(prog.done, prog.total)}`,
        ]);
      });
      await markStage(sel.novelName, ep, "storyboard", "done");
      p.done(4, title);
    }

    // ── 为 group 附上 global_order ──
    await assignGlobalOrder(sel.novelName, ep, archiveResult.sceneNames);

    // 整集已完整渲染过，无需再跑
    if (epRec.stages.render === "done") {
      p.done(5, title, "已完成，跳过");
      console.log(`\n  本集已完整渲染完成，无需重跑。`);
      return;
    }

    // ── 开启 GPU 实例 ──
    console.log(`\n  正在开启 GPU 实例...`);
    const { execSync } = await import("node:child_process");
    execSync("python scripts/grab_gpu.py", { stdio: "inherit" });
    console.log(`  GPU 实例已就绪\n`);

    // 渲染（每个场景的 JSONL → 视频+TTS → final.mp4，各场景并行）
    p.start(5, title);
    initRenderLog(novelPaths.episodeDir(sel.novelName, sel.episode) + "/render.log");
    const storyboardsDir = novelPaths.storyboardsDir(sel.novelName, sel.episode);
    let jsonlFiles: string[] = [];
    try {
      jsonlFiles = (await fs.readdir(storyboardsDir))
        .filter((f) => f.startsWith("storyboard_") && f.endsWith(".jsonl"))
        .map((f) => f.replace(/^storyboard_/, "").replace(/\.jsonl$/, ""));
    } catch { /* storyboards/ 目录不存在则跳过 */ }

    const renderProgress: Record<string, RenderProgress> = {};
    const updateRenderSubLines = () => {
      p.updateSubLines(5, title,
        Object.values(renderProgress).map(
          (rp) => `${rp.scene}  ${progressBar(rp.done, rp.total)}`,
        ),
      );
    };

    const sceneResults: SceneRenderResult[] = await Promise.all(
      jsonlFiles.map((sceneName) =>
        renderScene(sel, sceneName, (rp) => {
          renderProgress[sceneName] = rp;
          updateRenderSubLines();
        }),
      ),
    );
    p.done(5, title, `${jsonlFiles.length} 个场景`);

    // images-only 模式：只出分镜图，记 render=images_only，不推进进度（等 ComfyUI 就绪后重跑补视频）
    if (sel.imagesOnly) {
      await markStage(sel.novelName, ep, "render", "images_only");
      console.log(`\n  ${"=".repeat(50)}`);
      console.log(`  只生图完成！分镜图目录: ${novelPaths.episodeDir(sel.novelName, sel.episode)}`);
      console.log(`  开启 ComfyUI 后，对同一集再跑一次 /solo 即可补生视频。`);
      console.log();
      return;
    }

    // ── 全局对齐合并（音视频相向调速后拼为集视频）──
    if (sceneResults.length > 0) {
      const episodeVideoPath = novelPaths.episodeVideo(sel.novelName, sel.episode);
      const epDir = novelPaths.episodeDir(sel.novelName, sel.episode);

      await globalAlignAndMerge(sceneResults, episodeVideoPath, epDir);
    }

    // 整集完成：render=done，追加 adapted、next_chapter +1
    await finalizeEpisode(sel.novelName, ep);

    console.log(`\n  ${"=".repeat(50)}`);
    console.log(`  完成！产物目录: ${novelPaths.episodeDir(sel.novelName, sel.episode)}`);
    console.log();

  } catch (err) {
    console.error(`\n  x 流水线出错: ${err}\n`);
  } finally {
    // ── 无论成功还是出错，都关闭 GPU 实例 ──
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("child_process").execSync("python scripts/shutdown_gpu.py", { stdio: "inherit" });
  }
}
