/**
 * 小说选择交互 — 列出已有小说 / 新建小说
 */

import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { PATHS, novelPaths } from "../utils/paths.js";

export interface NovelSelection {
  novelName: string;
  sourcePath: string;
  episode: number;
  nextChapter: number;
  ethnicity: string;
  aspectRatio: string;
}

interface Progress {
  novel_name: string;
  source_path?: string;
  adapted: Array<{ episode: number }>;
  next_chapter: number;
}

/** 从 readline 读取一行输入 */
function ask(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(answer.trim()));
  });
}

const ETHNICITY_OPTIONS: Array<{ label: string; value: string }> = [
  { label: "亚裔（东亚面孔）", value: "东亚面孔，亚裔" },
  { label: "欧美白人", value: "欧美面孔，白人" },
  { label: "非裔", value: "非洲裔面孔，黑人" },
  { label: "拉丁裔", value: "拉丁美洲裔面孔" },
  { label: "南亚裔", value: "南亚裔面孔" },
  { label: "按故事推测（自动）", value: "" },
];

/** 交互选择分镜画幅比例 */
async function selectAspectRatio(rl: readline.Interface): Promise<string> {
  console.log("\n  选择分镜画幅比例：");
  console.log("  [1] 竖屏 9:16（默认）");
  console.log("  [2] 横屏 16:9");
  console.log();
  const choice = await ask(rl, "  请选择（回车 = 竖屏 9:16）: ");
  return choice === "2" ? "16:9" : "9:16";
}

/** 交互选择人物人种风格 */
async function selectEthnicity(rl: readline.Interface): Promise<string> {
  console.log("\n  选择人物人种风格：");
  for (let i = 0; i < ETHNICITY_OPTIONS.length; i++) {
    console.log(`  [${i + 1}] ${ETHNICITY_OPTIONS[i].label}`);
  }
  console.log();
  const choice = await ask(rl, "  请选择（回车 = 亚裔）: ");
  const num = parseInt(choice, 10);
  if (num >= 1 && num <= ETHNICITY_OPTIONS.length) {
    return ETHNICITY_OPTIONS[num - 1].value;
  }
  return ETHNICITY_OPTIONS[0].value; // 默认亚裔
}

/** 扫描小说文件夹中的章节文件数量 */
async function countChapters(folder: string): Promise<number> {
  try {
    const files = await fs.readdir(folder);
    return files.filter((f) => /^第\d+章.*\.txt$/.test(f)).length;
  } catch {
    return 0;
  }
}

/** 选择小说并确认，返回 NovelSelection 或 null（用户取消） */
export async function selectNovel(rl: readline.Interface): Promise<NovelSelection | null> {
  // 扫描已有小说
  const workspace = PATHS.workspace;
  const novels: Progress[] = [];

  try {
    const entries = await fs.readdir(workspace);
    for (const name of entries) {
      const progressPath = path.join(workspace, name, "改编进度.json");
      try {
        const content = await fs.readFile(progressPath, "utf-8");
        novels.push(JSON.parse(content));
      } catch {
        // 跳过无效目录
      }
    }
  } catch {
    // workspace 不存在
  }

  // 列出选项
  console.log("\n  选择小说：");
  for (let i = 0; i < novels.length; i++) {
    const n = novels[i];
    const epCount = n.adapted?.length ?? 0;
    const nextEp = epCount + 1;
    const nextChapter = n.next_chapter ?? 1;
    console.log(`  [${i + 1}] ${n.novel_name}（已改编${epCount}集 -> 下一集: 第${nextEp}集，从第${nextChapter}章）`);
  }
  console.log(`  [${novels.length + 1}] 新建小说`);
  console.log();

  const choice = await ask(rl, "  请选择: ");
  const choiceNum = parseInt(choice, 10);

  // 选择已有小说
  if (choiceNum >= 1 && choiceNum <= novels.length) {
    const novel = novels[choiceNum - 1];
    const episode = (novel.adapted?.length ?? 0) + 1;
    const nextChapter = novel.next_chapter ?? 1;
    const sourcePath = novel.source_path ?? "";

    // 检查 source_path 是否有效
    if (sourcePath) {
      try {
        await fs.access(sourcePath);
      } catch {
        console.log(`\n  x 小说源目录不存在: ${sourcePath}`);
        const newPath = await ask(rl, "  请输入新的路径（或输入 q 返回）: ");
        if (newPath === "q" || newPath === "") return null;

        try {
          await fs.access(newPath);
        } catch {
          console.log("  x 路径无效，返回主菜单。\n");
          return null;
        }

        // 更新 source_path
        novel.source_path = newPath;
        const progressPath = novelPaths.progress(novel.novel_name);
        const full = JSON.parse(await fs.readFile(progressPath, "utf-8"));
        full.source_path = newPath;
        await fs.writeFile(progressPath, JSON.stringify(full, null, 4), "utf-8");
      }
    }

    console.log(`\n  ${novel.novel_name} — 第${episode}集（从第${nextChapter}章开始）`);
    const confirm = await ask(rl, "  确认开始？(Y/n): ");
    if (confirm.toLowerCase() === "n") return null;

    const ethnicity = await selectEthnicity(rl);
    const aspectRatio = await selectAspectRatio(rl);

    return {
      novelName: novel.novel_name,
      sourcePath: novel.source_path ?? "",
      episode,
      nextChapter,
      ethnicity,
      aspectRatio,
    };
  }

  // 新建小说
  if (choiceNum === novels.length + 1) {
    const folderPath = await ask(rl, "\n  请输入小说文件夹路径: ");
    if (!folderPath) return null;

    try {
      await fs.access(folderPath);
    } catch {
      console.log("  x 路径不存在，返回主菜单。\n");
      return null;
    }

    const chapterCount = await countChapters(folderPath);
    if (chapterCount === 0) {
      console.log("  x 未找到章节文件（需要「第N章*.txt」格式），返回主菜单。\n");
      return null;
    }

    console.log(`\n  扫描到 ${chapterCount} 个章节文件`);

    const defaultName = path.basename(folderPath);
    const nameInput = await ask(rl, `  请输入小说名称（回车 = ${defaultName}）: `);
    const novelName = nameInput || defaultName;

    // 初始化 workspace 和进度文件
    const novelDir = novelPaths.workspaceDir(novelName);
    await fs.mkdir(novelDir, { recursive: true });

    const progress = {
      novel_name: novelName,
      source_path: folderPath,
      adapted: [],
      next_chapter: 1,
      global_summary: "",
      established_characters: [],
      established_locations: [],
      active_hooks: [],
    };
    await fs.writeFile(
      novelPaths.progress(novelName),
      JSON.stringify(progress, null, 4),
      "utf-8",
    );

    console.log(`\n  ${novelName} — 第1集（从第1章开始）`);
    const confirm = await ask(rl, "  确认开始？(Y/n): ");
    if (confirm.toLowerCase() === "n") return null;

    const ethnicity = await selectEthnicity(rl);
    const aspectRatio = await selectAspectRatio(rl);

    return {
      novelName,
      sourcePath: folderPath,
      episode: 1,
      nextChapter: 1,
      ethnicity,
      aspectRatio,
    };
  }

  console.log("  无效选择，返回主菜单。\n");
  return null;
}
