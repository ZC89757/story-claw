/**
 * Solo 模式 — 全自动执行 A→B→C→E→F
 */

import type { NovelSelection } from "../ui/select.js";
import { createProgress, progressBar } from "../ui/progress.js";
import { stageA, stageB, stageC, stageEF } from "./pipeline.js";

export async function runSolo(sel: NovelSelection) {
  const title = `${sel.novelName} 第${sel.episode}集`;
  const p = createProgress();

  try {
    // A 剧本创作
    p.start(0, title);
    const scriptFile = await stageA(sel);
    p.done(0, title, scriptFile.split(/[/\\]/).pop());

    // B 剧本解析
    p.start(1, title);
    const sceneDataFile = await stageB(sel, scriptFile);
    p.done(1, title, "scene_data.json");

    // C 资源生成
    p.start(2, title);
    const cResult = await stageC(sel, sceneDataFile, (msg) => {
      p.update(2, title, msg);
    });
    p.done(2, title, `角色${cResult.newChars} 场景${cResult.newScenes} 跳过${cResult.skipped}`);

    // E+F 分镜与画面
    p.start(3, title);
    await stageEF(sel, sceneDataFile, scriptFile, (prog) => {
      p.updateSubLines(3, title, [
        `分镜导演  ${progressBar(prog.storyboard.done, prog.storyboard.total)}`,
        `画面合成  ${progressBar(prog.panels.done, prog.panels.total)}`,
      ]);
    });
    p.done(3, title);

    // 完成
    const epDir = sceneDataFile.replace(/[/\\]scene_data\.json$/, "");
    console.log(`\n  ${"=".repeat(50)}`);
    console.log(`  完成！产物目录: ${epDir}`);
    console.log();
  } catch (err) {
    console.error(`\n  x 流水线出错: ${err}\n`);
  }
}
