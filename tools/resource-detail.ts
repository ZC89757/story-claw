/**
 * 资源详情工具
 *
 * 读取指定角色或场景的详细 JSON 内容，
 * 供 LLM 判断是否需要新增造型阶段或软场景。
 */

import fs from "node:fs/promises";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { novelPaths } from "../utils/paths.js";

export const resourceDetailTool: ToolDefinition = {
  name: "resource_detail",
  label: "资源详情",
  description:
    "读取指定角色或场景的详细 JSON 内容。" +
    "用于对比原文描述与现有记录，判断是否需要新增造型阶段（角色）或软场景条目（场景）。",
  parameters: Type.Object({
    novel_name: Type.String({ description: "小说名称" }),
    type: Type.Union([Type.Literal("character"), Type.Literal("scene")], {
      description: "资源类型：character=角色，scene=场景",
    }),
    name: Type.String({ description: "资源名称，与 list_resources 返回的名称完全一致" }),
  }),
  execute: async (_toolCallId: string, params: any) => {
    const novelName = String(params.novel_name);
    const type      = String(params.type) as "character" | "scene";
    const name      = String(params.name);

    const jsonPath = type === "character"
      ? novelPaths.characterJson(novelName, name)
      : novelPaths.sceneJson(novelName, name);

    try {
      const content = await fs.readFile(jsonPath, "utf-8");
      return {
        content: [{ type: "text" as const, text: `[${name}] ${type} JSON:\n${content}` }],
        details: {},
      };
    } catch {
      return {
        content: [{ type: "text" as const, text: `[${name}] JSON 文件不存在: ${jsonPath}` }],
        details: {},
      };
    }
  },
};
