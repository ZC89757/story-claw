/**
 * ② 剧本切分工具 — LLM 推理任务
 *
 * 读取章节原文 + 已分析完成的场景 JSON 列表，
 * 由 Agent（LLM）按场景将原文切分为 ## 场景X 格式，
 * 原文逐字保留，不改写。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { PROJECT_ROOT } from "../utils/run-python.js";
import { novelPaths } from "../utils/paths.js";
import { OUTPUT_SCHEMAS } from "./schemas.js";

export const parseScriptTool: ToolDefinition = {
  name: "parse_script",
  label: "剧本切分",
  description:
    "读取章节原文和已分析的场景 JSON，由 Agent 将原文按场景切分，" +
    "输出 ## 场景X 格式的剧本文件。原文逐字保留，不改写。",
  parameters: Type.Object({
    novel_name:    Type.String({ description: "小说名称" }),
    episode_num:   Type.Number({ description: "集数编号" }),
    chapter_files: Type.String({ description: "章节文件路径列表，JSON 数组" }),
    scene_names:   Type.String({ description: "本集涉及的场景名列表，JSON 数组，需与场景 JSON 的 location 字段完全一致" }),
  }),
  execute: async (_toolCallId: string, params: any) => {
    const novelName  = String(params.novel_name);
    const episodeNum = Number(params.episode_num);

    let chapterPaths: string[];
    let sceneNames: string[];
    try {
      chapterPaths = JSON.parse(String(params.chapter_files));
      sceneNames   = JSON.parse(String(params.scene_names));
    } catch {
      return { content: [{ type: "text" as const, text: `chapter_files 或 scene_names 格式错误，需要 JSON 数组` }], details: {} };
    }

    // 读取章节原文
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

    // 读取各场景 JSON
    const sceneJsonTexts: string[] = [];
    for (const name of sceneNames) {
      const jsonPath = novelPaths.sceneJson(novelName, name);
      try {
        const content = await fs.readFile(jsonPath, "utf-8");
        sceneJsonTexts.push(`[${name}]\n${content}`);
      } catch {
        sceneJsonTexts.push(`[${name}] （JSON 文件不存在）`);
      }
    }

    const outputPath = novelPaths.script(novelName, episodeNum);
    const epDir      = novelPaths.episodeDir(novelName, episodeNum);

    return {
      content: [{ type: "text" as const, text:
        `章节原文和场景信息已读取，请完成切分任务。\n\n` +

        `== 场景列表 ==\n${sceneJsonTexts.join("\n\n")}\n\n` +

        `== 章节原文 ==\n${chapterTexts.join("\n\n")}\n\n` +

        `== 你的任务 ==\n` +
        `根据以上场景列表，将章节原文切分为对应的场景段落。\n` +
        `切分规则：\n` +
        `- 每个场景以 ## 场景X：{场景名} · {时间/地点} 开头\n` +
        `- 场景名必须与场景 JSON 的 location 字段完全一致\n` +
        `- 时间/地点 补充该场景在原文中对应的时间和具体地点描述\n` +
        `- 原文段落逐字保留，不得改写、删减或添加任何内容\n` +
        `- 若原文某段同时涉及多个场景，按叙事逻辑拆分到对应场景下\n\n` +
        `完成后用内置 write 工具将结果保存到：${outputPath}\n` +
        `（若目录不存在请先创建：${epDir}）\n` +
        `保存完毕后在最终回复末行写明：\n` +
        `剧本文件路径: ${outputPath}\n\n` +
        OUTPUT_SCHEMAS["segment_script"]
      }],
      details: {},
    };
  },
};
