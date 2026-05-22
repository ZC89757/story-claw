/**
 * Solo 模式 — 全自动执行 A→B→E→F
 */

import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { NovelSelection } from "../ui/select.js";
import { createProgress, progressBar } from "../ui/progress.js";
import { visualPreset, archive, segment, storyboard, renderScene } from "./pipeline.js";
import type { RenderProgress } from "./pipeline.js";
import { initRenderLog } from "./render.js";
import { novelPaths } from "../utils/paths.js";

const execFileAsync = promisify(execFile);

export async function runSolo(sel: NovelSelection) {
  const title = `${sel.novelName} 第${sel.episode}集`;
  const p = createProgress();

  try {
    // 画面预设
    p.start(0, title);
    const presetPath = await visualPreset(sel);
    p.done(0, title, "画面预设.txt");

    // 资源建档
    p.start(1, title);
    const archiveResult = await archive(sel, presetPath);
    p.done(1, title, `场景${archiveResult.sceneNames.length}个`);

    // 剧本分场
    p.start(2, title);
    const scriptsDir = await segment(sel, archiveResult, presetPath);
    p.done(2, title, "scripts/");

    // 分镜制作
    p.start(3, title);
    await storyboard(sel, scriptsDir, (prog) => {
      p.updateSubLines(3, title, [
        `分镜  ${progressBar(prog.done, prog.total)}`,
      ]);
    });
    p.done(3, title);

    // 渲染（每个场景的 JSONL → 视频+TTS → final.mp4，各场景并行）
    p.start(4, title);
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
      p.updateSubLines(4, title,
        Object.values(renderProgress).map(
          (rp) => `${rp.scene}  ${progressBar(rp.done, rp.total)}`,
        ),
      );
    };

    await Promise.all(
      jsonlFiles.map((sceneName) =>
        renderScene(sel, sceneName, (rp) => {
          renderProgress[sceneName] = rp;
          updateRenderSubLines();
        }),
      ),
    );
    p.done(4, title, `${jsonlFiles.length} 个场景`);

    // ── 合并集视频（按 archiveResult.sceneNames 顺序拼接 final.mp4）──
    if (jsonlFiles.length > 0 && archiveResult.sceneNames.length > 0) {
      const episodeVideoPath = novelPaths.episodeVideo(sel.novelName, sel.episode);
      const epDir = novelPaths.episodeDir(sel.novelName, sel.episode);
      const concatListPath = `${epDir}/concat_list.txt`;

      // 按 archiveResult.sceneNames 排序，只包含已渲染的场景
      const orderedScenes = archiveResult.sceneNames.filter((s) => jsonlFiles.includes(s));
      const concatLines = orderedScenes
        .map((s) => `file '${novelPaths.sceneFinalVideo(sel.novelName, sel.episode, s).replace(/\\/g, "/")}'`)
        .join("\n");

      await fs.writeFile(concatListPath, concatLines + "\n", "utf-8");

      await execFileAsync("ffmpeg", [
        "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", concatListPath,
        "-c", "copy",
        episodeVideoPath,
      ]);

      await fs.unlink(concatListPath).catch(() => {});
    }

    // 更新改编进度
    const prog = JSON.parse(await fs.readFile(novelPaths.progress(sel.novelName), "utf-8"));
    prog.next_chapter += 1;
    await fs.writeFile(novelPaths.progress(sel.novelName), JSON.stringify(prog, null, 4), "utf-8");

    console.log(`\n  ${"=".repeat(50)}`);
    console.log(`  完成！产物目录: ${novelPaths.episodeDir(sel.novelName, sel.episode)}`);
    console.log();
  } catch (err) {
    console.error(`\n  x 流水线出错: ${err}\n`);
  }
}
