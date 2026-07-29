/**
 * image-gen.ts — 图像生成统一接口
 *
 * 主路径：调用 gpt-image-gen.py（Google GenAI SDK, Vertex AI 模式）
 *   0 张图 → generate_images（文生图）
 *   N 张图 → edit_image（图生图）
 *
 * 降级路径：gpt-image-gen.py 连续失败 MAX_RETRIES 次后，改调 gemini-image-gen.py
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const UTILS_DIR = path.dirname(fileURLToPath(import.meta.url));

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 3000;
const TIMEOUT_MS = 600_000;
const SOFTEN_MAX = 2;

/** 判断 stderr 是否为内容安全系统拒绝（gpt-image-2 透传的 400 safety_violations 等） */
function isSafetyRejection(stderr: string): boolean {
  return /rejected by the safety system|safety_violations/i.test(stderr);
}

const SOFTEN_SYSTEM = `你是生图提示词安全改写专员。给你一段生图提示词和它被内容安全系统拒绝的原因，请改写出一段能通过审核的版本。

规则：
1. 保留画面主体、构图、景别、镜头、光影、情绪基调不变。
2. 保留所有 "the person in image N" / "the background in image N" 占位符原样不动（N 是数字），不得删除或改写它们。
3. 仅弱化会触发内容安全审核的血腥、暴力、惊悚、伤害等直白描写：用含蓄、间接、艺术化的表达替代（如"破碎的大脑组织带血丝"→"掌心一团模糊的暗红色物体，虚化处理"）。
4. 不要添加新的画面元素，只做必要的弱化。
5. 只输出改写后的提示词纯文本，不要解释、不要 JSON、不要方括号标签、不要代码块包裹。`;

/** 用主文本 LLM 软化提示词；传入内容可以是上一档软化结果 */
async function softenPrompt(prompt: string, rejectionInfo: string): Promise<string> {
  const configPath = path.join(os.homedir(), ".story-claw", "config.json");
  const cfg = JSON.parse(await fs.readFile(configPath, "utf-8"));
  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({
    apiKey: cfg.api_key,
    baseURL: cfg.base_url ?? "https://zenmux.ai/api/v1",
    timeout: cfg.timeout_ms ?? 300_000,
    maxRetries: 1,
  });
  const resp = await client.chat.completions.create({
    model: cfg.model ?? "anthropic/claude-sonnet-4.6",
    max_tokens: cfg.max_tokens ?? 128_000,
    messages: [
      { role: "system", content: SOFTEN_SYSTEM },
      { role: "user", content: `原提示词：\n${prompt}\n\n被拒原因：\n${rejectionInfo}\n\n请输出软化后的提示词：` },
    ],
  });
  let raw = resp.choices[0].message.content?.trim() ?? "";
  if (raw.includes("```")) {
    raw = raw.split("```")[1] ?? raw;
    if (raw.startsWith("json")) raw = raw.slice(4);
    raw = raw.trim();
  }
  if (!raw) throw new Error("softenPrompt 返回空");
  return raw;
}

/** 异步执行 python 脚本，返回 { ok, stderr } */
function runPython(args: string[]): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("python", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d.toString(); });

    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve({ ok, stderr });
    };

    const timer = setTimeout(() => {
      child.kill();
      stderr += "\n[timeout] process killed after " + TIMEOUT_MS / 1000 + "s";
      finish(false);
    }, TIMEOUT_MS);

    child.on("close", (code) => {
      clearTimeout(timer);
      finish(code === 0);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      stderr += "\n" + err.message;
      finish(false);
    });
  });
}

/**
 * 统一图像生成接口。
 *
 * @param prompt      提示词文本
 * @param outputPath  输出图片保存路径
 * @param images      输入图片路径列表（0 张=文生图，N 张=图生图）
 * @param aspectRatio 可选宽高比，如 "9:16" / "16:9" / "1:1"
 * @returns           保存路径
 * @throws            gpt-image-gen 与 Gemini 均失败时抛出错误
 */
export async function generateImage(
  prompt: string,
  outputPath: string,
  images: string[] = [],
  aspectRatio?: string,
): Promise<string> {
  const mode = images.length === 0 ? "txt2img" : `img2img (${images.length} images)`;
  console.log(`  模式: ${mode}，调用图像生成 API...`);
  console.log(`  prompt: ${prompt}`);
  for (const img of images) {
    console.log(`  参考图: ${path.basename(img)}`);
  }
  if (aspectRatio) {
    console.log(`  宽高比: ${aspectRatio}`);
  }

  // 确保输出目录存在
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const helperPath = path.join(UTILS_DIR, "gpt-image-gen.py");

  let curPrompt = prompt;
  let softenCount = 0;
  const buildArgs = () => {
    const args = [helperPath, outputPath, curPrompt];
    if (aspectRatio) args.push("--aspect", aspectRatio);
    args.push(...images);
    return args;
  };

  // ── 主路径：gpt-image-gen.py（普通失败重试 + 安全拒绝时递进软化）──────────
  let normalAttempt = 0;
  while (normalAttempt < MAX_RETRIES) {
    const { ok, stderr } = await runPython(buildArgs());

    if (ok) {
      console.log(`  [gpt-image-2] 已保存: ${outputPath}`);
      return outputPath;
    }

    const errMsg = stderr.slice(-1500);

    // 安全拒绝不重复提交原提示词，也不占普通重试次数
    if (isSafetyRejection(stderr)) {
      if (softenCount >= SOFTEN_MAX) {
        console.log(`  安全拒绝，已软化 ${SOFTEN_MAX} 档仍未通过，降级 Gemini...`);
        break;
      }
      try {
        curPrompt = await softenPrompt(curPrompt, errMsg);
        softenCount++;
        console.log(`  检测到内容安全拒绝，第 ${softenCount}/${SOFTEN_MAX} 次软化提示词后重试`);
        continue;
      } catch (e: any) {
        console.log(`  软化提示词失败（${e?.message ?? e}），降级 Gemini...`);
        break;
      }
    }

    normalAttempt++;
    console.log(`  [${normalAttempt}/${MAX_RETRIES}] gpt-image-gen 失败: ${errMsg}`);
    if (normalAttempt < MAX_RETRIES) {
      console.log(`  ${RETRY_DELAY_MS / 1000}s 后重试...`);
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }

  // ── 降级：Gemini 使用最终软化后的提示词 ──────────────────────────────────
  console.log(`  gpt-image-2 失败，降级到 Gemini...`);
  const geminiPath = path.join(UTILS_DIR, "gemini-image-gen.py");
  const geminiArgs = [geminiPath, outputPath, curPrompt];
  if (aspectRatio) geminiArgs.push("--aspect", aspectRatio);
  geminiArgs.push(...images);

  const { ok: geminiOk, stderr: geminiErr } = await runPython(geminiArgs);

  if (geminiOk) {
    console.log(`  [Gemini] 已保存: ${outputPath}`);
    return outputPath;
  }

  throw new Error(`gpt-image-2 与 Gemini 均失败（提示词软化 ${softenCount} 档）。Gemini 错误: ${geminiErr.slice(-1500)}`);
}
