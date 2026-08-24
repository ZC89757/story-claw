/**
 * Solo 模式 — 全自动执行 A→B→E→F
 */

import fs from "node:fs/promises";
import { execSync } from "node:child_process";
import type { NovelSelection } from "../ui/select.js";
import { createProgress, progressBar } from "../ui/progress.js";
import { cleanText, visualPreset, archive, segment, storyboard, renderScene, assignGlobalOrder } from "./pipeline.js";
import type { RenderProgress, SceneRenderResult } from "./pipeline.js";
import {
  buildEpisodeMaster,
  finalizeEpisodeMedia,
  globalAlignAndMerge,
  initRenderLog,
} from "./render.js";
import { generateEpisodeCovers } from "./cover.js";
import { postprocessEpisodeVideo } from "./postprocess.js";
import { novelPaths } from "../utils/paths.js";
import { readProgress, getEpisodeRecord, markStage, finalizeEpisode } from "../utils/progress.js";
import { annotateEssayMg } from "./mg/annotate.js";
import { planEssayMg } from "./mg/planner.js";
import { renderAndAssembleEssayMg } from "./mg/assembler.js";

export type SoloRunResult = "done" | "images_only" | "already_done" | "review_pending" | "failed";

export type SoloPhase =
  | "planning"
  | "preparing"
  | "mg_annotating"
  | "visual_preset"
  | "visual_preset_review"
  | "archiving"
  | "segmenting"
  | "storyboarding"
  | "ordering"
  | "gpu_queued"
  | "gpu_ready"
  | "rendering"
  | "merging"
  | "mg_planning"
  | "mg_rendering"
  | "finalizing"
  | "postprocessing"
  | "completed"
  | "failed"
  | "gpu_stopped";

export interface SoloPhaseEvent {
  phase: SoloPhase;
  label: string;
  detail?: string;
}

export type SoloPhaseReporter = (event: SoloPhaseEvent) => void;

const STORY_PROGRESS = [
  "原文清理",
  "画面预设",
  "资源建档",
  "剧本分场",
  "分镜制作",
  "渲染合成",
] as const;

const ESSAY_PROGRESS = [
  "原文清理",
  "MG 语义标注",
  "画面预设",
  "资源建档",
  "剧本分场",
  "分镜制作",
  "原画渲染",
  "MG 参数规划",
  "MG 动画渲染",
  "最终合成",
] as const;

export async function runSolo(sel: NovelSelection, onPhase?: SoloPhaseReporter): Promise<SoloRunResult> {
  const title = `${sel.novelName} 第${sel.episode}集`;
  const ep = sel.episode;
  const articleType: "essay" | "story" = sel.articleType ?? "story";
  const isEssay = articleType === "essay";
  const progressLabels = isEssay ? ESSAY_PROGRESS : STORY_PROGRESS;
  const reviewPhase = isEssay
    ? {
      label: "等待审核画面与 MG 标注",
      detail: "画面预设和 MG 标注已生成，请确认或提出修改意见",
    }
    : {
      label: "等待审核画面预设",
      detail: "画面预设已生成，请确认或提出修改意见",
    };
  const p = createProgress(progressLabels);
  const progressIndex = {
    clean: 0,
    mgAnnotate: isEssay ? 1 : -1,
    visualPreset: isEssay ? 2 : 1,
    archive: isEssay ? 3 : 2,
    segment: isEssay ? 4 : 3,
    storyboard: isEssay ? 5 : 4,
    render: isEssay ? 6 : 5,
    mgPlan: isEssay ? 7 : -1,
    mgRender: isEssay ? 8 : -1,
    finalize: isEssay ? 9 : -1,
  } as const;
  let gpuStarted = false;
  let terminalPhase: SoloPhaseEvent | null = null;

  const reportPhase = (event: SoloPhaseEvent): void => {
    try {
      onPhase?.(event);
    } catch {
      // 桌面端状态上报失败不应影响流水线本身。
    }
  };

  const stopGpu = (): void => {
    if (!gpuStarted) return;
    execSync("python -u scripts/shutdown_gpu.py", { stdio: "inherit" });
    gpuStarted = false;
    reportPhase({ phase: "gpu_stopped", label: "GPU 已关闭", detail: "本次渲染实例已经停止计费" });
  };

  reportPhase({ phase: "planning", label: "规划中", detail: `${title} 正在生成分场与分镜规划` });

  try {
    // 读取本集已记录的阶段进度，用于跳过已完成阶段（续跑）
    const epRec = getEpisodeRecord(await readProgress(sel.novelName), ep);

    // 原文清理
    reportPhase({ phase: "preparing", label: "整理原文", detail: `${title} 正在读取并清理原始章节` });
    p.start(progressIndex.clean, title);
    if (epRec.stages.clean === "done") {
      p.done(progressIndex.clean, title, "已完成，跳过");
    } else {
      await cleanText(sel);
      await markStage(sel.novelName, ep, "clean", "done", { chapter: sel.nextChapter });
      p.done(progressIndex.clean, title, "原文_clean.txt");
    }

    // 议论文第一步 AI：只做 HTML 语义标注。画面预设仍只读取原文_clean.txt。
    if (isEssay) {
      reportPhase({
        phase: "mg_annotating",
        label: "生成 MG 语义标注",
        detail: "正在为适合动态图形表达的原文添加 group、mode 和 value",
      });
      p.start(progressIndex.mgAnnotate, title);
      if (epRec.stages.mgAnnotate === "done") {
        await fs.access(novelPaths.mgAnnotation(sel.novelName, ep));
        p.done(progressIndex.mgAnnotate, title, "已完成，跳过");
      } else {
        await annotateEssayMg(sel);
        await markStage(sel.novelName, ep, "mgAnnotate", "done");
        p.done(progressIndex.mgAnnotate, title, "mg_annotation.html");
      }
    }

    // 画面预设：故事文标注场景人物；议论文在这里固定逐行 group 边界与画面意图。
    reportPhase({
      phase: "visual_preset",
      label: "生成画面预设",
      detail: isEssay ? "正在逐句划分分镜组并规划画面意图" : "正在逐句分析场景、人物与镜头语言",
    });
    p.start(progressIndex.visualPreset, title);
    let presetPath = novelPaths.visualPreset(sel.novelName, ep);
    if (epRec.stages.visualPreset === "done") {
      p.done(progressIndex.visualPreset, title, "已完成，跳过");
    } else if (epRec.stages.visualPreset === "review") {
      reportPhase({ phase: "visual_preset_review", ...reviewPhase });
      return "review_pending";
    } else {
      presetPath = await visualPreset(sel, articleType);
      if (sel.reviewVisualPreset) {
        await markStage(sel.novelName, ep, "visualPreset", "review", { chapter: sel.nextChapter });
        p.done(progressIndex.visualPreset, title, "等待用户审核");
        reportPhase({ phase: "visual_preset_review", ...reviewPhase });
        return "review_pending";
      }
      await markStage(sel.novelName, ep, "visualPreset", "done", { chapter: sel.nextChapter });
      p.done(progressIndex.visualPreset, title, "画面预设.txt");
    }

    // 资源建档（议论文跳过：无角色无场景）
    reportPhase({
      phase: "archiving",
      label: isEssay ? "检查资源建档" : "资源建档",
      detail: isEssay ? "议论文无需角色与场景资源，正在跳过" : "正在整理角色、场景与参考图资源",
    });
    p.start(progressIndex.archive, title);
    let archiveResult: { sceneNames: string[] };
    if (isEssay) {
      archiveResult = { sceneNames: [] };
      p.done(progressIndex.archive, title, "议论文，跳过资源建档");
    } else if (epRec.stages.archive === "done") {
      archiveResult = { sceneNames: epRec.sceneNames ?? [] };
      p.done(progressIndex.archive, title, `已完成，跳过（场景${archiveResult.sceneNames.length}个）`);
    } else {
      archiveResult = await archive(sel, presetPath);
      await markStage(sel.novelName, ep, "archive", "done", { sceneNames: archiveResult.sceneNames });
      p.done(progressIndex.archive, title, `场景${archiveResult.sceneNames.length}个`);
    }

    // 剧本分场
    reportPhase({
      phase: "segmenting",
      label: isEssay ? "分配分镜任务" : "剧本分场",
      detail: isEssay ? "正在按画面预设行数均匀分配分镜任务" : "正在按场景拆分本集原文",
    });
    p.start(progressIndex.segment, title);
    let scriptsDir = novelPaths.scriptsDir(sel.novelName, ep);
    if (epRec.stages.segment === "done") {
      p.done(progressIndex.segment, title, "已完成，跳过");
    } else {
      scriptsDir = await segment(sel, archiveResult, presetPath, articleType);
      await markStage(sel.novelName, ep, "segment", "done");
      p.done(progressIndex.segment, title, "scripts/");
    }

    // 分镜制作
    reportPhase({ phase: "storyboarding", label: "分镜制作", detail: "正在为各场景规划镜头与画面提示词" });
    p.start(progressIndex.storyboard, title);
    if (epRec.stages.storyboard === "done") {
      p.done(progressIndex.storyboard, title, "已完成，跳过");
    } else {
      await storyboard(sel, scriptsDir, (prog) => {
        reportPhase({
          phase: "storyboarding",
          label: "分镜制作",
          detail: `已完成 ${prog.done} / ${prog.total} 个${isEssay ? "任务文件" : "场景"}`,
        });
        p.updateSubLines(progressIndex.storyboard, title, [
          `分镜  ${progressBar(prog.done, prog.total)}`,
        ]);
      }, articleType);
      await markStage(sel.novelName, ep, "storyboard", "done");
      p.done(progressIndex.storyboard, title);
    }

    // ── 为 group 附上 global_order ──
    reportPhase({ phase: "ordering", label: "整理分镜顺序", detail: "正在按原文顺序分配全局镜头编号" });
    await assignGlobalOrder(sel.novelName, ep, archiveResult.sceneNames, articleType);

    // 故事以 render 为终点；议论文只有 MG、字幕、音轨和后处理全部完成才算完成。
    const isEpisodeDone = isEssay
      ? epRec.stages.finalize === "done"
      : epRec.stages.render === "done";
    if (isEpisodeDone) {
      await fs.access(novelPaths.episodeVideo(sel.novelName, ep));
      p.done(progressIndex.render, title, "已完成，跳过");
      if (isEssay) {
        p.done(progressIndex.mgPlan, title, "已完成，跳过");
        p.done(progressIndex.mgRender, title, "已完成，跳过");
        p.done(progressIndex.finalize, title, "已完成，跳过");
      }
      try {
        await generateEpisodeCovers(sel);
      } catch (err) {
        console.warn(`  [封面] 生成失败，视频集不受影响: ${err}`);
      }
      console.log(`\n  本集已完整渲染完成，无需重跑。`);
      terminalPhase = { phase: "completed", label: "已完成", detail: "本集已经完成，无需重复渲染" };
      return "already_done";
    }

    const needsOriginalRender = epRec.stages.render !== "done";

    // 只有原画尚未完成时才申请 GPU；MG 续跑不占用远端渲染实例。
    if (needsOriginalRender && !sel.imagesOnly) {
      reportPhase({
        phase: "gpu_queued",
        label: "GPU 启动与预热中",
        detail: "正在申请 GPU 实例，并等待渲染服务完成预热与自检",
      });
      console.log(`\n  正在启动 GPU；实例启动后会自动等待渲染服务预热...`);
      // 从发起抢占起就接管生命周期，确保就绪探测失败时也会进入 finally 关机。
      gpuStarted = true;
      execSync("python -u scripts/grab_gpu.py", { stdio: "inherit" });
      console.log(`  GPU 实例已就绪\n`);
      reportPhase({ phase: "gpu_ready", label: "GPU 已就绪", detail: "渲染资源已准备完成" });
    }

    let sceneResults: SceneRenderResult[] = [];
    if (needsOriginalRender) {
      // 渲染（每个场景的 JSONL → 视频+TTS，各场景并行）
      reportPhase({
        phase: "rendering",
        label: sel.imagesOnly ? "生成分镜图" : isEssay ? "渲染原画" : "渲染合成中",
        detail: sel.imagesOnly ? "正在生成分镜静态图" : "正在生成配音和原画视频",
      });
      p.start(progressIndex.render, title);
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
        p.updateSubLines(
          progressIndex.render,
          title,
          Object.values(renderProgress).map(
            (rp) => `${rp.scene}  ${progressBar(rp.done, rp.total)}`,
          ),
        );
      };

      sceneResults = await Promise.all(
        jsonlFiles.map((sceneName) =>
          renderScene(sel, sceneName, (rp) => {
            renderProgress[sceneName] = rp;
            reportPhase({
              phase: "rendering",
              label: sel.imagesOnly ? "生成分镜图" : isEssay ? "渲染原画" : "渲染合成中",
              detail: `${rp.scene} · 已完成 ${rp.done} / ${rp.total} 个镜头`,
            });
            updateRenderSubLines();
          }, isEssay),
        ),
      );
      p.done(progressIndex.render, title, `${jsonlFiles.length} 个场景`);

      // panel 静态图完成后即可生成横竖封面；失败只告警，不阻断本集。
      if (!sel.imagesOnly) {
        try {
          await generateEpisodeCovers(sel);
        } catch (err) {
          console.warn(`  [封面] 生成失败，视频集不受影响: ${err}`);
        }
      }

      // images-only 只产出分镜图，不生成母版、时间轴或 MG。
      if (sel.imagesOnly) {
        await markStage(sel.novelName, ep, "render", "images_only");
        console.log(`\n  ${"=".repeat(50)}`);
        console.log(`  只生图完成！分镜图目录: ${novelPaths.episodeDir(sel.novelName, sel.episode)}`);
        console.log(`  将项目默认渲染模式改为完整渲染后，对同一集再跑一次 /solo 即可补生视频。`);
        console.log();
        terminalPhase = { phase: "completed", label: "分镜图已完成", detail: "已生成全部分镜静态图" };
        return "images_only";
      }

      reportPhase({
        phase: "merging",
        label: isEssay ? "构建原画母版" : "合并成片",
        detail: isEssay
          ? "正在生成只读原画、对齐音轨、字级时间轴和字幕事件"
          : "正在对齐各场景音视频并合并本集成片",
      });
      const episodeVideoPath = novelPaths.episodeVideo(sel.novelName, ep);
      const rawVideoPath = novelPaths.episodeRawVideo(sel.novelName, ep);
      const epDir = novelPaths.episodeDir(sel.novelName, ep);

      if (isEssay) {
        await buildEpisodeMaster(
          sceneResults,
          epDir,
          rawVideoPath,
          novelPaths.episodeAlignedAudio(sel.novelName, ep),
        );
        await markStage(sel.novelName, ep, "render", "done");
        // 后续 Function Calling 与 Remotion 不使用远端 GPU，母版完成后立即停机。
        stopGpu();
      } else if (sceneResults.length > 0) {
        await globalAlignAndMerge(sceneResults, episodeVideoPath, epDir, rawVideoPath);
      }
    } else {
      p.done(progressIndex.render, title, "原画母版已完成，跳过");
      if (isEssay) {
        await Promise.all([
          fs.access(novelPaths.episodeRawVideo(sel.novelName, ep)),
          fs.access(novelPaths.episodeAlignedAudio(sel.novelName, ep)),
          fs.access(novelPaths.articleTimeline(sel.novelName, ep)),
        ]);
      }
    }

    // 即使原画已完成，images-only 也不进入 MG 和最终合成阶段。
    if (sel.imagesOnly) {
      terminalPhase = { phase: "completed", label: "分镜图已完成", detail: "只生分镜图模式未执行 MG" };
      return "images_only";
    }

    if (isEssay) {
      // 第二步 AI：直接读取完整 HTML + 字级时间轴，以 Function Calling 填写模板内容和 at。
      reportPhase({ phase: "mg_planning", label: "规划 MG 参数", detail: "正在调用动画模板函数并校验绝对时间戳" });
      p.start(progressIndex.mgPlan, title);
      if (epRec.stages.mgPlan === "done") {
        await Promise.all([
          fs.access(novelPaths.mgPlan(sel.novelName, ep)),
          fs.access(novelPaths.mgRenderBundle(sel.novelName, ep)),
        ]);
        p.done(progressIndex.mgPlan, title, "已完成，跳过");
      } else {
        await planEssayMg(sel);
        await markStage(sel.novelName, ep, "mgPlan", "done");
        p.done(progressIndex.mgPlan, title, "function_calls.json / mg_plan.json");
      }

      reportPhase({ phase: "mg_rendering", label: "渲染 MG 动画", detail: "正在渲染模板并按时间轴插回原画" });
      p.start(progressIndex.mgRender, title);
      if (epRec.stages.mgRender === "done") {
        await fs.access(novelPaths.episodeMgRawVideo(sel.novelName, ep));
        p.done(progressIndex.mgRender, title, "已完成，跳过");
      } else {
        await renderAndAssembleEssayMg(sel);
        await markStage(sel.novelName, ep, "mgRender", "done");
        p.done(progressIndex.mgRender, title, "epXX_mg_raw.mp4");
      }

      reportPhase({ phase: "finalizing", label: "合成音轨与字幕", detail: "正在给 MG 原片加入对齐旁白和字幕" });
      p.start(progressIndex.finalize, title);
      // 若上次在进度落盘前中断，必须重新执行后处理，不能让旧 marker 跳过新封装的视频。
      await fs.rm(novelPaths.postprocessMarker(sel.novelName, ep), { force: true });
      await finalizeEpisodeMedia(
        novelPaths.episodeMgRawVideo(sel.novelName, ep),
        novelPaths.episodeAlignedAudio(sel.novelName, ep),
        novelPaths.episodeVideo(sel.novelName, ep),
        novelPaths.globalSubtitlesAss(sel.novelName, ep),
      );
    }

    // ── 最终视频后处理：故事加标题并 1.1x；议论文 1.2x 并混入本地随机 BGM。
    // 故事保持原有的告警后继续；议论文后处理属于 finalize 契约，失败时不得推进章节。
    reportPhase({ phase: "postprocessing", label: "成片后处理", detail: "正在处理标题、播放速度与背景音乐" });
    try {
      await postprocessEpisodeVideo(sel);
    } catch (err) {
      if (isEssay) throw err;
      console.warn(`  [视频后处理] 失败，保留当前集视频: ${err}`);
    }

    if (isEssay) p.done(progressIndex.finalize, title, "字幕、音轨与后处理完成");

    // 整集完成和章节推进同一次写入；议论文以 finalize、故事以 render 作为终态。
    await finalizeEpisode(sel.novelName, ep, isEssay ? "finalize" : "render");

    console.log(`\n  ${"=".repeat(50)}`);
    console.log(`  完成！产物目录: ${novelPaths.episodeDir(sel.novelName, sel.episode)}`);
    console.log();
    terminalPhase = { phase: "completed", label: "已完成", detail: "本集成片已生成" };
    return "done";

  } catch (err) {
    console.error(`\n  x 流水线出错: ${err}\n`);
    terminalPhase = { phase: "failed", label: "运行失败", detail: err instanceof Error ? err.message : String(err) };
    return "failed";
  } finally {
    // ── 本次启动过 GPU 时，无论成功还是出错都负责关闭 ──
    if (gpuStarted) {
      try {
        stopGpu();
      } catch (error) {
        reportPhase({
          phase: "failed",
          label: "GPU 关闭失败",
          detail: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }
    if (terminalPhase) reportPhase(terminalPhase);
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
