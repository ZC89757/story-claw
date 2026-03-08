/**
 * Custom 模式 — A→B→C→暂停（用户检查/替换资源）→E→F
 */

import readline from "node:readline";
import { novelPaths } from "../utils/paths.js";
import type { NovelSelection } from "../ui/select.js";
import { createProgress, progressBar } from "../ui/progress.js";
import { stageA, stageB, stageC, stageEF, listResources } from "./pipeline.js";

function waitForEnter(rl: readline.Interface): Promise<void> {
  return new Promise((resolve) => {
    rl.question("  按 Enter 继续生成分镜...", () => resolve());
  });
}

export async function runCustom(sel: NovelSelection, rl: readline.Interface) {
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

    // ── 暂停：展示资源目录，等待用户确认 ──
    const resources = await listResources(sel.novelName);
    const charDir = novelPaths.charactersDir(sel.novelName);
    const sceneDir = novelPaths.scenesDir(sel.novelName);

    console.log(`\n  ${"─".repeat(50)}`);
    console.log("  资源已就绪，请检查并按需替换：\n");

    console.log(`  角色参考图: ${charDir}`);
    if (resources.characters.length > 0) {
      console.log(`    ${resources.characters.map((n) => n + ".png").join("  ")}`);
    }
    console.log();

    console.log(`  场景底图:   ${sceneDir}`);
    if (resources.scenes.length > 0) {
      console.log(`    ${resources.scenes.map((n) => n + ".png").join("  ")}`);
    }
    console.log();

    console.log("  替换方法：将自己的图片放入目录，同名覆盖即可。");
    console.log(`  ${"─".repeat(50)}`);

    await waitForEnter(rl);

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
