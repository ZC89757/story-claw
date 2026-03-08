/**
 * ① 剧本解析工具 — LLM 推理任务
 *
 * 将短剧剧本 .md 解析为结构化场景 JSON。
 * 这个工具不调用 Python，而是读取文件内容后返回给 Agent，
 * 由 Agent（LLM）自身完成结构化解析。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { PROJECT_ROOT } from "../utils/run-python.js";
import { OUTPUT_SCHEMAS } from "./schemas.js";

export const parseScriptTool: ToolDefinition = {
  name: "parse_script",
  label: "剧本解析",
  description:
    "读取短剧剧本 .md 文件内容，提取场景结构供后续解析。" +
    "Agent 应根据返回的剧本文本，自行解析出结构化的场景 JSON " +
    "(scenes/beats/characters/emotions/shot_hints)，" +
    "然后将 JSON 写入文件供下游使用。",
  parameters: Type.Object({
    script_file: Type.String({ description: ".md 剧本文件路径（绝对或相对于项目根目录）" }),
  }),
  execute: async (_toolCallId: string, params: any) => {
    const rawPath = String(params.script_file);
    const filePath = path.isAbsolute(rawPath) ? rawPath : path.join(PROJECT_ROOT, rawPath);

    // 剧本位于 ep 目录内，scene_data.json 存放在同级目录
    const sceneDataPath = path.join(path.dirname(filePath), "scene_data.json");

    // 扫描已有场景底图，供 LLM 复用（场景图位于小说 workspace 的 scenes/ 目录）
    const novelDir = path.dirname(path.dirname(filePath));  // ep目录的上一级
    const scenesDir = path.join(novelDir, "scenes");
    let existingScenes: string[] = [];
    try {
      const files = await fs.readdir(scenesDir);
      existingScenes = files.filter(f => f.endsWith(".png")).map(f => f.replace(/\.png$/, ""));
    } catch {
      // 目录尚不存在，忽略
    }
    const existingScenesText = existingScenes.length > 0
      ? `\n已存在的场景底图（locations 约束中"已有底图"指这些）：\n${existingScenes.map(s => `- ${s}`).join("\n")}\n`
      : "";

    // 扫描已有角色参考图，供 LLM 复用（角色图位于小说 workspace 的 characters/ 目录）
    const charsDir = path.join(novelDir, "characters");
    let existingChars: string[] = [];
    try {
      const files = await fs.readdir(charsDir);
      existingChars = files.filter(f => f.endsWith(".png")).map(f => f.replace(/\.png$/, ""));
    } catch {
      // 目录尚不存在，忽略
    }
    const existingCharsText = existingChars.length > 0
      ? `\n已存在的角色参考图（若剧本中的角色与以下名称指同一人，必须使用已有名称，不得新建）：\n${existingChars.map(s => `- ${s}`).join("\n")}\n`
      : "";

    try {
      const content = await fs.readFile(filePath, "utf-8");
      return {
        content: [{ type: "text" as const, text:
          `剧本文件已读取（${content.length} 字符）。` +
          existingCharsText +
          existingScenesText + "\n" +
          `请解析以下剧本内容，提取结构化 JSON，\n` +
          `然后用内置 write 工具将结果保存到：${sceneDataPath}\n\n` +
          OUTPUT_SCHEMAS["parse_script"] + "\n\n" +
          `剧本内容：\n` +
          content
        }],
        details: {},
      };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `读取剧本文件失败: ${err}` }], details: {} };
    }
  },
};
