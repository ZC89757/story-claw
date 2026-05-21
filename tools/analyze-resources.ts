/**
 * ① 资源分析工具 — LLM 推理任务
 *
 * 第一步核心工具：
 *   1. 读取新章节原文
 *   2. LLM 识别涉及的角色和场景
 *   3. 针对性加载已有角色/场景 JSON
 *   4. 对比分析：新增 or 更新
 *   5. 写入/更新 JSON 文件，触发生图
 */

import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { PROJECT_ROOT } from "../utils/run-python.js";
import { novelPaths } from "../utils/paths.js";
import { OUTPUT_SCHEMAS } from "./schemas.js";

export const analyzeResourcesTool: ToolDefinition = {
  name: "analyze_resources",
  label: "资源分析",
  description:
    "读取章节原文，识别涉及的角色和场景，与已有 JSON 对比，" +
    "返回需要新增或更新的资源清单（角色 JSON、场景 JSON），" +
    "由 Agent 完成 JSON 写入后再调用生图工具。",
  parameters: Type.Object({
    novel_name: Type.String({ description: "小说名称" }),
    chapter_files: Type.String({ description: "要分析的章节文件路径列表，JSON 数组格式，如 [\"第1章.txt\", \"第2章.txt\"]" }),
  }),
  execute: async (_toolCallId: string, params: any) => {
    const novelName = String(params.novel_name);

    let chapterPaths: string[];
    try {
      chapterPaths = JSON.parse(String(params.chapter_files));
    } catch {
      return { content: [{ type: "text" as const, text: `chapter_files 格式错误，需要 JSON 数组` }], details: {} };
    }

    // 1. 读取章节内容
    const chapterTexts: string[] = [];
    for (const p of chapterPaths) {
      const absPath = path.isAbsolute(p) ? p : path.join(PROJECT_ROOT, p);
      try {
        const text = await fs.readFile(absPath, "utf-8");
        chapterTexts.push(`=== ${path.basename(absPath)} ===\n\n${text}`);
      } catch (err) {
        return { content: [{ type: "text" as const, text: `读取章节失败: ${absPath}\n${err}` }], details: {} };
      }
    }
    const chapterContent = chapterTexts.join("\n\n");

    // 2. 扫描已有角色和场景目录
    const charsDir = novelPaths.charactersDir(novelName);
    const scenesDir = novelPaths.scenesDir(novelName);

    let existingCharNames: string[] = [];
    let existingLocationNames: string[] = [];

    try {
      const files = await fs.readdir(charsDir);
      existingCharNames = files
        .filter(f => f.endsWith(".json"))
        .map(f => f.replace(/\.json$/, ""));
    } catch { /* 目录不存在，首次运行 */ }

    try {
      const files = await fs.readdir(scenesDir);
      existingLocationNames = files
        .filter(f => f.endsWith(".json"))
        .map(f => f.replace(/\.json$/, ""));
    } catch { /* 目录不存在，首次运行 */ }

    // 3. 加载已有 JSON（只加载存在的）
    const existingCharsText: string[] = [];
    const existingScenesText: string[] = [];

    for (const name of existingCharNames) {
      try {
        const jsonPath = novelPaths.characterJson(novelName, name);
        const content = await fs.readFile(jsonPath, "utf-8");
        existingCharsText.push(`[${name}]\n${content}`);
      } catch { /* 读取失败跳过 */ }
    }

    for (const loc of existingLocationNames) {
      try {
        const jsonPath = novelPaths.sceneJson(novelName, loc);
        const content = await fs.readFile(jsonPath, "utf-8");
        existingScenesText.push(`[${loc}]\n${content}`);
      } catch { /* 读取失败跳过 */ }
    }

    const existingCharsSection = existingCharsText.length > 0
      ? `已有角色 JSON（${existingCharNames.join("、")}）：\n${existingCharsText.join("\n\n")}`
      : "暂无已有角色（首次运行）";

    const existingScenesSection = existingScenesText.length > 0
      ? `已有场景 JSON（${existingLocationNames.join("、")}）：\n${existingScenesText.join("\n\n")}`
      : "暂无已有场景（首次运行）";

    // 4. 构建给 LLM 的分析任务
    return {
      content: [{ type: "text" as const, text:
        `章节内容已读取，请完成以下分析任务。\n\n` +

        `== 章节原文 ==\n${chapterContent}\n\n` +

        `== ${existingCharsSection} ==\n\n` +

        `== ${existingScenesSection} ==\n\n` +

        `== 你的任务 ==\n` +
        `1. 从章节原文中识别出所有出现的角色和场景地点\n` +
        `2. 与已有 JSON 对比，判断每个角色/场景属于以下哪种情况：\n` +
        `   - 全新：原文中出现但 JSON 不存在 → 需要新建 JSON + 生图\n` +
        `   - 已有但需更新：造型/软场景发生变化 → 更新 JSON + 生图\n` +
        `   - 已有且无变化：跳过\n` +
        `3. 对于每个需要新建或更新的角色，用内置 write 工具将 JSON 保存到：\n` +
        `   ${charsDir}/{角色名}.json\n` +
        `4. 对于每个需要新建或更新的场景，用内置 write 工具将 JSON 保存到：\n` +
        `   ${scenesDir}/{场景名}.json\n` +
        `5. 完成后在最终回复末行逐行列出（格式固定）：\n` +
        `   新建角色: 角色名1,角色名2\n` +
        `   更新角色: 角色名3\n` +
        `   新建场景: 场景名1\n` +
        `   更新场景: 场景名2\n` +
        `   （若某类为空则写 无）\n\n` +

        OUTPUT_SCHEMAS["character_json"] + "\n\n" +
        OUTPUT_SCHEMAS["scene_json"]
      }],
      details: {},
    };
  },
};
