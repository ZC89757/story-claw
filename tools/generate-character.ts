/**
 * 角色生成工具 — 调用图像 API 生成角色参考图
 *
 * 两种模式（由 stage 参数决定，约定大于配置）：
 *   无 stage → 文生图，生成原型图（{name}_原型.png）
 *   有 stage → 图生图，以原型图为参考生成造型图（{name}_{stage}.png）
 */

import fs from "node:fs/promises";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { novelPaths } from "../utils/paths.js";
import { generateImage } from "../utils/image-gen.js";

export const generateCharacterTool: ToolDefinition = {
  name: "generate_character",
  label: "角色生成",
  description:
    "生成角色参考图。" +
    "不传 stage：文生图，生成原型图（该时代便服下的基础体貌），每角色只需生成一次。" +
    "传入 stage：图生图，以原型图为参考生成造型图，prompt 只需描述本阶段服装/道具/特殊状态。",
  parameters: Type.Object({
    novel_name: Type.String({ description: "小说名称" }),
    name:       Type.String({ description: "角色名，用于文件命名" }),
    prompt:     Type.String({
      description:
        "生图提示词。" +
        "无 stage 时：描述角色基础体貌，包括年龄、身形、面部特征、发型等。" +
        "有 stage 时：只描述本阶段造型变化，如服装、随身道具、特殊身体状态，无需重复描述体貌。",
    }),
    ethnicity:  Type.String({ description: "人种描述，如「东亚面孔，亚裔」" }),
    stage:      Type.Optional(Type.String({
      description: "造型阶段名，有值时进入造型图模式（图生图），值用于文件命名，如「受伤阶段」",
    })),
  }),
  execute: async (_toolCallId: string, params: any) => {
    const novelName = String(params.novel_name);
    const name      = String(params.name);
    const prompt    = String(params.prompt);
    const ethnicity = String(params.ethnicity ?? "东亚面孔，亚裔");
    const stage     = params.stage ? String(params.stage) : undefined;

    const charsDir = novelPaths.charactersDir(novelName);
    await fs.mkdir(charsDir, { recursive: true });

    const protoPath = novelPaths.characterProtoImage(novelName, name);
    const jsonPath  = novelPaths.characterJson(novelName, name);

    /** 读取已有 JSON，不存在则返回初始结构 */
    async function loadJson(): Promise<{ name: string; base_prompt: string; stages: Array<{ stage: string; prompt: string }> }> {
      try {
        return JSON.parse(await fs.readFile(jsonPath, "utf-8"));
      } catch {
        return { name, base_prompt: "", stages: [] };
      }
    }

    if (!stage) {
      // ── 原型图模式（文生图）──────────────────────────────────
      try {
        await fs.access(protoPath);
        // 图已存在，但仍确保 JSON 里 base_prompt 有值
        const data = await loadJson();
        if (!data.base_prompt) {
          data.base_prompt = prompt;
          await fs.writeFile(jsonPath, JSON.stringify(data, null, 2), "utf-8");
        }
        return {
          content: [{ type: "text" as const, text: `原型图已存在，跳过生成: ${protoPath}` }],
          details: {},
        };
      } catch { /* 不存在，继续生成 */ }

      const fullPrompt =
        `真人写实摄影风格，白色纯净背景。` +
        `必须像真实照片，禁止卡通、漫画、动漫、手绘风格。` +
        `人物特征：${ethnicity}，${prompt}。` +
        `服装为该时代背景下最普通的日常便服，无配饰，不携带任何物品。` +
        `画面包含：正面全身、侧面全身、背面全身、正面脸部特写，四视角排列。` +
        `高清，自然光影。`;

      await generateImage(fullPrompt, protoPath, [], "16:9");

      // 写入角色 JSON
      const data = await loadJson();
      data.base_prompt = prompt;
      await fs.writeFile(jsonPath, JSON.stringify(data, null, 2), "utf-8");

      return {
        content: [{ type: "text" as const, text: `角色 ${name} 原型图已生成: ${protoPath}` }],
        details: {},
      };

    } else {
      // ── 造型图模式（图生图）──────────────────────────────────
      try {
        await fs.access(protoPath);
      } catch {
        return {
          content: [{ type: "text" as const, text: `原型图不存在，请先生成原型图: ${protoPath}` }],
          details: {},
        };
      }

      const stagePath = novelPaths.characterStageImage(novelName, name, stage);

      try {
        await fs.access(stagePath);
        return {
          content: [{ type: "text" as const, text: `造型图已存在，跳过生成: ${stagePath}` }],
          details: {},
        };
      } catch { /* 不存在，继续生成 */ }

      const fullPrompt =
        `基于参考图中的角色，保持其面部特征、体型、发型完全一致。` +
        `人物特征：${ethnicity}。` +
        `本阶段造型：${prompt}。` +
        `画面包含：正面全身、侧面全身、背面全身、正面脸部特写，四视角排列。` +
        `真人写实摄影风格，白色纯净背景，高清，自然光影。`;

      await generateImage(fullPrompt, stagePath, [protoPath], "16:9");

      // 追加造型阶段到 JSON
      const data = await loadJson();
      if (!data.stages.some((s) => s.stage === stage)) {
        data.stages.push({ stage, prompt });
        await fs.writeFile(jsonPath, JSON.stringify(data, null, 2), "utf-8");
      }

      return {
        content: [{ type: "text" as const, text: `角色 ${name}「${stage}」造型图已生成: ${stagePath}` }],
        details: {},
      };
    }
  },
};
