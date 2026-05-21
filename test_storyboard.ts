/**
 * 单场景分镜测试脚本
 * 用法: node --import tsx test_storyboard.ts
 */

import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { runSubAgent } from "./agent.js";
import { novelPaths } from "./utils/paths.js";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";

const STORYBOARD_SYSTEM = `你是分镜导演。任务：为一个场景的完整剧本设计分镜序列，输出可直接用于生图和生视频的 prompt。

== 基本概念 ==

剧本中每句话对应一个 group。
每个 group 内有一个或多个 panel（分镜），每个 panel 代表该句话中的一个时刻或机位。

== 【】画面预设说明 ==

剧本每句话后的【】块格式：场景 | 人物 | 景别 | 角度 | 镜头运动 | 光影 | 情绪 | 语言 | 独白

各字段含义及在提示词中的用途：
- 场景：当前地点及环境状态 → image_prompt 背景描述的基础
- 人物：出现角色的位置与动作 → image_prompt 中人物姿态的参考
- 景别：远景/全景/中景/近景/特写 → panel 的 shot_type，决定画面中人物与背景的比例
- 角度：拍摄角度（平视/俯视/仰视等）→ image_prompt 中的镜头角度描述
- 镜头运动：固定/推/拉/摇/跟等 → video_prompt 中的镜头运动方式
- 光影：光源、氛围、明暗 → image_prompt 中的光线描述
- 情绪：角色情绪状态 → image_prompt 中表情/肢体语言，video_prompt 中情绪节奏
- 语言：角色说出的台词（"无"则忽略）→ video_prompt 中必须描述说话动作（嘴唇开合、语气节奏与台词内容匹配）
- 独白：角色内心独白（"无"则忽略）→ video_prompt 中用细微表情/肢体动作体现内心状态

== image_prompt 与 video_prompt 的关系 ==

工作流：先由 image_prompt 生成静态参考图，再将参考图 + video_prompt 输入视频模型生成视频。
因此：
- image_prompt 负责描述静态画面的完整细节：背景环境、人物位置与姿态、景别角度、光线氛围
- video_prompt 基于 image_prompt 已建立的画面，专注描述：镜头运动 + 人物动态变化 + 情绪节奏
- video_prompt 不重复 image_prompt 中已有的静态描述，只补充动态信息
- 若【语言】有内容：video_prompt 必须描述说话人的嘴唇动作及与台词匹配的表情变化
- 若【独白】有内容：video_prompt 描述人物内心外化的细微表情或无意识肢体动作

== 主镜头（每个 group 的第一个 panel）==

景别根据内容选择：
- 多人互动/对话 → 全景或中景，展示人物相对位置
- 单人动作 → 中景
- 环境/空间描写 → 远景或全景
- 情绪/心理描写 → 近景

== 追加 panel 的触发条件 ==

必须追加：
- 有人物开口说话 → 追加说话人的近景或特写
- 有人物明显情绪反应（惊讶/愤怒/害怒/震惊）→ 追加反应人的近景
- 视线焦点从一个人物转移到另一个人物 → 追加新焦点人物的镜头

根据叙事判断追加：
- 进入新场景 / 重要人物初次出场 → 在主镜头之前先给建立镜头（远景/全景）
- 人物有明显位移（走动/奔跑/推门/转身）→ 追加跟镜头或全景展示移动
- 重要道具或细节出现（信件/标牌/伤口）→ 追加特写

== 衔接约束 ==

组内：
- 不允许连续两个景别+角度完全相同的 panel
- panel 顺序按叙事时间排列

组间：
- 每个 group 结束时记录 end_positions（场景内所有在场人物的位置与朝向）
- 下一个 group 的第一个 panel 从上一组的 end_positions 出发
- 相邻两组之间，后一组第一个 panel 的景别不能与前一组最后一个 panel 完全相同

场景开头：
- 第一个 group 的第一个 panel 必须是建立镜头（远景或全景），交代空间关系

== 输出 JSON ==

{
  "scene": "场景名",
  "groups": [
    {
      "text": "原文句子（含【画面预设】标注）",
      "end_positions": "句末所有在场人物的位置与朝向描述",
      "panels": [
        {
          "shot_type": "景别",
          "trigger": "主镜头 / 说话特写 / 情绪反应 / 建立镜头 / 位移跟拍 / 细节特写 / ...",
          "image_prompt": "完整生图描述：场景背景细节 + 人物位置与姿态 + 景别角度 + 光线氛围",
          "video_prompt": "基于已生成图片的动态描述：镜头运动 + 人物动作变化 + 情绪节奏（含台词/独白对应的说话或表情动作）"
        }
      ]
    }
  ]
}

步骤：
1. 通读整个场景剧本，理解空间布局和人物关系
2. 从第一句开始，逐句处理：
   a. 根据规则规划该句的所有 panel
   b. 立即调用 append_group 工具，传入该 group 的完整 JSON 字符串
   c. 处理下一句
3. 所有句子处理完毕后结束

注意：
- 每句必须处理完立即调用 append_group，不要等全部处理完再统一调用
- append_group 的 content 参数是单个 group 的 JSON 字符串，格式：
  {"text":"...","end_positions":"...","panels":[...]}

完成后直接结束，不要询问用户任何问题。`;

async function main() {
  const scriptPath = "C:/Users/ZhangChi/Desktop/改写漫剧/story-claw/workspace/规则怪谈 - 副本/ep01/scripts/新生报到处.md";
  const sceneName  = "新生报到处";
  const jsonlPath  = "C:/Users/ZhangChi/Desktop/改写漫剧/story-claw/workspace/规则怪谈 - 副本/ep01/storyboard_新生报到处.jsonl";

  const scriptContent = await fs.readFile(scriptPath, "utf-8");

  // 清空上次测试的输出
  try { await fs.unlink(jsonlPath); } catch { /* 不存在则忽略 */ }

  const appendGroupTool: ToolDefinition = {
    name: "append_group",
    label: "追加分镜组",
    description: "追加一个 group 的分镜 JSON，并自动在剧本中标记该句为已处理",
    parameters: Type.Object({
      content: Type.String({ description: "该 group 的完整 JSON 字符串" }),
    }),
    execute: async (_toolCallId: string, { content }: { content: string }) => {
      let normalized: string;
      try {
        normalized = JSON.stringify(JSON.parse(content));
      } catch {
        return { content: [{ type: "text" as const, text: "ERROR: invalid JSON, please fix escaping and retry" }], details: {} };
      }
      await fs.appendFile(jsonlPath, normalized + "\n", "utf-8");

      const lines = (await fs.readFile(scriptPath, "utf-8")).split("\n");
      const idx = lines.findIndex(
        (l) => l.trim() && !l.startsWith("#") && !l.trim().startsWith("【") && !l.includes("(已处理)"),
      );
      if (idx !== -1) {
        lines[idx] += "(已处理)";
        await fs.writeFile(scriptPath, lines.join("\n"), "utf-8");
      }

      return { content: [{ type: "text" as const, text: "OK" }], details: {} };
    },
  };

  await runSubAgent(
    [appendGroupTool],
    STORYBOARD_SYSTEM,
    [
      `场景名：${sceneName}`,
      ``,
      `== 场景剧本 ==`,
      scriptContent,
    ].join("\n"),
    `[分镜:${sceneName}]`,
    [],
  );

  console.log("\n输出文件:", jsonlPath);
  const result = await fs.readFile(jsonlPath, "utf-8");
  console.log("\n=== 生成结果 ===");
  console.log(result);
}

main().catch(console.error);
