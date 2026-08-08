/**
 * Solo 模式 — 全自动执行 A→B→E→F
 */

import fs from "node:fs/promises";
import { execSync } from "node:child_process";
import type { NovelSelection } from "../ui/select.js";
import { createProgress, progressBar } from "../ui/progress.js";
import { cleanText, visualPreset, archive, segment, storyboard, renderScene, assignGlobalOrder } from "./pipeline.js";
import type { RenderProgress, SceneRenderResult } from "./pipeline.js";
import { initRenderLog, globalAlignAndMerge } from "./render.js";
import { generateEpisodeCovers } from "./cover.js";
import { postprocessEpisodeVideo } from "./postprocess.js";
import { novelPaths } from "../utils/paths.js";
import { readProgress, getEpisodeRecord, markStage, finalizeEpisode } from "../utils/progress.js";

export type SoloRunResult = "done" | "images_only" | "already_done" | "failed";

export async function runSolo(sel: NovelSelection): Promise<SoloRunResult> {
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
    // 文章类型由用户新建小说时选定，写进度顶层；之后各集沿用 sel.articleType
    const articleType: "essay" | "story" = sel.articleType ?? "story";
    const isEssay = articleType === "essay";

    // 画面预设（议论文跳过：无场景人物可标）
    p.start(1, title);
    let presetPath = novelPaths.visualPreset(sel.novelName, ep);
    if (isEssay) {
      p.done(1, title, "议论文，跳过画面预设");
    } else if (epRec.stages.visualPreset === "done") {
      p.done(1, title, "已完成，跳过");
    } else {
      presetPath = await visualPreset(sel);
      await markStage(sel.novelName, ep, "visualPreset", "done", { chapter: sel.nextChapter });
      p.done(1, title, "画面预设.txt");
    }

    // 资源建档（议论文跳过：无角色无场景）
    p.start(2, title);
    let archiveResult: { sceneNames: string[] };
    if (isEssay) {
      archiveResult = { sceneNames: [] };
      p.done(2, title, "议论文，跳过资源建档");
    } else if (epRec.stages.archive === "done") {
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
      scriptsDir = await segment(sel, archiveResult, presetPath, articleType);
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
      }, articleType);
      await markStage(sel.novelName, ep, "storyboard", "done");
      p.done(4, title);
    }

    // ── 为 group 附上 global_order ──
    await assignGlobalOrder(sel.novelName, ep, archiveResult.sceneNames, articleType);

    // 整集已完整渲染过，无需再跑
    if (epRec.stages.render === "done") {
      p.done(5, title, "已完成，跳过");
      try {
        await generateEpisodeCovers(sel);
      } catch (err) {
        console.warn(`  [封面] 生成失败，视频集不受影响: ${err}`);
      }
      console.log(`\n  本集已完整渲染完成，无需重跑。`);
      return "already_done";
    }

    // ── 开启 GPU 实例 ──
    console.log(`\n  正在开启 GPU 实例...`);
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
        }, isEssay),
      ),
    );
    p.done(5, title, `${jsonlFiles.length} 个场景`);

    // panel 静态图完成后即可生成横竖封面；失败只告警，不阻断本集。
    try {
      await generateEpisodeCovers(sel);
    } catch (err) {
      console.warn(`  [封面] 生成失败，视频集不受影响: ${err}`);
    }

    // images-only 模式：只出分镜图，记 render=images_only，不推进进度（等 ComfyUI 就绪后重跑补视频）
    if (sel.imagesOnly) {
      await markStage(sel.novelName, ep, "render", "images_only");
      console.log(`\n  ${"=".repeat(50)}`);
      console.log(`  只生图完成！分镜图目录: ${novelPaths.episodeDir(sel.novelName, sel.episode)}`);
      console.log(`  将项目默认渲染模式改为完整渲染后，对同一集再跑一次 /solo 即可补生视频。`);
      console.log();
      return "images_only";
    }

    // ── 全局对齐合并（音视频相向调速后拼为集视频）──
    if (sceneResults.length > 0) {
      const episodeVideoPath = novelPaths.episodeVideo(sel.novelName, sel.episode);
      const epDir = novelPaths.episodeDir(sel.novelName, sel.episode);

      await globalAlignAndMerge(sceneResults, episodeVideoPath, epDir);
    }

    // ── 最终视频后处理：故事加标题并 1.1x；议论文 1.2x 并混入本地随机 BGM。
    // 失败只告警，保留原始成片并照常完成本集。
    try {
      await postprocessEpisodeVideo(sel);
    } catch (err) {
      console.warn(`  [视频后处理] 失败，保留当前集视频: ${err}`);
    }

    // 整集完成：render=done，追加 adapted、next_chapter +1
    await finalizeEpisode(sel.novelName, ep);

    console.log(`\n  ${"=".repeat(50)}`);
    console.log(`  完成！产物目录: ${novelPaths.episodeDir(sel.novelName, sel.episode)}`);
    console.log();
    return "done";

  } catch (err) {
    console.error(`\n  x 流水线出错: ${err}\n`);
    return "failed";
  } finally {
    // ── 无论成功还是出错，都关闭 GPU 实例 ──
    execSync("python scripts/shutdown_gpu.py", { stdio: "inherit" });
  }
}

/** 从当前进度开始，串行跑完项目中所有连续章节。 */
export async function runAllEpisodes(initialSel: NovelSelection): Promise<void> {
  if (initialSel.imagesOnly) {
    console.log("\n  x /all 不支持项目默认的‘只生分镜图’模式。\n  请先在改编进度.json 中将 render_mode 改为 full。\n");
    return;
  }

  let completed = 0;

  while (true) {
    const progress = await readProgress(initialSel.novelName);
    const nextChapter: number = progress.next_chapter ?? 1;
    const episode = (progress.adapted?.length ?? 0) + 1;
    const sourcePath: string = progress.source_path ?? initialSel.sourcePath;

    let chapterNumbers: number[];
    try {
      chapterNumbers = (await fs.readdir(sourcePath))
        .map((filename) => filename.match(/^第(\d+)章.*\.txt$/)?.[1])
        .filter((chapter): chapter is string => chapter !== undefined)
        .map(Number);
    } catch (err) {
      console.error(`\n  x 无法读取小说源目录: ${sourcePath}\n  ${err}\n`);
      return;
    }

    if (!chapterNumbers.includes(nextChapter)) {
      const higherChapter = chapterNumbers.some((chapter) => chapter > nextChapter);
      if (higherChapter) {
        console.error(`\n  x 章节断号：找不到第${nextChapter}章，但源目录中存在更高章号。`);
        console.error("  /all 已停止，请补齐章节文件后重试。\n");
      } else {
        console.log(`\n  ${"=".repeat(50)}`);
        console.log(`  全项目运行完成！本次完成 ${completed} 集。`);
        console.log();
      }
      return;
    }

    console.log(`\n  [全项目] 开始第${episode}集（第${nextChapter}章）`);
    const result = await runSolo({
      ...initialSel,
      sourcePath,
      episode,
      nextChapter,
    });

    if (result !== "done") {
      console.error(`\n  /all 已在第${episode}集停止（状态：${result}），现有进度已保留。\n`);
      return;
    }

    const updated = await readProgress(initialSel.novelName);
    if ((updated.next_chapter ?? nextChapter) <= nextChapter) {
      console.error(`\n  x 第${episode}集完成后章节进度未推进，/all 已停止。\n`);
      return;
    }

    completed += 1;
  }
}
