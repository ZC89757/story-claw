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
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const UTILS_DIR = path.dirname(fileURLToPath(import.meta.url));

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 3000;
const TIMEOUT_MS = 600_000;

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

  const buildArgs = () => {
    const args = [helperPath, outputPath, prompt];
    if (aspectRatio) args.push("--aspect", aspectRatio);
    args.push(...images);
    return args;
  };

  // ── 主路径：gpt-image-gen.py（带重试）────────────────────────────────────
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const { ok, stderr } = await runPython(buildArgs());

    if (ok) {
      console.log(`  [gpt-image-2] 已保存: ${outputPath}`);
      return outputPath;
    }

    const errMsg = stderr.slice(0, 1500);
    console.log(`  [${attempt}/${MAX_RETRIES}] gpt-image-gen 失败: ${errMsg}`);

    if (attempt < MAX_RETRIES) {
      console.log(`  ${RETRY_DELAY_MS / 1000}s 后重试...`);
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }

  // ── 降级：gemini-image-gen.py ─────────────────────────────────────────────
  console.log(`  gpt-image-2 失败，降级到 Gemini...`);
  const geminiPath = path.join(UTILS_DIR, "gemini-image-gen.py");
  const geminiArgs = [geminiPath, outputPath, prompt];
  if (aspectRatio) geminiArgs.push("--aspect", aspectRatio);
  geminiArgs.push(...images);

  const { ok: geminiOk, stderr: geminiErr } = await runPython(geminiArgs);

  if (geminiOk) {
    console.log(`  [Gemini] 已保存: ${outputPath}`);
    return outputPath;
  }

  throw new Error(`gpt-image-2 与 Gemini 均失败。Gemini 错误: ${geminiErr.slice(0, 1500)}`);
}
