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
    let charPngs: string[]   = [];
    let scenePngs: string[]  = [];

    try {
      const files = await fs.readdir(charsDir);
      charNames = files.filter(f => f.endsWith(".json")).map(f => f.replace(/\.json$/, ""));
      charPngs  = files.filter(f => f.endsWith(".png"));
    } catch { /* 目录不存在，首次运行 */ }

    try {
      const files = await fs.readdir(scenesDir);
      sceneNames = files.filter(f => f.endsWith(".json")).map(f => f.replace(/\.json$/, ""));
      scenePngs  = files.filter(f => f.endsWith(".png"));
    } catch { /* 目录不存在，首次运行 */ }

    // 每个角色磁盘上现有的图片（含手动放入、未登记进 JSON 的参考图）
    const charImageList = charNames.map(name => {
      const prefix = `${name}_`;
      const suffixes = charPngs
        .filter(f => f.startsWith(prefix))
        .map(f => f.slice(prefix.length, -4));
      return `  ${name}: ${suffixes.length ? suffixes.join("、") : "（无图片）"}`;
    }).join("\n");

    // 每个场景磁盘上现有的图片：底图 {loc}.png + 用户手动放入的变体 {loc}_*.png
    const sceneImageList = sceneNames.map(loc => {
      const variants = scenePngs
        .filter(f => f === `${loc}.png` || f.startsWith(`${loc}_`))
        .map(f => f === `${loc}.png` ? "底图" : f.slice(loc.length + 1, -4));
      return `  ${loc}: ${variants.length ? variants.join("、") : "（无图片）"}`;
    }).join("\n");

    return {
      content: [{ type: "text" as const, text:
        `角色 JSON 目录: ${charsDir}\n` +
        `场景 JSON 目录: ${scenesDir}\n` +
        `已有角色（${charNames.length}个）: ${JSON.stringify(charNames)}\n` +
        `已有场景（${sceneNames.length}个）: ${JSON.stringify(sceneNames)}\n` +
        `角色现有图片（原型/造型/用户参考图）:\n${charImageList || "  （无）"}\n` +
        `场景现有图片（底图/用户参考图）:\n${sceneImageList || "  （无）"}`,
      }],
      details: {},
    };
  },
};
