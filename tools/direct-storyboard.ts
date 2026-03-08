/**
 * ⑤ 分镜导演工具 — LLM 推理任务
 *
 * 根据 scene_data.json 中的单个 beat 数据，设计分镜构图。
 * 纯 LLM 推理，不调用外部脚本。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { PROJECT_ROOT } from "../utils/run-python.js";
import { OUTPUT_SCHEMAS } from "./schemas.js";

export const directStoryboardTool: ToolDefinition = {
  name: "direct_storyboard",
  label: "分镜导演",
  description:
    "根据 scene_data.json 中的单个 beat 数据，设计该 beat 的分镜。" +
    "分镜数量只能是 1、4 或 6 张。" +
    "每个 panel 输出完整的生图 prompt。",
  parameters: Type.Object({
    scene_json: Type.String({ description: "scene_data.json 文件路径" }),
    scene_id: Type.String({ description: "要处理的场景 ID（如 'scene_01'）" }),
    beat_num: Type.Number({ description: "要处理的 beat 编号（如 1）" }),
  }),
  execute: async (_toolCallId: string, params: any) => {
    const rawPath = String(params.scene_json);
    const filePath = path.isAbsolute(rawPath) ? rawPath : path.join(PROJECT_ROOT, rawPath);
    const targetSceneId = String(params.scene_id);
    const targetBeatNum = Number(params.beat_num);

    try {
      const sceneData = JSON.parse(await fs.readFile(filePath, "utf-8"));
      const allScenes: any[] = sceneData.scenes ?? [];
      const scene = allScenes.find((s: any) => s.id === targetSceneId);

      if (!scene) {
        return { content: [{ type: "text" as const, text: `未找到场景 ${targetSceneId}` }], details: {} };
      }

      const beats: any[] = scene.beats ?? [];
      const beat = beats.find((b: any) => b.num === targetBeatNum);

      if (!beat) {
        return { content: [{ type: "text" as const, text: `未找到 beat ${targetBeatNum}` }], details: {} };
      }

      // 判断是否为建立镜头 beat
      const beatIndex = beats.indexOf(beat);
      let isEstablishing = beatIndex === 0;
      if (!isEstablishing && beatIndex > 0) {
        const prevChars = (beats[beatIndex - 1].characters ?? []).slice().sort().join(",");
        const curChars = (beat.characters ?? []).slice().sort().join(",");
        isEstablishing = prevChars !== curChars;
      }

      // 提取角色服装信息
      let characterText = "";
      const chars: any[] = sceneData.characters ?? [];
      if (chars.length > 0) {
        const charLines = chars.map((c: any) =>
          `${c.name}：${c.age_desc ?? ""}，${c.clothing ?? ""}`,
        );
        characterText = `角色服装参考（prompt 中提及角色时必须使用以下服装描述）：\n${charLines.join("\n")}\n\n`;
      }

      // 构建单个 beat 数据
      const beatData = {
        num: beat.num,
        title: beat.title,
        characters: beat.characters,
        emotion: beat.emotion,
        action: beat.action,
        facing: beat.facing,
        position: beat.position,
      };
      const beatDataStr = JSON.stringify(beatData, null, 2);

      return {
        content: [{ type: "text" as const, text:
          `场景数据已读取。\n\n` +
          `请为该 beat 设计分镜，直接输出完整的生图 prompt。\n\n` +
          `场景信息：${scene.location}（${scene.scene_type}）\n` +
          `该 beat 是${isEstablishing ? "建立镜头 beat（第 1 张 panel 用远景或全景）" : "非建立镜头 beat（所有 panel 一律用近景或特写）"}\n\n` +
          characterText +
          `Beat 数据：\n${beatDataStr}\n\n` +
          OUTPUT_SCHEMAS["direct_storyboard"]
        }],
        details: {},
      };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `读取场景数据失败: ${err}` }], details: {} };
    }
  },
};
