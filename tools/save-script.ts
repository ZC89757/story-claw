/**
 * ⓪-b 剧本保存工具 — 持久化任务
 *
 * 保存 Agent 生成的短剧剧本 .md 文件，
 * 自动提取元数据并更新 改编进度.json。
 */

import fs from "node:fs/promises";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { novelPaths } from "../utils/paths.js";

// ─── 元数据提取 ───

interface EpisodeMeta {
  title: string;
  sceneCount: number;
  hooks: string[];
}

function extractEpisodeMetadata(scriptText: string, fallbackTitle: string): EpisodeMeta {
  // 提取标题
  const titleMatch = scriptText.match(/#\s*.+?·\s*第\d+集[：:]\s*(.+)/);
  const title = titleMatch ? titleMatch[1].trim() : fallbackTitle;

  // 提取核心悬念
  const hooks: string[] = [];
  const hookMatch = scriptText.match(/\*\*核心悬念\*\*[：:]\s*(.+)/);
  if (hookMatch) {
    hooks.push(hookMatch[1].trim());
  }

  // 提取场景数量
  const scenes = scriptText.match(/##\s*场景[一二三四五六七八九十\d]+/g);
  const sceneCount = scenes ? scenes.length : 0;

  return { title, sceneCount, hooks };
}

// ─── 进度管理 ───

interface Progress {
  novel_name: string;
  source_path?: string;
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

async function loadOrInitProgress(novelName: string): Promise<Progress> {
  const progressPath = novelPaths.progress(novelName);
  try {
    const content = await fs.readFile(progressPath, "utf-8");
    return JSON.parse(content);
  } catch {
    return {
      novel_name: novelName,
      adapted: [],
      next_chapter: 1,
      global_summary: "",
      established_characters: [],
      established_locations: [],
      active_hooks: [],
    };
  }
}

// ─── 工具定义 ───

export const saveScriptTool: ToolDefinition = {
  name: "save_script",
  label: "剧本保存",
  description:
    "保存生成的短剧剧本 .md 文件并更新改编进度。" +
    "Agent 生成剧本文本后调用此工具持久化。" +
    "自动提取标题、场景数、角色、悬念等元数据，更新 改编进度.json。",
  parameters: Type.Object({
    novel_name: Type.String({ description: "小说名称" }),
    episode_num: Type.Number({ description: "集数编号" }),
    source_chapters: Type.String({ description: "改编的章节号列表，JSON 数组格式如 [1, 2, 3]" }),
    script_content: Type.String({ description: "完整的剧本 Markdown 文本" }),
    summary: Type.Optional(Type.String({ description: "本集剧情摘要（用于更新全局摘要，可选）" })),
    hooks: Type.Optional(Type.String({ description: "本集末尾悬念列表，JSON 数组格式（可选）" })),
  }),
  execute: async (_toolCallId: string, params: any) => {
    const novelName = String(params.novel_name);
    const episodeNum = Number(params.episode_num);
    const scriptContent = String(params.script_content);

    let chapters: number[];
    try {
      chapters = JSON.parse(String(params.source_chapters));
    } catch {
      return { content: [{ type: "text" as const, text: `source_chapters 格式错误，需要 JSON 数组如 [1, 2]` }], details: {} };
    }

    try {
      // 1. 确保集目录存在
      const epDir = novelPaths.episodeDir(novelName, episodeNum);
      await fs.mkdir(epDir, { recursive: true });

      // 2. 确定输出路径并写入 .md 文件
      const outputPath = novelPaths.script(novelName, episodeNum);
      await fs.writeFile(outputPath, scriptContent, "utf-8");

      // 3. 提取元数据
      const meta = extractEpisodeMetadata(
        scriptContent,
        `第${episodeNum}集`,
      );

      // 4. 确保 workspace 根目录存在，加载进度
      await fs.mkdir(novelPaths.workspaceDir(novelName), { recursive: true });
      const progress = await loadOrInitProgress(novelName);

      progress.adapted.push({
        episode: episodeNum,
        title: meta.title,
        source_chapters: chapters,
        output_file: outputPath,
        status: "done",
        scene_count: meta.sceneCount,
        timestamp: new Date().toISOString().replace(/\.\d+Z$/, ""),
      });

      progress.next_chapter = chapters[chapters.length - 1] + 1;

      // 更新全局摘要
      const newPart = params.summary
        ? String(params.summary)
        : `第${episodeNum}集(${chapters.map((n) => `第${n}章`).join(",")}): ${meta.title}`;
      progress.global_summary = progress.global_summary
        ? `${progress.global_summary}; ${newPart}`
        : newPart;

      // 更新悬念
      if (params.hooks) {
        try {
          progress.active_hooks = JSON.parse(String(params.hooks));
        } catch {
          progress.active_hooks = meta.hooks;
        }
      } else {
        progress.active_hooks = meta.hooks;
      }

      // 5. 写回进度文件
      await fs.writeFile(
        novelPaths.progress(novelName),
        JSON.stringify(progress, null, 4),
        "utf-8",
      );

      // 6. 返回确认
      return {
        content: [{ type: "text" as const, text: [
          `剧本已保存: ${outputPath}`,
          `集数: 第${episodeNum}集《${meta.title}》`,
          `改编范围: ${chapters.map((n) => `第${n}章`).join(", ")}`,
          `场景数: ${meta.sceneCount}`,
          `悬念钩子: ${meta.hooks.join("; ") || "无"}`,
          `进度已更新: 下次从第${progress.next_chapter}章开始`,
        ].join("\n") }],
        details: {},
      };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `剧本保存失败: ${err}` }], details: {} };
    }
  },
};
