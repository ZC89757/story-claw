/**
 * ③ 角色生成工具 — 调用 Gemini API 文生图
 *
 * 根据角色描述生成真人写实风格参考图。
 * Prompt 模板锁死为 "真人写实摄影风格，自然光"。
 */

import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { novelPaths } from "../utils/paths.js";
import { generateImage } from "../utils/image-gen.js";

/** 风格锁定的 prompt 模板 */
function buildCharacterPrompt(name: string, ageDesc: string, clothing: string): string {
  return (
    `请生成一个角色设计参考图，白色纯净背景。` +
    `必须是真人写实摄影风格，像真实照片一样。` +
    `禁止：卡通、漫画、简笔画、动漫、手绘、插画风格。` +
    `人物特征：${ageDesc}，${clothing}。` +
    `表情：自然正面。` +
    `画面包含：正面全身、侧面全身、背面全身三个视角，以及一个正面脸部特写。` +
    `风格：真人实拍写实，高清，自然光影。`
  );
}

export const generateCharacterTool: ToolDefinition = {
  name: "generate_character",
  label: "角色生成",
  description:
    "调用 Gemini API 文生图，根据角色卡生成真人写实风格的角色参考图。" +
    "Prompt 模板已锁死为 '真人写实摄影风格，自然光'，禁止风格漂移。" +
    "输入小说名、角色名、年龄描述、服装描述，输出参考图路径。",
  parameters: Type.Object({
    novel_name: Type.String({ description: "小说名称（对应 workspace 下的文件夹名）" }),
    name: Type.String({ description: "角色名，如 '魏俊熙'" }),
    age_desc: Type.String({ description: "年龄描述，如 '18岁少年，身材偏瘦'" }),
    clothing: Type.String({ description: "服装描述，如 '蓝色T恤、牛仔裤、双肩背包'" }),
  }),
  execute: async (_toolCallId: string, params: any) => {
    const novelName = String(params.novel_name);
    const name = String(params.name);
    const ageDesc = String(params.age_desc);
    const clothing = String(params.clothing);
    const outputPath = novelPaths.characterImage(novelName, name);

    const prompt = buildCharacterPrompt(name, ageDesc, clothing);

    await generateImage(prompt, outputPath);

    return {
      content: [{ type: "text" as const, text: `角色 ${name} 参考图已生成: ${outputPath}` }],
      details: {},
    };
  },
};
