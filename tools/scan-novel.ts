/**
 * ⓪-a 小说扫描工具 — 数据准备任务
 *
 * 扫描小说文件夹中的所有章节文件和改编进度，
 * 返回章节全文 + 改编规则 + 输出格式，由 Agent 自行决定改编范围并生成剧本。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { PROJECT_ROOT } from "../utils/run-python.js";
import { novelPaths } from "../utils/paths.js";

// ─── 改编原则（搬自 generate_script.py build_system_prompt）───

const ADAPTATION_PRINCIPLES = `## 改编原则

1. **忠于原著**：原著的核心冲突、高潮、关键反转、重要对话必须保留，不得为了压缩篇幅而删除。改编是重新组织叙事方式，不是删减内容。
2. **场景连贯**：场景之间必须有因果衔接，观众能理解"为什么到了下一个场景"。角色的空间转移需要通过台词、画外音或简短过渡画面交代。禁止无铺垫的场景跳转。
3. **每集必须有钩子**：结尾必须留悬念——未解之谜、新角色登场、反转、倒计时临近——逼迫观众看下一集。
4. **内心→视觉**：小说的心理活动转化为表情特写、动作细节、简短画外音（不超过20字）。
5. **强化微表情**：给关键角色加视觉细节（目光闪烁、搓手指、光线变化等），增强画面张力。
6. **台词口语化**：小说的书面语改为口语化的短句，每句台词不超过20字。
7. **每集 3~8 个场景**：节奏不能太快也不能太拖。
8. **文字信息处理**：场景中的短文字（几个字的标语、石碑等）可以在画面中描述；长文字（校规条目、手机屏幕上的段落等）必须通过角色朗读、对话或画外音传递，不要写成画面特写。`;

const OUTPUT_FORMAT_SPEC = `## 输出格式要求

必须严格按照以下 Markdown 格式输出：

\`\`\`
# {小说名} · 第X集：{集标题}

> **类型**：{类型}
> **时长**：约2-3分钟
> **核心悬念**：{本集要抛出/延续的钩子}
> **改编范围**：原著第X章 ~ 第Y章

---

## 场景一：{场景名} · {地点/氛围简述}

**【画面】** 视觉描述（镜头运动、光线、环境细节）

**角色名（情绪）：** 台词（不超过20字）

**【音效】** 音效描述

**角色名（画外音，情绪）：** 内心独白（简短）

**【特写·目标】** 特写镜头描述

**【黑屏】** / **【白字浮现】** 等特殊画面

---

## 改编说明

| 改编手法 | 具体操作 | 目的 |
|---------|---------|------|
| 手法名 | 做了什么 | 为什么这么做 |
\`\`\`

## 关键格式约束
- \`## 场景X：\` 用来标记场景边界
- \`**【画面】**\` 标记视觉描述
- \`**角色名（情绪）：**\` 标记对话
- \`**【特写·XXX】**\` 标记镜头提示
- 这些标记是下游智能体（剧本解析器）的解析锚点，不可更改格式`;

// ─── 工具函数 ───

interface Chapter {
  chapter_num: number;
  title: string;
  file: string;
  text: string;
  char_count: number;
}

async function findNovelFolder(novelName: string): Promise<string> {
  // 优先从改编进度中读取 source_path
  try {
    const progressContent = await fs.readFile(novelPaths.progress(novelName), "utf-8");
    const progress = JSON.parse(progressContent);
    if (progress.source_path) {
      const stat = await fs.stat(progress.source_path);
      if (stat.isDirectory()) return progress.source_path;
    }
  } catch { /* 进度文件不存在或 source_path 无效 */ }

  // 回退：在项目根目录下查找
  const exact = path.join(PROJECT_ROOT, novelName);
  try {
    const stat = await fs.stat(exact);
    if (stat.isDirectory()) return exact;
  } catch { /* not found */ }

  const entries = await fs.readdir(PROJECT_ROOT, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith(novelName)) {
      return path.join(PROJECT_ROOT, entry.name);
    }
  }

  throw new Error(`找不到小说文件夹：${novelName}（在 ${PROJECT_ROOT} 下）`);
}

async function scanChapters(folder: string): Promise<Chapter[]> {
  const entries = await fs.readdir(folder);
  const chapterRegex = /^第(\d+)章\s*(.*?)\.txt$/;

  const chapters: Chapter[] = [];
  for (const filename of entries) {
    const m = chapterRegex.exec(filename);
    if (!m) continue;

    const filePath = path.join(folder, filename);
    const text = await fs.readFile(filePath, "utf-8");
    chapters.push({
      chapter_num: parseInt(m[1], 10),
      title: m[2].trim(),
      file: filename,
      text,
      char_count: text.length,
    });
  }

  chapters.sort((a, b) => a.chapter_num - b.chapter_num);
  return chapters;
}

interface Progress {
  novel_name: string;
  adapted: Array<{
    episode: number;
    title: string;
    source_chapters: number[];
    output_file: string;
    status: string;
    scene_count: number;
    timestamp: string;
  }>;
  next_chapter: number;
  global_summary: string;
  established_characters: string[];
  established_locations: string[];
  active_hooks: string[];
}

async function loadProgress(novelName: string): Promise<Progress | null> {
  try {
    const content = await fs.readFile(novelPaths.progress(novelName), "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

// ─── 工具定义 ───

export const scanNovelTool: ToolDefinition = {
  name: "scan_novel",
  label: "小说扫描",
  description:
    "扫描小说文件夹，读取所有章节文件和改编进度。" +
    "返回章节列表（编号、标题、全文）和进度状态，" +
    "Agent 根据返回数据从专业编剧角度决定改编范围，自行生成剧本，" +
    "然后调用 save_script 保存。",
  parameters: Type.Object({
    novel_name: Type.String({ description: "小说名称（对应文件夹名），如 '规则怪谈'" }),
    reset: Type.Optional(Type.Boolean({ description: "是否清除进度从头开始" })),
  }),
  execute: async (_toolCallId: string, params: any) => {
    const novelName = String(params.novel_name);
    const reset = Boolean(params.reset);

    try {
      // 1. 查找文件夹
      const folder = await findNovelFolder(novelName);

      // 2. 扫描章节
      const chapters = await scanChapters(folder);
      if (chapters.length === 0) {
        return {
          content: [{ type: "text" as const, text: `在 ${folder} 中未找到章节文件（第*章*.txt）` }],
          details: {},
        };
      }

      // 3. 加载进度
      let progress = reset ? null : await loadProgress(novelName);

      // 4. 构建进度摘要
      let progressSection: string;
      if (progress && progress.adapted?.length > 0) {
        progressSection = [
          `已改编 ${progress.adapted.length} 集`,
          `下一章: 第${progress.next_chapter}章`,
          `剧情摘要: ${progress.global_summary || "无"}`,
          `已出场角色: ${(progress.established_characters ?? []).join("、") || "无"}`,
          `已有场景: ${(progress.established_locations ?? []).join("、") || "无"}`,
          `未解决悬念: ${(progress.active_hooks || []).join(" | ") || "无"}`,
          ``,
          `请确保本集延续或回应至少一个已有悬念，并在结尾制造新悬念。`,
        ].join("\n");
      } else {
        progressSection = "首次改编，暂无进度。从第1章开始。";
      }

      // 5. 构建章节列表（滑动窗口，避免超出上下文限制）
      const MAX_CHARS = 80000; // 字符预算（约 120K tokens，留空间给系统提示和输出）
      const episodeNum = (progress?.adapted?.length ?? 0) + 1;

      // 计算全文总字符数
      const totalChars = chapters.reduce((sum, c) => sum + c.char_count, 0);

      let reviewChapterNums: Set<number> = new Set();
      let nextChapter = 1;
      let windowNote = "";

      if (progress && progress.adapted?.length > 0) {
        nextChapter = progress.next_chapter;

        // 回顾区：取最后 2 集用到的章节
        const lastTwo = progress.adapted.slice(-2);
        for (const ep of lastTwo) {
          for (const ch of (ep.source_chapters ?? [])) {
            reviewChapterNums.add(ch);
          }
        }
      }

      let chapterList: string[];

      if (totalChars <= MAX_CHARS) {
        // 全文小于预算，全部读取（兼容短篇）
        chapterList = chapters.map(
          (c) =>
            `=== 第${c.chapter_num}章 ${c.title} (${c.char_count}字) ===\n\n${c.text}`,
        );
      } else {
        // 滑动窗口读取
        const reviewParts: string[] = [];
        const mainParts: string[] = [];
        let usedChars = 0;

        // 回顾区
        if (reviewChapterNums.size > 0) {
          const reviewChapters = chapters.filter((c) => reviewChapterNums.has(c.chapter_num));
          for (const c of reviewChapters) {
            if (usedChars + c.char_count > MAX_CHARS) break;
            reviewParts.push(
              `=== 第${c.chapter_num}章 ${c.title} (${c.char_count}字)【回顾】 ===\n\n${c.text}`,
            );
            usedChars += c.char_count;
          }
        }

        // 主读区：从 nextChapter 开始往后读
        const mainChapters = chapters.filter((c) => c.chapter_num >= nextChapter);
        let lastLoadedChapter = 0;
        for (const c of mainChapters) {
          if (usedChars + c.char_count > MAX_CHARS) break;
          mainParts.push(
            `=== 第${c.chapter_num}章 ${c.title} (${c.char_count}字) ===\n\n${c.text}`,
          );
          usedChars += c.char_count;
          lastLoadedChapter = c.chapter_num;
        }

        const totalMainChapters = chapters.filter((c) => c.chapter_num >= nextChapter).length;
        const loadedMainChapters = mainParts.length;

        if (loadedMainChapters < totalMainChapters) {
          windowNote = `\n注意：小说共 ${chapters.length} 章（${totalChars}字），因篇幅限制只加载了第${nextChapter}~${lastLoadedChapter}章。后续章节将在下一集扫描时加载。\n`;
        }

        chapterList = [];
        if (reviewParts.length > 0) {
          const lastTwo = progress!.adapted.slice(-2);
          const epNums = lastTwo.map((ep) => `第${ep.episode}集`).join("、");
          chapterList.push(
            `== 回顾章节（最近 2 集（${epNums}）已改编，仅供参考剧情衔接，不要重复改编） ==`,
            ...reviewParts,
            ``,
          );
        }
        chapterList.push(
          `== 待改编章节 ==`,
          ...mainParts,
        );
      }

      // 6. 拼接返回
      const result = [
        `小说《${novelName}》扫描完成。`,
        `文件夹: ${folder}`,
        `共 ${chapters.length} 个章节。`,
        windowNote,
        `== 改编进度 ==`,
        progressSection,
        ``,
        `== 章节列表 ==`,
        ...chapterList,
        ``,
        ADAPTATION_PRINCIPLES,
        ``,
        OUTPUT_FORMAT_SPEC,
        ``,
        `== 你的任务 ==`,
        `当前应生成第${episodeNum}集。`,
        ``,
        `1. 根据章节内容，从专业编剧角度决定哪些章节合并为一集。`,
        `   考虑：叙事节奏、场景切换节点、悬念钩子位置、情绪弧线完整性。`,
        `   不要简单按字数合并。找到最适合作为一集结尾的位置（悬念点、反转、情绪高潮）。`,
        `2. 按照上述格式生成短剧剧本`,
        `3. 生成完毕后调用 save_script 工具保存，参数：`,
        `   - novel_name: "${novelName}"`,
        `   - episode_num: ${episodeNum}`,
        `   - source_chapters: 你选择的章节号数组（如 [1] 或 [1, 2]）`,
        `   - script_content: 完整的剧本 Markdown 文本`,
      ].join("\n");

      return { content: [{ type: "text" as const, text: result }], details: {} };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `小说扫描失败: ${err}` }], details: {} };
    }
  },
};
