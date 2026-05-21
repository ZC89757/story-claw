/**
 * 资源列表工具
 *
 * 列出小说工作空间中已有的角色和场景 JSON 名称，
 * 同时返回 JSON 存储目录路径，供 LLM 写入新 JSON 时使用。
 */

import fs from "node:fs/promises";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { novelPaths } from "../utils/paths.js";

export const listResourcesTool: ToolDefinition = {
  name: "list_resources",
  label: "资源列表",
  description:
    "列出小说工作空间中已有的角色和场景资源名称（JSON 文件名），" +
    "同时返回角色和场景的 JSON 存储目录路径，供后续写入新 JSON 时使用。",
  parameters: Type.Object({
    novel_name: Type.String({ description: "小说名称" }),
  }),
  execute: async (_toolCallId: string, params: any) => {
    const novelName = String(params.novel_name);
    const charsDir  = novelPaths.charactersDir(novelName);
    const scenesDir = novelPaths.scenesDir(novelName);

    let charNames: string[]  = [];
    let sceneNames: string[] = [];

    try {
      const files = await fs.readdir(charsDir);
      charNames = files.filter(f => f.endsWith(".json")).map(f => f.replace(/\.json$/, ""));
    } catch { /* 目录不存在，首次运行 */ }

    try {
      const files = await fs.readdir(scenesDir);
      sceneNames = files.filter(f => f.endsWith(".json")).map(f => f.replace(/\.json$/, ""));
    } catch { /* 目录不存在，首次运行 */ }

    return {
      content: [{ type: "text" as const, text:
        `角色 JSON 目录: ${charsDir}\n` +
        `场景 JSON 目录: ${scenesDir}\n` +
        `已有角色（${charNames.length}个）: ${JSON.stringify(charNames)}\n` +
        `已有场景（${sceneNames.length}个）: ${JSON.stringify(sceneNames)}`,
      }],
      details: {},
    };
  },
};
