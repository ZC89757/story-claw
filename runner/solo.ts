/**
 * Solo 模式 — 全自动执行 A→B→E→F
 */

import fs from "node:fs/promises";
import type { NovelSelection } from "../ui/select.js";
import { createProgress, progressBar } from "../ui/progress.js";
import { visualPreset, archive, segment, storyboard, renderScene } from "./pipeline.js";
import type { RenderProgress } from "./pipeline.js";
import { novelPaths } from "../utils/paths.js";

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
    const jsonlFiles = (await fs.readdir(novelPaths.episodeDir(sel.novelName, sel.episode)))
      .filter((f) => f.startsWith("storyboard_") && f.endsWith(".jsonl"))
      .map((f) => f.replace(/^storyboard_/, "").replace(/\.jsonl$/, ""));

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
