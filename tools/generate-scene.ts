/**
 * 场景底图生成工具 — 调用 Gemini API 文生图
 *
 * 根据地点描述生成无人的真实场景底图。
 * 风格锁死为 "真人写实摄影风格，自然光，无人物"。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { PROJECT_ROOT } from "../utils/run-python.js";
import { novelPaths } from "../utils/paths.js";
import { generateImage } from "../utils/image-gen.js";

/** 风格锁定的场景 prompt 模板 */
function buildScenePrompt(locationName: string, description: string): string {
  return (
    `真人写实摄影风格，自然光，无人物。` +
    `${locationName}的全景远景镜头。` +
    `场景：${description}。` +
    `画面清晰，高分辨率，适合作为短剧分镜底图。` +
    `没有任何人物和水印。`
  );
}

export const generateSceneTool: ToolDefinition = {
  name: "generate_scene",
  label: "场景生成",
  description:
    "调用 Gemini API 文生图，生成无人的真实场景底图。" +
    "自动从 scene_data.json 中读取对应 location 的 scene_spatial 作为场景描述。" +
    "风格锁死为 '真人写实摄影风格，无人物'。输出底图路径。",
  parameters: Type.Object({
    novel_name:    Type.String({ description: "小说名称（对应 workspace 下的文件夹名）" }),
    location_name: Type.String({ description: "地点名称，必须与 scene_data.json 中的 location 完全一致" }),
    scene_json:    Type.String({ description: "scene_data.json 文件路径" }),
  }),
  execute: async (_toolCallId: string, params: any) => {
    const novelName = String(params.novel_name);
    const locationName = String(params.location_name);
    const sceneJsonRaw = String(params.scene_json);
    const sceneJsonPath = path.isAbsolute(sceneJsonRaw) ? sceneJsonRaw : path.join(PROJECT_ROOT, sceneJsonRaw);

    const outputPath = novelPaths.sceneImage(novelName, locationName);

    // 从 scene_data.json 中提取对应 location 的 scene_spatial
    let description: string;
    try {
      const sceneData = JSON.parse(await fs.readFile(sceneJsonPath, "utf-8"));
      const scene = sceneData.scenes?.find((s: any) => s.location === locationName);
      if (!scene) {
        return { content: [{ type: "text" as const, text: `scene_data.json 中找不到 location="${locationName}"` }], details: {} };
      }
      const { left_side, right_side, center_back, foreground } = scene.scene_spatial ?? {};
      description = [left_side, right_side, center_back, foreground].filter(Boolean).join("，");
    } catch (err) {
      return { content: [{ type: "text" as const, text: `读取 scene_data.json 失败: ${err}` }], details: {} };
    }

    const prompt = buildScenePrompt(locationName, description);

    await generateImage(prompt, outputPath);

    return {
      content: [{ type: "text" as const, text: `场景 ${locationName} 底图已生成: ${outputPath}` }],
      details: {},
    };
  },
};
