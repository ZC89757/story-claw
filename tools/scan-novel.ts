/**
 * ⓪-a 小说扫描工具 — 数据准备任务
 *
 * 扫描小说文件夹，返回待改编章节的原文和改编进度。
 * 不包含改编原则或输出格式，这些由 analyze_resources 工具负责。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { PROJECT_ROOT } from "../utils/run-python.js";
import { novelPaths } from "../utils/paths.js";

// ─── 工具函数 ───

interface Chapter {
  chapter_num: number;
  title: string;
  file: string;
  filePath: string;
  text: string;
  char_count: number;
}

async function findNovelFolder(novelName: string): Promise<string> {
  try {
    const progressContent = await fs.readFile(novelPaths.progress(novelName), "utf-8");
    const progress = JSON.parse(progressContent);
    if (progress.source_path) {
      const stat = await fs.stat(progress.source_path);
      if (stat.isDirectory()) return progress.source_path;
    }
  } catch { /* 进度文件不存在或 source_path 无效 */ }

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
      filePath,
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
    "扫描小说文件夹，读取待改编章节的完整原文和改编进度。" +
    "返回章节原文列表和各章节文件的绝对路径，供 analyze_resources 工具使用。",
  parameters: Type.Object({
    novel_name: Type.String({ description: "小说名称（对应文件夹名）" }),
    reset: Type.Optional(Type.Boolean({ description: "是否清除进度从头开始" })),
  }),
  execute: async (_toolCallId: string, params: any) => {
    const novelName = String(params.novel_name);
    const reset = Boolean(params.reset);

    try {
      const folder = await findNovelFolder(novelName);
      const chapters = await scanChapters(folder);

      if (chapters.length === 0) {
        return {
          content: [{ type: "text" as const, text: `在 ${folder} 中未找到章节文件（第*章*.txt）` }],
          details: {},
        };
      }

      let progress = reset ? null : await loadProgress(novelName);
      const episodeNum = (progress?.adapted?.length ?? 0) + 1;
      const nextChapter = progress?.next_chapter ?? 1;

      // 进度摘要
      let progressSection: string;
      if (progress && progress.adapted?.length > 0) {
        progressSection = [
          `已改编 ${progress.adapted.length} 集`,
          `下一章: 第${nextChapter}章`,
        ].join("\n");
      } else {
        progressSection = "首次改编，从第1章开始。";
      }

      const chapter = chapters.find(c => c.chapter_num === nextChapter);
      const chapterList: string[] = [];

      if (chapter) {
        chapterList.push(`=== 第${chapter.chapter_num}章 ${chapter.title} ===\n\n${chapter.text}`);
      }

      const result = [
        `== 改编进度 ==`,
        progressSection,
        ``,
        `== 章节原文 ==`,
        ...chapterList,
      ].join("\n");

      return { content: [{ type: "text" as const, text: result }], details: {} };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `小说扫描失败: ${err}` }], details: {} };
    }
  },
};
