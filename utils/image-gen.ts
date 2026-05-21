/**
 * image-gen.ts — 图像生成统一接口
 *
 * 调用 OpenAI Images API 生成图像。
 *
 * 功能：
 *   0 张图 → 文生图，调用 POST /images/generations
 *   N 张图 → 图生图，调用 POST /images/edits（multipart/form-data）
 *
 * 响应格式：data[0].b64_json
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

// ── 核心生成函数 ──────────────────────────────────────────────────────────
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 3000;

/**
 * 统一图像生成接口。
 *
 * @param prompt     提示词文本
 * @param outputPath 输出图片保存路径
 * @param images     输入图片路径列表（0 张=文生图，N 张=图生图）
 * @returns          保存路径
 * @throws           连续 MAX_RETRIES 次失败时抛出错误
 */
export async function generateImage(
  prompt: string,
  outputPath: string,
  images: string[] = [],
): Promise<string> {
  const config = await loadConfig();

  const mode = images.length === 0 ? "txt2img" : `img2img (${images.length} images)`;
  console.log(`  模式: ${mode}，调用图像生成 API...`);
  console.log(`  prompt: ${prompt}`);
  for (const img of images) {
    console.log(`  参考图: ${path.basename(img)}`);
  }

  // 确保输出目录存在
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      let resp: Response;

      if (images.length === 0) {
        // 文生图：POST /images/generations（JSON body）
        const url = `${config.base_url}/images/generations`;
        resp = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${config.api_key}`,
          },
          body: JSON.stringify({
            model: config.model,
            prompt,
            n: 1,
          }),
        });
      } else {
        // 图生图：POST /images/edits（multipart/form-data）
        const url = `${config.base_url}/images/edits`;
        const form = new FormData();
        form.append("model", config.model);
        form.append("prompt", prompt);
        form.append("n", "1");

        for (let i = 0; i < images.length; i++) {
          const imgBuf = await fs.readFile(images[i]);
          const blob = new Blob([imgBuf], { type: "image/png" });
          form.append("image[]", blob, path.basename(images[i]));
        }

        resp = await fetch(url, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${config.api_key}`,
          },
          body: form,
        });
      }

      if (!resp.ok) {
        const errText = await resp.text();
        console.log(`  [${attempt}/${MAX_RETRIES}] HTTP ${resp.status}: ${errText.slice(0, 200)}`);
      } else {
        const result: any = await resp.json();
        const b64 = result?.data?.[0]?.b64_json;
        if (b64) {
          const imgBuf = Buffer.from(b64, "base64");
          await fs.writeFile(outputPath, imgBuf);
          console.log(`  已保存: ${outputPath}`);
          return outputPath;
        }
        console.log(`  [${attempt}/${MAX_RETRIES}] 未收到图片数据，响应: ${JSON.stringify(result).slice(0, 200)}`);
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
