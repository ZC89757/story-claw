/** Node-only image generation adapter. The desktop runtime never needs Python. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import OpenAI from "openai";
import {toFile} from "openai/uploads";
import {GoogleGenAI, RawReferenceImage, createPartFromBase64} from "@google/genai";
import sharp, {type OutputInfo} from "sharp";
import {fetchDirect, fetchWithEnvironmentProxy, isPrivateHost, requestHostname} from "./proxy-fetch.js";

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 3000;
const TIMEOUT_MS = 600_000;
const SOFTEN_MAX = 2;
const COMPRESS_MAX_PX = 512;
const proxyHosts = new Set<string>();
const proxyAwareGoogleFetch = ((input: any, init: any = {}) => {
  const host = requestHostname(input);
  return proxyHosts.has(host) ? fetchWithEnvironmentProxy(input, init) : fetchDirect(input, init);
}) as typeof fetch;
globalThis.fetch = proxyAwareGoogleFetch;

const ASPECT_TO_SIZE: Record<string, string> = {
  "9:16": "1k", "16:9": "1k", "1:1": "1k", "3:2": "1k", "2:3": "1k",
};

const ASPECT_INSTRUCTIONS: Record<string, string> = {
  "16:9": "MANDATORY OUTPUT FORMAT: create a true 16:9 landscape image. Compose the scene specifically for a wide horizontal canvas, keeping all essential subjects and text inside the frame. The returned image canvas itself must be 16:9. Do not return a 3:2, 4:3, square, or portrait canvas, and do not simulate 16:9 with letterboxing or borders.",
  "9:16": "MANDATORY OUTPUT FORMAT: create a true 9:16 portrait image. Compose the scene specifically for a tall vertical canvas, keeping all essential subjects and text inside the frame. The returned image canvas itself must be 9:16. Do not return a 2:3, 3:2, square, or landscape canvas, and do not simulate 9:16 with letterboxing or borders.",
  "1:1": "MANDATORY OUTPUT FORMAT: create a true 1:1 square image. The returned image canvas itself must be square, with no letterboxing or borders.",
};

const SOFTEN_SYSTEM = `你是生图提示词安全改写专员。给你一段生图提示词和它被内容安全系统拒绝的原因，请改写出一段能通过审核的版本。

规则：
1. 保留画面主体、构图、景别、镜头、光影、情绪基调不变。
2. 保留所有 "the person in image N" / "the background in image N" 占位符原样不动（N 是数字），不得删除或改写它们。
3. 仅弱化会触发内容安全审核的血腥、暴力、惊悚、伤害等直白描写：用含蓄、间接、艺术化的表达替代。
4. 不要添加新的画面元素，只做必要的弱化。
5. 只输出改写后的提示词纯文本，不要解释、不要 JSON、不要方括号标签、不要代码块包裹。`;

type ImageConfig = {
  api_key: string;
  model: string;
  base_url?: string;
  api_format?: "openai" | "vertex";
  timeout_ms?: number;
};

const configDir = (): string => process.env.STORY_CLAW_CONFIG_DIR || path.join(os.homedir(), ".story-claw");

const readConfig = async (): Promise<ImageConfig> =>
  JSON.parse(await fs.readFile(path.join(configDir(), "image_gen_config.json"), "utf8")) as ImageConfig;

const appendAspectInstruction = (prompt: string, aspectRatio?: string): string => {
  const instruction = ASPECT_INSTRUCTIONS[aspectRatio || ""];
  return instruction ? `${prompt}\n\n${instruction}` : prompt;
};

const compressImage = async (imagePath: string): Promise<Buffer> => sharp(imagePath)
  .ensureAlpha()
  .resize({width: COMPRESS_MAX_PX, height: COMPRESS_MAX_PX, fit: "inside", withoutEnlargement: true})
  .png()
  .toBuffer();

/** Reject blank or invalid API responses before they reach the render pipeline. */
export const validateGeneratedImage = async (imageBytes: Buffer): Promise<void> => {
  let raw: {data: Buffer; info: OutputInfo};
  try {
    raw = await sharp(imageBytes).ensureAlpha()
      .resize({width: 256, height: 256, fit: "inside", withoutEnlargement: true})
      .raw().toBuffer({resolveWithObject: true});
  } catch (error) {
    throw new Error(`invalid generated image: ${error instanceof Error ? error.message : String(error)}`);
  }
  const pixels = raw.data;
  if (!pixels.length || raw.info.channels < 4) throw new Error("generated image has no pixels");
  let visible = 0;
  let black = 0;
  let white = 0;
  const sum = [0, 0, 0];
  const sumSq = [0, 0, 0];
  for (let i = 0; i < pixels.length; i += raw.info.channels) {
    const values = [pixels[i], pixels[i + 1], pixels[i + 2]];
    if (pixels[i + 3] < 16) continue;
    visible += 1;
    if (Math.max(...values) <= 8) black += 1;
    if (Math.min(...values) >= 247) white += 1;
    for (let channel = 0; channel < 3; channel += 1) {
      sum[channel] += values[channel];
      sumSq[channel] += values[channel] ** 2;
    }
  }
  const total = pixels.length / raw.info.channels;
  if (visible < total * 0.01) throw new Error("generated image is blank: almost fully transparent");
  if (black / visible >= 0.995) throw new Error(`generated image is blank: black pixels ${((black / visible) * 100).toFixed(1)}%`);
  if (white / visible >= 0.995) throw new Error(`generated image is blank: white pixels ${((white / visible) * 100).toFixed(1)}%`);
  const variances = sum.map((value, index) => (sumSq[index] / visible) - (value / visible) ** 2);
  if (Math.max(...variances) < 1) throw new Error(`generated image is blank: near-solid color variance=${Math.max(...variances).toFixed(3)}`);
};

const openAiImageBytes = async (response: any): Promise<Buffer> => {
  const item = response?.data?.[0];
  if (!item) throw new Error("no image data in OpenAI-compatible response");
  if (item.b64_json) return Buffer.from(item.b64_json, "base64");
  if (item.url) {
    const result = await fetchWithEnvironmentProxy(item.url, {signal: AbortSignal.timeout(120_000)});
    if (!result.ok) throw new Error(`image URL request failed: HTTP ${result.status}`);
    return Buffer.from(await result.arrayBuffer());
  }
  throw new Error("response image has neither b64_json nor url");
};

const outputSize = (aspectRatio?: string): any => ({
  "16:9": "1536x1024", "9:16": "1024x1536", "1:1": "1024x1024",
}[aspectRatio || ""] || "1024x1024");

const generateOpenAi = async (cfg: ImageConfig, prompt: string, imagePaths: string[], aspectRatio?: string): Promise<Buffer> => {
  const client = new OpenAI({
    apiKey: cfg.api_key,
    baseURL: (cfg.base_url || "https://zenmux.ai/api/v1").replace(/\/$/, ""),
    timeout: cfg.timeout_ms ?? TIMEOUT_MS,
    maxRetries: 0,
    fetch: fetchWithEnvironmentProxy,
  });
  const common: any = {
    model: cfg.model,
    prompt: appendAspectInstruction(prompt, aspectRatio),
    n: 1,
    size: outputSize(aspectRatio),
    response_format: "b64_json",
    image_size: ASPECT_TO_SIZE[aspectRatio || ""] || "1k",
    ...(aspectRatio ? {aspect_ratio: aspectRatio} : {}),
  };
  if (!imagePaths.length) return openAiImageBytes(await client.images.generate(common));
  const compressed = await Promise.all(imagePaths.map(compressImage));
  const images = await Promise.all(compressed.map((buffer, index) => toFile(buffer, `reference_${index + 1}.png`, {type: "image/png"})));
  return openAiImageBytes(await client.images.edit({...common, image: images} as any));
};

const vertexClient = (cfg: ImageConfig): GoogleGenAI => new GoogleGenAI({
  apiKey: cfg.api_key,
  vertexai: true,
  apiVersion: "v1",
  httpOptions: {baseUrl: cfg.base_url || "https://zenmux.ai/api/vertex-ai", timeout: cfg.timeout_ms ?? TIMEOUT_MS},
});

const registerProxyHost = (baseUrl: string): void => {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    if (host && !isPrivateHost(host)) proxyHosts.add(host);
  } catch { /* The SDK will report an invalid base URL with full context. */ }
};

const generateVertex = async (cfg: ImageConfig, prompt: string, imagePaths: string[], aspectRatio?: string): Promise<Buffer> => {
  const client = vertexClient(cfg);
  registerProxyHost(cfg.base_url || "https://zenmux.ai/api/vertex-ai");
  const refs = await Promise.all(imagePaths.map(async (imagePath, index) => Object.assign(new RawReferenceImage(), {
    referenceId: index + 1,
    referenceImage: {imageBytes: (await compressImage(imagePath)).toString("base64"), mimeType: "image/png"},
  })));
  const config: any = {
    numberOfImages: 1,
    outputMimeType: "image/png",
    ...(aspectRatio ? {aspectRatio} : {}),
    httpOptions: {extraBody: {imageSize: ASPECT_TO_SIZE[aspectRatio || ""] || "1k"}},
  };
  const response: any = await (imagePaths.length
    ? client.models.editImage({model: cfg.model, prompt: appendAspectInstruction(prompt, aspectRatio), referenceImages: refs, config})
    : client.models.generateImages({model: cfg.model, prompt: appendAspectInstruction(prompt, aspectRatio), config}));
  const encoded = response?.generatedImages?.[0]?.image?.imageBytes;
  if (!encoded) throw new Error("no generated_images in Vertex response");
  return Buffer.from(encoded, "base64");
};

const generateGemini = async (cfg: ImageConfig, prompt: string, imagePaths: string[], aspectRatio?: string): Promise<Buffer> => {
  const contents: any[] = [];
  for (const imagePath of imagePaths) contents.push(createPartFromBase64((await fs.readFile(imagePath)).toString("base64"), "image/png"));
  contents.push(appendAspectInstruction(prompt, aspectRatio));
  registerProxyHost(cfg.base_url || "https://zenmux.ai/api/vertex-ai");
  const response: any = await vertexClient(cfg).models.generateContent({
    model: "google/gemini-3.1-flash-lite-image",
    contents,
    config: {responseModalities: ["TEXT", "IMAGE"], ...(aspectRatio ? {imageConfig: {aspectRatio}} : {})},
  });
  for (const part of response?.candidates?.[0]?.content?.parts || []) {
    if (part?.inlineData?.data) return Buffer.from(part.inlineData.data, "base64");
  }
  throw new Error(`no image in Gemini response: ${JSON.stringify(response?.promptFeedback || "empty candidates/content").slice(0, 300)}`);
};

const isSafetyRejection = (error: unknown): boolean => /rejected by the safety system|safety_violations/i.test(String(error));

const softenPrompt = async (prompt: string, rejectionInfo: string): Promise<string> => {
  const cfg = JSON.parse(await fs.readFile(path.join(configDir(), "config.json"), "utf8")) as Record<string, any>;
  const client = new OpenAI({
    apiKey: cfg.api_key,
    baseURL: cfg.base_url || "https://zenmux.ai/api/v1",
    timeout: cfg.timeout_ms ?? 300_000,
    maxRetries: 1,
    fetch: fetchWithEnvironmentProxy,
  });
  const response = await client.chat.completions.create({
    model: cfg.model || "anthropic/claude-sonnet-4.6",
    max_tokens: cfg.max_tokens || 128_000,
    messages: [
      {role: "system", content: SOFTEN_SYSTEM},
      {role: "user", content: `原提示词：\n${prompt}\n\n被拒原因：\n${rejectionInfo}\n\n请输出软化后的提示词：`},
    ],
  });
  let value = response.choices[0]?.message?.content?.trim() || "";
  if (value.includes("```")) value = (value.split("```")[1] || value).replace(/^\s*(?:text|plain)\s*/i, "").trim();
  if (!value) throw new Error("softenPrompt 返回空");
  return value;
};

export async function generateImage(prompt: string, outputPath: string, images: string[] = [], aspectRatio?: string): Promise<string> {
  const cfg = await readConfig();
  await fs.mkdir(path.dirname(outputPath), {recursive: true});
  let currentPrompt = prompt;
  let softened = 0;
  let attempts = 0;
  let lastError = "";
  while (attempts < MAX_RETRIES) {
    try {
      const format = cfg.api_format || (cfg.base_url?.includes("vertex-ai") ? "vertex" : "openai");
      const bytes = format === "vertex"
        ? await generateVertex(cfg, currentPrompt, images, aspectRatio)
        : await generateOpenAi(cfg, currentPrompt, images, aspectRatio);
      await validateGeneratedImage(bytes);
      await fs.writeFile(outputPath, bytes);
      return outputPath;
    } catch (error) {
      lastError = String(error);
      if (isSafetyRejection(error) && softened < SOFTEN_MAX) {
        currentPrompt = await softenPrompt(currentPrompt, lastError.slice(-1500));
        softened += 1;
        continue;
      }
      attempts += 1;
      if (attempts < MAX_RETRIES) await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
  try {
    const bytes = await generateGemini(cfg, currentPrompt, images, aspectRatio);
    await validateGeneratedImage(bytes);
    await fs.writeFile(outputPath, bytes);
    return outputPath;
  } catch (error) {
    throw new Error(`gpt-image-2 与 Gemini 均失败（提示词软化 ${softened} 档）。Gemini 错误: ${String(error)}；主路径: ${lastError}`);
  }
}
