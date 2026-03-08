/**
 * image-gen.ts — Gemini 图像生成统一接口
 *
 * 直接在 Node.js 中调用 Gemini API 生成图像。
 *
 * 功能：
 *   0 张图 → 文生图 (txt2img)
 *   N 张图 → 多图生图 (img2img)
 */

import fs from "node:fs/promises";
import path from "node:path";
import { CONFIG_DIR } from "./run-python.js";

// ── 配置读取 ──────────────────────────────────────────────────────────────
interface ImageGenConfig {
  api_key: string;
  model: string;
  base_url: string;
}

let _config: ImageGenConfig | null = null;

async function loadConfig(): Promise<ImageGenConfig> {
  if (_config) return _config;
  const configPath = path.join(CONFIG_DIR, "image_gen_config.json");
  const raw = await fs.readFile(configPath, "utf-8");
  _config = JSON.parse(raw) as ImageGenConfig;
  return _config;
}

// ── 图片读取 ──────────────────────────────────────────────────────────────
function mimeFromExt(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
  };
  return map[ext] ?? "image/png";
}

// ── 核心生成函数 ──────────────────────────────────────────────────────────
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 3000;

/**
 * 统一图像生成接口。
 *
 * @param prompt     提示词文本
 * @param outputPath 输出图片保存路径
 * @param images     输入图片路径列表（0 张=文生图，N 张=多图生图）
 * @returns          保存路径
 * @throws           连续 MAX_RETRIES 次失败时抛出错误
 */
export async function generateImage(
  prompt: string,
  outputPath: string,
  images: string[] = [],
): Promise<string> {
  const config = await loadConfig();

  // 构建 contents: [image_parts..., prompt_text]
  const contents: any[] = [];
  for (const imgPath of images) {
    const data = await fs.readFile(imgPath);
    contents.push({
      inlineData: {
        mimeType: mimeFromExt(imgPath),
        data: data.toString("base64"),
      },
    });
  }
  contents.push({ text: prompt });

  const mode = images.length === 0 ? "txt2img" : `img2img (${images.length} images)`;
  console.log(`  模式: ${mode}，调用 Gemini API...`);
  console.log(`  prompt: ${prompt}`);
  for (const img of images) {
    console.log(`  参考图: ${path.basename(img)}`);
  }

  // 确保输出目录存在
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  // 使用 fetch 直接调用 Gemini REST API
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const url = `${config.base_url}/v1/models/${config.model}:generateContent`;
      const body = {
        contents: [{ role: "user", parts: contents }],
        generationConfig: {
          responseModalities: ["TEXT", "IMAGE"],
        },
      };

      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${config.api_key}`,
        },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        console.log(`  [${attempt}/${MAX_RETRIES}] HTTP ${resp.status}: ${errText.slice(0, 200)}`);
      } else {
        const result: any = await resp.json();

        if (!result.candidates || result.candidates.length === 0) {
          const reason = result.promptFeedback?.blockReason ?? "unknown";
          console.log(`  [${attempt}/${MAX_RETRIES}] 请求被拦截（block_reason: ${reason}）`);
        } else {
          const parts = result.candidates[0]?.content?.parts ?? [];
          for (const part of parts) {
            if (part.inlineData) {
              const imgBuf = Buffer.from(part.inlineData.data, "base64");
              await fs.writeFile(outputPath, imgBuf);
              console.log(`  已保存: ${outputPath}`);
              return outputPath;
            }
          }
          console.log(`  [${attempt}/${MAX_RETRIES}] 未收到图片数据`);
        }
      }
    } catch (err) {
      console.log(`  [${attempt}/${MAX_RETRIES}] API 异常: ${err}`);
    }

    if (attempt < MAX_RETRIES) {
      console.log(`  ${RETRY_DELAY_MS / 1000}s 后重试...`);
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }

  throw new Error(`连续 ${MAX_RETRIES} 次生图失败，prompt: ${prompt.slice(0, 80)}...`);
}
