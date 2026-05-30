/**
 * 场景底图生成工具 — 调用 Gemini API 文生图
 *
 * 根据 base_prompt 生成无人的真实场景底图，
 * 并将 base_prompt 写入场景 JSON 文件。
 * 风格锁死为 "真人写实摄影风格，自然光，无人物"。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { novelPaths } from "../utils/paths.js";
import { generateImage } from "../utils/image-gen.js";

/** 风格锁定的场景 prompt 模板 */
function buildScenePrompt(locationName: string, basePrompt: string): string {
  return (
    `真人写实摄影风格，自然光，无人物。` +
    `${locationName}的全景远景镜头。` +
    `场景：${basePrompt}。` +
    `画面清晰，高分辨率，适合作为短剧分镜底图。` +
    `没有任何人物和水印。`
  );
}

export const generateSceneTool: ToolDefinition = {
  name: "generate_scene",
  label: "场景生成",
  description:
    "调用 Gemini API 文生图，生成无人的真实场景底图。" +
    "接受 base_prompt（固定环境描述）直接作为生图依据，" +
    "同时将 base_prompt 写入场景 JSON 文件。" +
    "底图已存在则跳过生图，只更新 JSON。",
  parameters: Type.Object({
    novel_name:    Type.String({ description: "小说名称" }),
    location_name: Type.String({ description: "地点名称，与场景 JSON 的 location 字段完全一致" }),
    base_prompt:   Type.String({ description: "固定环境描述：建筑结构、家具陈设、空间布局（无人物，无光线时间）" }),
    initial_stage: Type.String({ description: "初始软场景阶段名，如「入学第一天午后」" }),
    initial_soft:  Type.String({ description: "初始软场景描述：光线、时间、情节相关物件" }),
  }),
  execute: async (_toolCallId: string, params: any) => {
    const novelName    = String(params.novel_name);
    const locationName = String(params.location_name);
    const basePrompt   = String(params.base_prompt);
    const initialStage = String(params.initial_stage);
    const initialSoft  = String(params.initial_soft);

    const scenesDir  = novelPaths.scenesDir(novelName);
    const outputPath = novelPaths.sceneImage(novelName, locationName);
    const jsonPath   = novelPaths.sceneJson(novelName, locationName);

    await fs.mkdir(scenesDir, { recursive: true });

    // 写入或更新场景 JSON
    let sceneJson: any = {
      location:      locationName,
      base_image:    `${locationName}.png`,
      base_prompt:   basePrompt,
      current_stage: initialStage,
      soft_scenes:   { [initialStage]: initialSoft },
    };

    // 如果已有 JSON，合并而不是覆盖
    try {
      const existing = JSON.parse(await fs.readFile(jsonPath, "utf-8"));
      sceneJson = {
        ...existing,
        base_prompt: basePrompt,  // 更新 base_prompt
        soft_scenes: {
          ...existing.soft_scenes,
          [initialStage]: initialSoft,
        },
      };
    } catch { /* 不存在，用初始值 */ }

    await fs.writeFile(jsonPath, JSON.stringify(sceneJson, null, 2), "utf-8");

    // 底图已存在则跳过生图
    try {
      await fs.access(outputPath);
      return {
        content: [{ type: "text" as const, text:
          `场景底图已存在，跳过生图。JSON 已更新: ${jsonPath}`
        }],
        details: {},
      };
    } catch { /* 不存在，继续生成 */ }

    const prompt = buildScenePrompt(locationName, basePrompt);
    await generateImage(prompt, outputPath, [], "16:9");

    return {
      content: [{ type: "text" as const, text:
        `场景「${locationName}」底图已生成: ${outputPath}\nJSON 已写入: ${jsonPath}`
      }],
      details: {},
    };
  },
};
