/**
 * Custom 模式 — A→B→暂停（用户检查/替换资源）→E→F
 */

import fs from "node:fs/promises";
import readline from "node:readline";
import { novelPaths } from "../utils/paths.js";
import type { NovelSelection } from "../ui/select.js";
import { createProgress, progressBar } from "../ui/progress.js";
import { visualPreset, archive, segment, storyboard, listResources } from "./pipeline.js";

function waitForEnter(rl: readline.Interface): Promise<void> {
  return new Promise((resolve) => {
    rl.question("  按 Enter 继续生成分镜...", () => resolve());
  });
}

export async function runCustom(sel: NovelSelection, rl: readline.Interface) {
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

    // 分镜制作
    p.start(3, title);
    await storyboard(sel, scriptsDir, (prog) => {
      p.updateSubLines(3, title, [
        `分镜  ${progressBar(prog.done, prog.total)}`,
      ]);
    });
    p.done(3, title);

    // 更新改编进度
    const prog = JSON.parse(await fs.readFile(novelPaths.progress(sel.novelName), "utf-8"));
    prog.next_chapter += 1;
    await fs.writeFile(novelPaths.progress(sel.novelName), JSON.stringify(prog, null, 4), "utf-8");

    console.log(`\n  ${"=".repeat(50)}`);
    console.log(`  完成！产物目录: ${epDir}`);
    console.log();
  } catch (err) {
    console.error(`\n  x 流水线出错: ${err}\n`);
  }
}
