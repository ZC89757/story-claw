/**
 * ⑥ 画面生成工具 — 一次性多角色合成 + 逐张分镜
 *
 * 提供两个独立阶段函数供 pipeline 分步调用：
 * - generateCompositeFrames：逐帧合成（场景底图 + 角色参考图），返回合成帧路径列表
 * - generatePanelImages：逐张分镜生成（基于合成帧 + panels JSON）
 *
 * 同时保留 createGenerateImagesTool 工具工厂供兼容。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { PROJECT_ROOT } from "../utils/run-python.js";
import { novelPaths } from "../utils/paths.js";
import { generateImage } from "../utils/image-gen.js";

/** Sub-agent 工厂函数类型 */
export type SubAgentFactory = (
  customTools: ToolDefinition[],
  systemPrompt: string,
  taskPrompt: string,
  logPrefix?: string,
) => Promise<string>;

const MAX_RETRIES = 4;

// ── 内部 Frame 结构（从 scene_data beats 拍平而来） ──────────────────────
interface Frame {
  num: number;
  scene_id: string;
  scene_type: string;
  location: string;
  characters: string[];
  action: string[];
  emotion: string[];
  position: string[];
  scene_spatial: any;
}

// ── 从 scene_data 拍平 beats → frames ────────────────────────────────────
function flattenBeats(sceneData: any, targetSceneId: string | null): Frame[] {
  const scenes: any[] = sceneData.scenes ?? [];
  const frames: Frame[] = [];
  for (const scene of scenes) {
    if (targetSceneId && scene.id !== targetSceneId) continue;
    for (const beat of (scene.beats ?? [])) {
      frames.push({
        num:           beat.num,
        scene_id:      scene.id,
        scene_type:    scene.scene_type ?? "normal",
        location:      scene.location ?? "",
        characters:    beat.characters ?? [],
        action:        beat.action ?? [],
        emotion:       beat.emotion ?? [],
        position:      beat.position ?? [],
        scene_spatial: scene.scene_spatial ?? {},
      });
    }
  }
  return frames;
}

// ── Validation sub-agent 系统提示 ─────────────────────────────────────────
const VALIDATION_SYSTEM = `你是图像合成校验员。任务：对比场景底图、各角色参考图与合成结果图，评估本次多角色场景合成的质量。

请先用 read 工具读取场景底图和合成结果图，然后逐一校验以下 3 项：
1. **角色完整性**：所有角色是否都出现在画面中？数量是否与预期一致？
2. **面部可见**：每个角色是否能看到大部分面部（正脸、侧脸、3/4侧脸均算通过，只要面部大部分可见即可）。不检查朝向是否与 prompt 一致，不检查表情。
3. **空间合理性**：角色站位是否符合 prompt 描述的场景位置？不检查表情、动作、姿态细节。

校验完成后，只输出如下 JSON，不要有任何其他内容：
{
  "pass": true 或 false（全部 3 项通过才为 true）,
  "checks": {
    "completeness": "通过 / 不通过：原因",
    "facing": "通过 / 不通过：原因",
    "spatial": "通过 / 不通过：原因"
  },
  "retry_prompt": "一段可以直接发给生图 API 的完整 prompt（pass=false 时填写）。在原 prompt 基础上针对不通过的项做最小幅度修改，输出修改后的完整 prompt 文本，不要输出修改说明或指令。"
}`;

// ── 解析 validation sub-agent 的输出 ─────────────────────────────────────
function parseValidation(raw: string): {
  pass: boolean;
  checks: Record<string, string>;
  retry_prompt: string;
} {
  try {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start !== -1 && end > start) {
      const obj = JSON.parse(raw.slice(start, end + 1));
      return {
        pass: Boolean(obj.pass),
        checks: (obj.checks && typeof obj.checks === "object") ? obj.checks : {},
        retry_prompt: String(obj.retry_prompt ?? ""),
      };
    }
  } catch {
    // fall through
  }
  return { pass: false, checks: {}, retry_prompt: "" };
}

// ── Panel validation sub-agent 系统提示 ───────────────────────────────────
const PANEL_VALIDATION_SYSTEM = `你是分镜图校验员。任务：对比底图与生成的分镜图，只校验人物和场景背景两项。

请先用 read 工具读取底图和分镜图，然后**只**校验以下 2 项：
1. **人物存在性**：分镜图中是否凭空出现了底图中不存在的人物？只看人物是否多出，不检查人物数量减少、缺失、外貌差异。
2. **场景背景一致性**：分镜图的背景环境是否来自底图的场景？只看背景是否完全无关，不检查角色动作、姿态、构图、拍摄角度等差异。

禁止校验范围：角色动作、姿态、表情、手持物品、站位、构图、拍摄角度、景别。这些差异属于分镜导演的正常创作，不算不通过。

校验完成后，只输出如下 JSON，不要有任何其他内容：
{
  "pass": true 或 false（全部 2 项通过才为 true）,
  "checks": {
    "characters": "通过 / 不通过：原因",
    "scene": "通过 / 不通过：原因"
  },
  "retry_prompt": "一段可以直接发给生图 API 的完整 prompt（pass=false 时填写）。在原 prompt 基础上针对不通过的项做最小幅度修改，输出修改后的完整 prompt 文本，不要输出修改说明或指令。"
}`;

// ── 构建一次性合成 prompt ─────────────────────────────────────────────────
function buildCompositePrompt(frame: Frame, clothingMap: Map<string, string>): string {
  const chars = frame.characters;
  if (chars.length === 0) return "";

  const charLines = chars.map((name, i) => {
    const action   = frame.action[i]   ?? "";
    const emotion  = frame.emotion[i]  ?? "";
    const position = frame.position[i] ?? "";
    const clothing = clothingMap.get(name) ?? "";
    const imgIdx   = i + 2; // 第1张是场景图，第2张起是角色
    const clothingPart = clothing ? `穿${clothing}，` : "";
    return `- 第${imgIdx}张参考图中的人物（${name}）：面朝镜头，${clothingPart}位于${position}，${action}，表情${emotion}`;
  }).join("\n");

  return [
    `基于第1张图的场景环境，将以下角色自然地放入场景中。`,
    `角色描述：`,
    charLines,
    ``,
    `要求：`,
    `- 真人写实摄影风格`,
  ].join("\n");
}

// ── 构建共享数据 ─────────────────────────────────────────────────────────
interface SharedContext {
  sceneData: any;
  frames: Frame[];
  clothingMap: Map<string, string>;
  charsDir: string;
  scenesDir: string;
  framesDir: string;
  panelsDir: string;
}

function buildContext(
  sceneData: any,
  sceneId: string,
  novelName: string,
  episodeNum: number,
): SharedContext {
  const frames = flattenBeats(sceneData, sceneId);

  const clothingMap = new Map<string, string>();
  for (const c of (sceneData.characters ?? [])) {
    if (c.name && c.clothing) {
      clothingMap.set(c.name, c.clothing);
    }
  }

  return {
    sceneData,
    frames,
    clothingMap,
    charsDir:   novelPaths.charactersDir(novelName),
    scenesDir:  novelPaths.scenesDir(novelName),
    framesDir:  novelPaths.characterFramesDir(novelName, episodeNum),
    panelsDir:  novelPaths.storyboardPanelsDir(novelName, episodeNum),
  };
}

// ══════════════════════════════════════════════════════════════════════════
// Step 1：逐帧一次性多角色合成（含 validation 重试）
// 返回：{ scene_id_num → 合成帧绝对路径 } 的映射
// ══════════════════════════════════════════════════════════════════════════

export interface CompositeFrameResult {
  /** scene_id + "_" + num (如 "scene_01_01") → 合成帧绝对路径 */
  framePaths: Map<string, string>;
  logs: string[];
}

export async function generateCompositeFrames(
  sceneData: any,
  sceneId: string,
  novelName: string,
  episodeNum: number,
  runSubAgent: SubAgentFactory,
): Promise<CompositeFrameResult> {
  const ctx = buildContext(sceneData, sceneId, novelName, episodeNum);
  const results: string[] = [];
  const framePaths = new Map<string, string>();

  let prevCharKey = "";
  let prevFramePath = "";

  for (const frame of ctx.frames) {
    const sceneType = frame.scene_type;
    if (sceneType !== "normal") continue;

    const num       = frame.num;
    const location  = frame.location;
    const chars     = frame.characters;
    const prefix    = frame.scene_id ? `${frame.scene_id}_` : "";
    const numStr    = String(num).padStart(2, "0");
    const frameKey  = `${prefix}${numStr}`;

    if (chars.length === 0) continue;

    const scenePath = path.join(ctx.scenesDir, `${location}.png`);
    const outputPath = path.join(ctx.framesDir, `frame_${frameKey}.png`);

    // 角色去重：与上一帧角色相同则直接复用
    const charKey = [...chars].sort().join(",");
    if (prevFramePath && charKey === prevCharKey) {
      await fs.copyFile(prevFramePath, outputPath);
      console.log(`\n[composite] 帧 ${num}：角色未变化，复用上一帧合成图`);
      results.push(`帧 ${num}：角色未变化，复用帧合成图`);
      framePaths.set(frameKey, outputPath);
      continue;
    }

    // 收集角色参考图路径
    const charPaths: string[] = chars.map(
      (name) => path.join(ctx.charsDir, `${name}.png`),
    );

    const originalPrompt = buildCompositePrompt(frame, ctx.clothingMap);

    console.log(`\n[composite] 帧 ${num} 开始合成（${chars.length} 个角色）`);

    let succeeded = false;
    let currentPrompt = originalPrompt;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      console.log(`  [尝试 ${attempt}]`);

      const allImages = [scenePath, ...charPaths];
      await generateImage(currentPrompt, outputPath, allImages);

      const validationRaw = await runSubAgent(
        [],
        VALIDATION_SYSTEM,
        [
          `场景底图路径：${scenePath}`,
          `合成结果图路径：${outputPath}`,
          `角色参考图路径：${charPaths.join("、")}`,
          `合成 prompt：${currentPrompt}`,
        ].join("\n"),
        `[Validate:${frame.scene_id}:f${num}:a${attempt}]`,
      );

      const v = parseValidation(validationRaw);
      console.log(`  [尝试 ${attempt}] 校验: ${v.pass ? "通过 ✓" : "不通过"}`);
      if (!v.pass) {
        const failReasons: string[] = [];
        for (const [key, val] of Object.entries(v.checks)) {
          if (typeof val === "string" && val.startsWith("不通过")) {
            console.log(`    ✗ ${key}: ${val}`);
            failReasons.push(`${key}: ${val}`);
          }
        }
        results.push(`帧 ${num} 尝试${attempt} 不通过：${failReasons.join("；")}`);
      }

      if (v.pass) {
        succeeded = true;
        results.push(`帧 ${num}：第 ${attempt} 次合成通过`);
        break;
      }

      if (v.retry_prompt) {
        currentPrompt = v.retry_prompt;
      }
    }

    if (!succeeded) {
      results.push(`帧 ${num}：${MAX_RETRIES} 次全部未通过，使用最后一次结果继续`);
    }

    prevCharKey = charKey;
    prevFramePath = outputPath;
    framePaths.set(frameKey, outputPath);
  }

  return { framePaths, logs: results };
}

// ══════════════════════════════════════════════════════════════════════════
// Step 2：逐张分镜生成
// beatPanelsMap: beat num → panels 数组（每个 panel 含 { id, prompt }）
// ══════════════════════════════════════════════════════════════════════════

const PROMPT_SUFFIX = "\n画幅比例16:9，真人写实摄影风格。";

export async function generatePanelImages(
  sceneData: any,
  sceneId: string,
  novelName: string,
  episodeNum: number,
  beatPanelsMap: Map<number, any[]>,
  runSubAgent: SubAgentFactory,
): Promise<string[]> {
  const ctx = buildContext(sceneData, sceneId, novelName, episodeNum);
  const results: string[] = [];

  for (const frame of ctx.frames) {
    const num    = frame.num;
    const panels = beatPanelsMap.get(num);

    if (!panels || panels.length === 0) {
      results.push(`帧 ${num}：未找到 panels 配置，跳过分镜生成`);
      continue;
    }

    const prefix    = frame.scene_id ? `${frame.scene_id}_` : "";
    const numStr    = String(num).padStart(2, "0");
    const sceneType = frame.scene_type;
    const location  = frame.location;
    const chars     = frame.characters;

    let inputImagePath: string | null;
    if (sceneType === "effects") {
      inputImagePath = null;
      results.push(`帧 ${num}（effects）：纯文生图模式`);
    } else if (sceneType === "environment") {
      inputImagePath = path.join(ctx.scenesDir, `${location}.png`);
      results.push(`帧 ${num}（environment）：使用场景底图 ${location}.png`);
    } else {
      if (chars.length === 0) {
        inputImagePath = path.join(ctx.scenesDir, `${location}.png`);
      } else {
        inputImagePath = path.join(
          ctx.framesDir,
          `frame_${prefix}${numStr}.png`,
        );
      }
    }

    // 逐个 panel 独立生成一张图（含校验重试）
    for (let pi = 0; pi < panels.length; pi++) {
      const p = panels[pi];
      const panelNum = String(pi + 1).padStart(2, "0");

      // LLM 直接写的 prompt + 硬编码后缀
      const originalPanelPrompt = `${p.prompt}${PROMPT_SUFFIX}`;

      const panelPath = path.join(ctx.panelsDir, `panel_${prefix}${numStr}_p${panelNum}.png`);
      const panelImages = inputImagePath ? [inputImagePath] : [];

      // effects 无底图，跳过校验
      if (!inputImagePath) {
        await generateImage(originalPanelPrompt, panelPath, panelImages);
        results.push(`帧 ${num} 分镜 p${panelNum} 完成 → panel_${prefix}${numStr}_p${panelNum}.png`);
        continue;
      }

      let panelSucceeded = false;
      let curPanelPrompt = originalPanelPrompt;

      for (let pa = 1; pa <= MAX_RETRIES; pa++) {
        await generateImage(curPanelPrompt, panelPath, panelImages);

        const pvRaw = await runSubAgent(
          [],
          PANEL_VALIDATION_SYSTEM,
          [
            `底图路径：${inputImagePath}`,
            `分镜图路径：${panelPath}`,
            `生成 prompt：${curPanelPrompt}`,
          ].join("\n"),
          `[PanelVal:${frame.scene_id}:f${num}:p${pi + 1}:a${pa}]`,
        );

        const pv = parseValidation(pvRaw);
        console.log(`  [帧${num} p${panelNum} 尝试${pa}] 校验: ${pv.pass ? "通过 ✓" : "不通过"}`);
        if (!pv.pass) {
          const failReasons: string[] = [];
          for (const [key, val] of Object.entries(pv.checks)) {
            if (typeof val === "string" && val.startsWith("不通过")) {
              console.log(`    ✗ ${key}: ${val}`);
              failReasons.push(`${key}: ${val}`);
            }
          }
          results.push(`帧 ${num} 分镜 p${panelNum} 尝试${pa} 不通过：${failReasons.join("；")}`);
        }

        if (pv.pass) {
          panelSucceeded = true;
          results.push(`帧 ${num} 分镜 p${panelNum}：第 ${pa} 次通过`);
          break;
        }

        if (pv.retry_prompt) {
          curPanelPrompt = pv.retry_prompt;
        }
      }

      if (!panelSucceeded) {
        results.push(`帧 ${num} 分镜 p${panelNum}：${MAX_RETRIES} 次未通过，使用最后一次结果`);
      }
    }
  }

  return results;
}

// ── 工具工厂（兼容旧调用方式）──────────────────────────────────────────────
export function createGenerateImagesTool(runSubAgent: SubAgentFactory): ToolDefinition {
  return {
    name: "generate_images",
    label: "画面生成",
    description:
      "执行完整的画面生成流程（逐帧处理）：" +
      "Step 1: 逐帧将场景底图 + 全部角色参考图一次性合成为成品帧，validation sub-agent 校验，不通过重试；" +
      "Step 2: 逐帧按 panels 配置逐张生成分镜图片（每个 panel 独立一张图）。" +
      "需要 scene_json（scene_data.json 路径）、scene_id（场景 ID）和 panels_json（分镜面板配置）。",
    parameters: Type.Object({
      novel_name: Type.String({
        description: "小说名称（对应 workspace 下的文件夹名）",
      }),
      episode_num: Type.Number({
        description: "集数编号",
      }),
      scene_json: Type.String({
        description: "scene_data.json 文件路径",
      }),
      scene_id: Type.String({
        description: "要处理的场景 ID（如 'scene_01'）",
      }),
      panels_json: Type.String({
        description: "分镜面板配置 JSON 文件路径（direct_storyboard 的输出，含每帧的 panels）",
      }),
    }),
    execute: async (_toolCallId: string, params: any) => {
      const absSceneJson = path.isAbsolute(String(params.scene_json))
        ? String(params.scene_json)
        : path.join(PROJECT_ROOT, String(params.scene_json));

      const absPanels = path.isAbsolute(String(params.panels_json))
        ? String(params.panels_json)
        : path.join(PROJECT_ROOT, String(params.panels_json));

      let sceneData: any;
      let panelsData: any;
      try {
        sceneData  = JSON.parse(await fs.readFile(absSceneJson, "utf-8"));
        panelsData = JSON.parse(await fs.readFile(absPanels, "utf-8"));
      } catch (err) {
        return { content: [{ type: "text" as const, text: `读取配置文件失败: ${err}` }], details: {} };
      }

      const novelName = String(params.novel_name);
      const episodeNum = Number(params.episode_num);
      const sceneId = String(params.scene_id);

      const step1 = await generateCompositeFrames(sceneData, sceneId, novelName, episodeNum, runSubAgent);

      // 兼容旧格式：将 { frames: [{ num, panels }] } 转为 beatPanelsMap
      const beatPanelsMap = new Map<number, any[]>();
      for (const fd of (panelsData.frames ?? [])) {
        beatPanelsMap.set(fd.num, fd.panels);
      }
      const step2 = await generatePanelImages(sceneData, sceneId, novelName, episodeNum, beatPanelsMap, runSubAgent);

      const allLogs = [...step1.logs, `\nStep 1 完成：${novelPaths.characterFramesDir(novelName, episodeNum)}`, ...step2];
      return { content: [{ type: "text" as const, text: allLogs.join("\n\n---\n\n") }], details: {} };
    },
  };
}
