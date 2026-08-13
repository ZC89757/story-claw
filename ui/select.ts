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
  imagesOnly: boolean;  // 只生分镜图，跳过生视频/TTS/合并（ComfyUI 未就绪时先出图）
  articleType: "essay" | "story";
  /** 画面预设生成后是否进入桌面端人工审阅检查点。 */
  reviewVisualPreset?: boolean;
  /** 项目配置确认后是否需要用户再确认一次才启动流水线。 */
  requireFinalConfirmation?: boolean;
}

export type RunScope = "solo" | "all";

type RenderMode = "full" | "images_only";

interface Progress {
  novel_name: string;
  source_path?: string;
  ethnicity?: string;
  article_type?: "essay" | "story";
  aspect_ratio?: "9:16" | "16:9";
  render_mode?: RenderMode;
  adapted: Array<{ episode: number }>;
  next_chapter: number;
  episodes?: Record<string, { stages?: Record<string, string> }>;
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

/** 交互选择是否只生分镜图（跳过生视频） */
async function selectImagesOnly(rl: readline.Interface): Promise<boolean> {
  console.log("\n  渲染模式：");
  console.log("  [1] 完整渲染（生图 + 生视频 + TTS + 合并，默认）");
  console.log("  [2] 只生分镜图（跳过生视频，ComfyUI 未就绪时先出图，之后重跑补视频）");
  console.log();
  const choice = await ask(rl, "  请选择（回车 = 完整渲染）: ");
  return choice === "2";
}

/** 交互选择文章类型（仅新建小说时调用一次，之后沿用进度里的值） */
async function selectArticleType(rl: readline.Interface): Promise<"essay" | "story"> {
  console.log("\n  文章类型：");
  console.log("  [1] 叙事小说（有人物/场景/对话/情节，走完整故事工作流，默认）");
  console.log("  [2] 议论文/科普文（无人物对话，概念画面+口播，跳过画面预设/资源建档/BGM）");
  console.log();
  const choice = await ask(rl, "  请选择（回车 = 叙事小说）: ");
  return choice === "2" ? "essay" : "story";
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

function renderModeLabel(mode: RenderMode): string {
  return mode === "images_only" ? "只生分镜图" : "完整渲染";
}

function printProjectDefaults(progress: Progress): void {
  const articleType = progress.article_type === "essay" ? "议论文" : "叙事小说";
  console.log(`  人物人种、文章类型、画幅、渲染模式沿用该项目的默认配置（配置详情：${progress.ethnicity} / ${articleType} / ${progress.aspect_ratio} / ${renderModeLabel(progress.render_mode!)}），可在项目的改编进度中查看细节。\n`);
}

function hasProjectDefaults(progress: Progress): boolean {
  return Boolean(
    typeof progress.ethnicity === "string"
    && (progress.article_type === "essay" || progress.article_type === "story")
    && (progress.aspect_ratio === "9:16" || progress.aspect_ratio === "16:9")
    && (progress.render_mode === "full" || progress.render_mode === "images_only")
  );
}

/** 选择小说并确认，返回 NovelSelection 或 null（用户取消） */
export async function selectNovel(rl: readline.Interface, scope: RunScope = "solo"): Promise<NovelSelection | null> {
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

    if (!hasProjectDefaults(novel)) {
      console.log(`\n  x 项目「${novel.novel_name}」缺少默认配置。`);
      console.log("  请先在改编进度.json 中补充 ethnicity、article_type、aspect_ratio、render_mode。\n");
      return null;
    }

    console.log(`\n  ${novel.novel_name} — 第${episode}集（从第${nextChapter}章开始）`);
    if (scope === "all") {
      console.log("  将连续改编该项目的全部剩余章节。");
    }
    const confirm = await ask(rl, "  确认开始？(Y/n): ");
    if (confirm.toLowerCase() === "n") return null;

    printProjectDefaults(novel);

    return {
      novelName: novel.novel_name,
      sourcePath: novel.source_path ?? "",
      episode,
      nextChapter,
      ethnicity: novel.ethnicity!,
      aspectRatio: novel.aspect_ratio!,
      imagesOnly: novel.render_mode === "images_only",
      articleType: novel.article_type!,
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

    const ethnicity = await selectEthnicity(rl);
    const articleType = await selectArticleType(rl);
    const aspectRatio = await selectAspectRatio(rl);
    const imagesOnly = await selectImagesOnly(rl);
    const renderMode: RenderMode = imagesOnly ? "images_only" : "full";
    if (scope === "all" && imagesOnly) {
      console.log("\n  x /all 不支持‘只生分镜图’模式，请选择完整渲染。\n");
      return null;
    }

    console.log(`\n  ${novelName} — 第1集（从第1章开始）`);
    if (scope === "all") {
      console.log("  将连续改编该项目的全部章节。");
    }
    console.log(`  配置详情：${ethnicity} / ${articleType === "essay" ? "议论文" : "叙事小说"} / ${aspectRatio} / ${renderModeLabel(renderMode)}`);
    const confirm = await ask(rl, "  确认开始？(Y/n): ");
    if (confirm.toLowerCase() === "n") return null;

    // 初始化 workspace 和进度文件，运行属性作为项目默认配置持久化
    const novelDir = novelPaths.workspaceDir(novelName);
    await fs.mkdir(novelDir, { recursive: true });

    const progress = {
      novel_name: novelName,
      source_path: folderPath,
      ethnicity,
      article_type: articleType,
      aspect_ratio: aspectRatio,
      render_mode: renderMode,
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

    return {
      novelName,
      sourcePath: folderPath,
      episode: 1,
      nextChapter: 1,
      ethnicity,
      aspectRatio,
      imagesOnly,
      articleType,
    };
  }

  console.log("  无效选择，返回主菜单。\n");
  return null;
}
