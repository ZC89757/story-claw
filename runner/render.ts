/**
 * render.ts — 分镜渲染阶段
 *
 * 输入：storyboard_{场景名}.jsonl
 * 输出：render_{场景名}/final.mp4（已合并 TTS 音频）
 *
 * 流程：
 *   1. 解析 JSONL → groups
 *   2. 视频管线 + TTS 管线 并行启动
 *      视频：顺序处理 groups（组内 panels 并行生视频）→ _video_only.mp4
 *      TTS ：Phase1 标注 → Phase2 分配音色 → Phase3 并行合成 → Phase4 拼接 → _tts.mp3
 *   3. 合并：以 TTS 音频时长为准，缩放视频速度 → final.mp4
 */

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CONFIG_DIR } from "../utils/run-python.js";
import { novelPaths } from "../utils/paths.js";
import type { NovelSelection } from "../ui/select.js";

const execFileAsync = promisify(execFile);

// ── 渲染日志（同时写文件）────────────────────────────────────────────────────

let _logStream: fsSync.WriteStream | null = null;

export function initRenderLog(logPath: string) {
  fsSync.mkdirSync(path.dirname(logPath), { recursive: true });
  _logStream = fsSync.createWriteStream(logPath, { flags: "w" });
  _logStream.write(`渲染开始 ${new Date().toLocaleString()}\n${"=".repeat(60)}\n`);

  const origLog   = console.log.bind(console);
  const origError = console.error.bind(console);

  const ts = () => {
    const d = new Date();
    return `[${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}:${String(d.getSeconds()).padStart(2,"0")}]`;
  };

  console.log = (...args: any[]) => {
    origLog(...args);
    _logStream?.write(ts() + " " + args.map(String).join(" ") + "\n");
  };
  console.error = (...args: any[]) => {
    origError(...args);
    _logStream?.write(ts() + " [ERROR] " + args.map(String).join(" ") + "\n");
  };
}

// ── 配置加载 ──────────────────────────────────────────────────────────────────

function loadConfig(name: string): any {
  const p = path.join(CONFIG_DIR, name);
  if (!fsSync.existsSync(p)) throw new Error(`配置文件不存在: ${p}`);
  return JSON.parse(fsSync.readFileSync(p, "utf-8"));
}

const imgCfg = loadConfig("image_gen_config.json");
const vidCfg = loadConfig("video_config.json");
const llmCfg = loadConfig("config.json");
const ttsCfg = loadConfig("tts_config.json");

// 图片生成（Google Imagen via vertex-ai proxy）
const IMAGE_API_KEY  = imgCfg.api_key as string;
const IMAGE_BASE_URL = (imgCfg.base_url ?? "https://zenmux.ai/api/vertex-ai") as string;
const IMAGE_MODEL    = (imgCfg.model   ?? "openai/gpt-image-2") as string;
const IMAGE_CONCURRENCY = (imgCfg.concurrency ?? 4) as number;
const IMAGE_MAX_RETRIES = 5;
const IMAGE_RETRY_SLEEP = 3000; // ms

// 视频生成
const VIDEO_API_KEY  = vidCfg.api_key as string;
const VIDEO_BASE_URL = (vidCfg.base_url ?? "https://zenmux.ai/api/vertex-ai") as string;
const VIDEO_MODELS   = (vidCfg.models ?? [
  "google/veo-3.1-lite-generate-001",
]) as string[];
const VIDEO_DEFAULT_DURATION = (vidCfg.default_duration ?? 4) as number;
const VIDEO_CONCURRENCY      = (vidCfg.concurrency ?? 4) as number;
const VIDEO_MAX_RETRIES      = 3;
const VIDEO_RETRY_SLEEP      = 5000; // ms
const VIDEO_MODEL_DURATIONS: Record<string, number[]> = {
  "google/veo-3.1-lite-generate-001": [4, 6, 8],
};
const VIDEO_FALLBACK_MODEL      = "alibaba/happyhorse-1.0";
const MAX_REPHRASE_PRIMARY      = 5;  // 超过此次数切换备用模型
const MAX_REPHRASE_FALLBACK     = 3;  // 备用模型再超过此次数抛 FatalRenderError

/** 内容违规无法解决时抛出，会终止整个工作流 */
export class FatalRenderError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "FatalRenderError";
  }
}
// LLM（资源选择）
const LLM_API_KEY    = llmCfg.api_key as string;
const LLM_BASE_URL   = (llmCfg.base_url  ?? "https://zenmux.ai/api/v1") as string;
const LLM_MODEL      = (llmCfg.model     ?? "anthropic/claude-sonnet-4.6") as string;
const LLM_TIMEOUT_MS  = (llmCfg.timeout_ms  ?? 300_000) as number;
const LLM_MAX_TOKENS  = (llmCfg.max_tokens  ?? 128_000) as number;

// TTS（MiMo）
const MIMO_API_KEY    = ttsCfg.api_key as string;
const MIMO_BASE_URL   = (ttsCfg.base_url   ?? "https://token-plan-cn.xiaomimimo.com/v1") as string;
const MIMO_TTS_MODEL  = (ttsCfg.tts_model  ?? "mimo-v2.5-tts") as string;
const MIMO_VOICES     = (ttsCfg.voices     ?? { "冰糖": "女", "茉莉": "女", "苏打": "男", "白桦": "男" }) as Record<string, string>;
const MIMO_NARRATOR   = (ttsCfg.narrator_voice ?? "白桦") as string;
const TTS_CONCURRENCY = (ttsCfg.concurrency ?? 4) as number;

// ── 动态导入（避免 top-level import 拖慢启动）────────────────────────────────



async function getVideoGenAI() {
  const { GoogleGenAI } = await import("@google/genai");
  return new GoogleGenAI({ apiKey: VIDEO_API_KEY, vertexai: true, httpOptions: { baseUrl: VIDEO_BASE_URL, apiVersion: "v1" } });
}

async function getOpenAI(apiKey: string, baseUrl: string) {
  const { default: OpenAI } = await import("openai");
  return new OpenAI({ apiKey, baseURL: baseUrl, timeout: LLM_TIMEOUT_MS, maxRetries: 1 });
}

// ── 工具函数 ───────────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function clampDuration(model: string, duration: number): number {
  const supported = VIDEO_MODEL_DURATIONS[model];
  if (!supported) return duration;
  return supported.reduce((best, d) => Math.abs(d - duration) < Math.abs(best - duration) ? d : best);
}

function isContentPolicyError(err: unknown): boolean {
  const msg = String(err);
  return msg.includes("violate") || msg.includes("could not be submitted") || msg.includes("usage guidelines");
}

const REPHRASE_SYSTEM = `你是视频提示词微调专家。
视频生成 prompt 因触发内容审核被拒绝，请对 prompt 进行最小幅度的微调：
- 将可能触发审核的词替换为同义词或更间接的表达
- 保持原有句式结构和画面描述，只换词不改意
- 保持英文
- 只输出微调后的 prompt，不要输出任何其他内容`;

/** ffprobe 获取媒体时长（秒） */
async function getMediaDuration(filePath: string): Promise<number> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", filePath,
  ]);
  return parseFloat(stdout.trim());
}

/** ffmpeg 拼接视频（同目录，用相对路径规避中文路径问题） */
async function concatVideos(videoPaths: string[], output: string): Promise<void> {
  const outDir = path.dirname(output);
  const listFile = path.join(outDir, `_concat_${path.basename(output, ".mp4")}.txt`);
  const lines = videoPaths.map((p) => `file '${path.basename(p)}'`).join("\n");
  await fs.writeFile(listFile, lines, "utf-8");

  await execFileAsync("ffmpeg", [
    "-y", "-f", "concat", "-safe", "0",
    "-i", path.basename(listFile),
    "-c:v", "copy",
    "-c:a", "aac", "-ar", "44100", "-ac", "2",
    path.basename(output),
  ], { cwd: outDir });

  await fs.unlink(listFile).catch(() => {});
}

/** ffmpeg 提取视频最后一帧 */
async function extractLastFrame(videoPath: string, outputPng: string): Promise<boolean> {
  try {
    await execFileAsync("ffmpeg", [
      "-y", "-sseof", "-0.5",
      "-i", path.basename(videoPath),
      "-frames:v", "1",
      path.basename(outputPng),
    ], { cwd: path.dirname(videoPath) });
    return fsSync.existsSync(outputPng);
  } catch {
    return false;
  }
}

/** ffmpeg 合并：缩放视频速度使时长与音频匹配 */
async function mergeVideoAudio(videoPath: string, audioPath: string, outputPath: string): Promise<void> {
  const videoDur = await getMediaDuration(videoPath);
  const audioDur = await getMediaDuration(audioPath);
  const ratio    = audioDur / videoDur;
  console.log(`[合并] 视频 ${videoDur.toFixed(1)}s  音频 ${audioDur.toFixed(1)}s  速度 ×${ratio.toFixed(3)}`);

  await execFileAsync("ffmpeg", [
    "-y",
    "-i", videoPath,
    "-i", audioPath,
    "-filter:v", `setpts=${ratio.toFixed(6)}*PTS`,
    "-map", "0:v", "-map", "1:a",
    "-c:v", "libx264", "-preset", "fast", "-crf", "18",
    "-c:a", "aac", "-b:a", "192k",
    "-shortest",
    outputPath,
  ]);
  console.log(`[合并] 完成 → ${path.basename(outputPath)}`);
}

// ── 资源目录构建 ──────────────────────────────────────────────────────────────

interface ResourceCatalog {
  text: string;
  pathMap: Map<string, string>; // display-path → absolute-path
}

async function buildResourceCatalog(workspaceDir: string): Promise<ResourceCatalog> {
  const charsDir  = path.join(workspaceDir, "characters");
  const scenesDir = path.join(workspaceDir, "scenes");
  const lines: string[] = [];
  const pathMap = new Map<string, string>();

  lines.push("== 可用角色资源 ==");
  for (const file of (await fs.readdir(charsDir).catch(() => [])).filter((f) => f.endsWith(".json"))) {
    try {
      const data = JSON.parse(await fs.readFile(path.join(charsDir, file), "utf-8"));
      const name = data.name ?? path.basename(file, ".json");
      const protoPng = path.join(charsDir, `${name}_原型.png`);
      if (fsSync.existsSync(protoPng)) {
        lines.push(`路径: ${protoPng}`);
        lines.push(`  描述: ${name} 原型 — ${data.base_prompt ?? ""}`);
        pathMap.set(protoPng, protoPng);
      }
      for (const st of (data.stages ?? [])) {
        const stagePng = path.join(charsDir, `${name}_${st.stage}.png`);
        if (fsSync.existsSync(stagePng)) {
          lines.push(`路径: ${stagePng}`);
          lines.push(`  描述: ${name} 造型/${st.stage} — ${st.prompt ?? ""}`);
          pathMap.set(stagePng, stagePng);
        }
      }
    } catch { /* 跳过解析失败 */ }
  }

  lines.push("");
  lines.push("== 可用场景资源 ==");
  for (const file of (await fs.readdir(scenesDir).catch(() => [])).filter((f) => f.endsWith(".json"))) {
    try {
      const data = JSON.parse(await fs.readFile(path.join(scenesDir, file), "utf-8"));
      const loc = data.location ?? path.basename(file, ".json");
      const basePng = path.join(scenesDir, `${loc}.png`);
      if (fsSync.existsSync(basePng)) {
        const softDesc = Object.entries(data.soft_scenes ?? {}).map(([k, v]) => `${k}: ${v}`).join("  ");
        lines.push(`路径: ${basePng}`);
        lines.push(`  描述: ${loc} — ${data.base_prompt ?? ""}  ${softDesc}`);
        pathMap.set(basePng, basePng);
      }
    } catch { /* 跳过 */ }
  }

  return { text: lines.join("\n"), pathMap };
}

// ── LLM：资源选择 + image_prompt 微调 ────────────────────────────────────────

const RESOURCE_SELECTOR_SYSTEM = `你是分镜资源选择专员。根据 panel 信息和可用资源，选出最合适的参考图列表，并微调生图提示词。

规则：
1. 从资源目录中选出与 panel 相关的角色图和场景图
2. 景别决定选图策略：
   - 特写 / 近景：优先选角色图（面部细节重要），场景图可省略
   - 中景：角色图 + 场景图
   - 全景 / 远景：场景图为主，角色图可选
3. 「完整场景上下文」字段提供了本场景的全部原文，用于判断人物当前处于剧情的哪个阶段（如入学、受伤、变装等），
   「当前原文」字段是本 panel 对应的那句话。根据完整上下文选择与当前剧情阶段匹配的角色造型图
4. 角色造型图优先于原型图（如有与当前剧情匹配的造型阶段）
5. 改写 image_prompt：将原提示词中对人物外貌的文字描述替换为 "the person in image N"，
   对场景/背景的文字描述替换为 "the background in image N"（N 从 1 开始，与 reference_images 顺序一致）
   保留所有动作、姿态、情绪、景别、光影等描述
6. 若无合适资源，reference_images 输出空数组，image_prompt 保持原文不变
7. 只做微调补充，不大幅改写原有 image_prompt 的内容和结构
8. 若有上一 panel 上下文：根据其信息，确保空间布局、人物位置、动作方向自然衔接

reference_images 中每项必须包含资源目录里"路径:"后面的完整路径字符串（不得修改）和 role 字段。

只输出 JSON，不要任何其他文字：
{
  "reference_images": [
    {"path": "完整路径", "role": "主体角色"},
    {"path": "完整路径", "role": "背景场景"}
  ],
  "image_prompt": "改写后的生图提示词"
}`;

interface SelectResult {
  refPaths: string[];
  imagePrompt: string;
}

async function selectResources(
  panel: any,
  catalog: ResourceCatalog,
  currentText: string,
  prevContext: any | null,
  fullSceneText: string,
): Promise<SelectResult> {
  const client = await getOpenAI(LLM_API_KEY, LLM_BASE_URL);
  const parts = [
    "== panel 信息 ==",
    `shot_type: ${panel.shot_type ?? ""}`,
    `image_prompt: ${panel.image_prompt ?? ""}`,
  ];
  if (currentText) parts.push(`当前原文: ${currentText}`);
  if (fullSceneText) parts.push(`\n== 完整场景上下文 ==\n${fullSceneText}`);
  if (prevContext) {
    parts.push("\n== 上一 panel 上下文 ==");
    parts.push(`shot_type: ${prevContext.shot_type ?? ""}`);
    parts.push(`image_prompt: ${prevContext.image_prompt ?? ""}`);
    parts.push(`video_prompt: ${prevContext.video_prompt ?? ""}`);
  }
  parts.push(`\n${catalog.text}`);

  let resp: any;
  try {
    resp = await client.chat.completions.create({
      model: LLM_MODEL,
      max_tokens: LLM_MAX_TOKENS,
      messages: [
        { role: "system", content: RESOURCE_SELECTOR_SYSTEM },
        { role: "user",   content: parts.join("\n") },
      ],
      temperature: 0,
    });
  } catch (e: any) {
    console.error(
      `[selectResources] LLM 调用失败`,
      `type=${e?.constructor?.name}`,
      `status=${e?.status ?? "-"}`,
      `cause=${e?.cause?.code ?? e?.cause?.message ?? "-"}`,
      `msg=${e?.message}`,
    );
    throw e;
  }

  let raw = resp.choices[0].message.content?.trim() ?? "{}";
  if (raw.includes("```")) {
    raw = raw.split("```")[1];
    if (raw.startsWith("json")) raw = raw.slice(4);
  }
  const result = JSON.parse(raw.trim());
  const refsRaw: any[] = result.reference_images ?? [];
  const refPaths = refsRaw
    .map((item) => (typeof item === "object" ? item.path : item) as string)
    .filter((p) => {
      const abs = catalog.pathMap.get(p);
      if (abs && fsSync.existsSync(abs)) return true;
      console.log(`    [资源] 找不到: ${p}，跳过`);
      return false;
    })
    .map((p) => catalog.pathMap.get(p)!);

  return {
    refPaths,
    imagePrompt: result.image_prompt ?? (panel.image_prompt as string),
  };
}

// ── 图片生成 ──────────────────────────────────────────────────────────────────

async function generateImage(
  imgSem: Semaphore,
  prompt: string,
  refPaths: string[],
  outputPath: string,
): Promise<void> {
  await imgSem.acquire();
  try {
    console.log(`    [生图] 提交: ${path.basename(outputPath)}（参考图 ${refPaths.length} 张）`);
    let lastErr: unknown;

    for (let attempt = 1; attempt <= IMAGE_MAX_RETRIES; attempt++) {
      try {
        let resp: Response;
        if (refPaths.length > 0) {
          const form = new FormData();
          form.append("model", IMAGE_MODEL);
          form.append("prompt", prompt);
          form.append("n", "1");
          for (const p of refPaths) {
            const blob = new Blob([await fs.readFile(p)], { type: "image/png" });
            form.append("image[]", blob, path.basename(p));
          }
          resp = await fetch(`${IMAGE_BASE_URL}/images/edits`, {
            method: "POST",
            headers: { "Authorization": `Bearer ${IMAGE_API_KEY}` },
            body: form,
          });
        } else {
          resp = await fetch(`${IMAGE_BASE_URL}/images/generations`, {
            method: "POST",
            headers: { "Authorization": `Bearer ${IMAGE_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({ model: IMAGE_MODEL, prompt, n: 1 }),
          });
        }

        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
        }
        const result: any = await resp.json();
        const b64 = result?.data?.[0]?.b64_json;
        if (!b64) throw new Error(`未收到图片数据: ${JSON.stringify(result).slice(0, 200)}`);

        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.writeFile(outputPath, Buffer.from(b64, "base64"));
        console.log(`    [生图] 已保存: ${path.basename(outputPath)}`);
        return;
      } catch (e) {
        lastErr = e;
        if (attempt < IMAGE_MAX_RETRIES) {
          console.log(`    [生图] 第 ${attempt} 次失败: ${e}，${IMAGE_RETRY_SLEEP / 1000}s 后重试...`);
          await sleep(IMAGE_RETRY_SLEEP);
        }
      }
    }
    throw new Error(`生图失败（${IMAGE_MAX_RETRIES}次）: ${path.basename(outputPath)}: ${lastErr}`);
  } finally {
    imgSem.release();
  }
}

// ── 视频生成 ──────────────────────────────────────────────────────────────────

async function tryGenerateVideo(
  model: string,
  imgBase64: string,
  prompt: string,
  outputPath: string,
  duration: number,
): Promise<void> {
  const ai = await getVideoGenAI();
  const op = await (ai.models as any).generateVideos({
    model,
    prompt,
    image: { imageBytes: imgBase64, mimeType: "image/png" },
    config: { aspectRatio: "16:9", resolution: "1080p", durationSeconds: duration },
  });

  console.log(`    [视频] operation=${op.name}，轮询中...`);
  let current = op;
  while (!current.done) {
    await sleep(15000);
    current = await (ai.operations as any).getVideosOperation({ operation: current });
  }
  if (current.error) throw new Error(`API 错误: ${JSON.stringify(current.error)}`);

  const videos = current.response?.generatedVideos;
  if (!videos?.length) {
    const rai = current.response?.raiMediaFilteredReasons;
    throw new Error(`未返回视频，RAI=${JSON.stringify(rai)}`);
  }

  let videoBytes: Buffer;
  const v = videos[0].video;
  if (v.videoBytes) {
    videoBytes = Buffer.from(v.videoBytes, "base64");
  } else if (v.uri) {
    const r = await fetch(v.uri);
    videoBytes = Buffer.from(await r.arrayBuffer());
  } else {
    throw new Error("无法提取视频数据");
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, videoBytes);
  console.log(`    [视频] 已保存: ${path.basename(outputPath)}`);
}

async function generateVideo(
  vidSem: Semaphore,
  imagePath: string,
  prompt: string,
  outputPath: string,
  duration: number = VIDEO_DEFAULT_DURATION,
): Promise<void> {
  await vidSem.acquire();
  try {
    let currentModel  = VIDEO_MODELS[0];
    let clamped       = clampDuration(currentModel, duration);
    const imgBase64   = (await fs.readFile(imagePath)).toString("base64");
    if (clamped !== duration)
      console.log(`    [视频] ${currentModel} 不支持 ${duration}s，调整为 ${clamped}s`);
    console.log(`    [视频] 提交: ${path.basename(outputPath)}（${clamped}s, ${currentModel}）`);

    // 内容违规改写状态（懒创建）
    let currentPrompt = prompt;
    let llmClient: Awaited<ReturnType<typeof getOpenAI>> | null = null;
    let rephraseHistory: { role: string; content: string }[] = [];
    let rephraseCount = 0;   // 内容违规微调总次数（跨模型累计）
    let regularErrors = 0;

    while (true) {
      try {
        await tryGenerateVideo(currentModel, imgBase64, currentPrompt, outputPath, clamped);
        return; // 成功

      } catch (e) {
        if (isContentPolicyError(e)) {
          rephraseCount++;

          // 超过主模型限额 → 切备用模型（只切一次）
          if (rephraseCount === MAX_REPHRASE_PRIMARY + 1) {
            currentModel = VIDEO_FALLBACK_MODEL;
            clamped      = clampDuration(currentModel, duration);
            console.log(`    [视频] 主模型微调 ${MAX_REPHRASE_PRIMARY} 次仍违规，切换备用模型: ${currentModel}`);
          }

          // 超过总限额（主 + 备用）→ 抛 FatalRenderError
          if (rephraseCount > MAX_REPHRASE_PRIMARY + MAX_REPHRASE_FALLBACK) {
            throw new FatalRenderError(
              `视频内容违规无法解决（共微调 ${rephraseCount - 1} 次）: ${path.basename(outputPath)}`,
            );
          }

          // LLM 微调 prompt
          if (!llmClient) llmClient = await getOpenAI(LLM_API_KEY, LLM_BASE_URL);

          if (rephraseHistory.length === 0) {
            rephraseHistory = [
              { role: "system", content: REPHRASE_SYSTEM },
              { role: "user",   content: `原 prompt：\n${currentPrompt}\n\n拒绝原因：${String(e)}\n\n请微调：` },
            ];
          } else {
            rephraseHistory.push({
              role: "user",
              content: `上次微调的 prompt 也被拒绝，原因：${String(e)}。请再换几个词试试：`,
            });
          }

          const resp = await llmClient.chat.completions.create({
            model: LLM_MODEL,
            max_tokens: LLM_MAX_TOKENS,
            temperature: 0.7,
            messages: rephraseHistory as any,
          });
          const rephrased = resp.choices[0].message.content?.trim() ?? currentPrompt;
          rephraseHistory.push({ role: "assistant", content: rephrased });

          const modelTag = currentModel === VIDEO_FALLBACK_MODEL ? `[备用] ` : "";
          console.log(`    [视频] ${modelTag}内容违规，第 ${rephraseCount} 次微调: ${rephrased.slice(0, 80)}...`);
          currentPrompt = rephrased;

        } else {
          // 其他错误（网络、人脸拦截等）：限次重试后抛异常
          regularErrors++;
          if (regularErrors < VIDEO_MAX_RETRIES) {
            console.log(`    [视频] 第 ${regularErrors} 次失败: ${e}，${VIDEO_RETRY_SLEEP / 1000}s 后重试...`);
            await sleep(VIDEO_RETRY_SLEEP);
          } else {
            throw new Error(`视频生成失败（${VIDEO_MAX_RETRIES}次）: ${path.basename(outputPath)}: ${e}`);
          }
        }
      }
    }
  } finally {
    vidSem.release();
  }
}

// ── Semaphore ─────────────────────────────────────────────────────────────────

class Semaphore {
  private count: number;
  private queue: Array<() => void> = [];

  constructor(n: number) { this.count = n; }

  acquire(): Promise<void> {
    if (this.count > 0) { this.count--; return Promise.resolve(); }
    return new Promise((resolve) => this.queue.push(resolve));
  }

  release(): void {
    const next = this.queue.shift();
    if (next) { next(); } else { this.count++; }
  }
}

// ── 处理单个 group ────────────────────────────────────────────────────────────

async function processGroup(
  imgSem: Semaphore,
  vidSem: Semaphore,
  outputDir: string,
  catalog: ResourceCatalog,
  groupIdx: number,
  group: any,
  prevPanelContext: any | null,
  videoEvents: Map<string, { resolve: () => void; promise: Promise<void> }>,
  prevGroupLastPanelKey: string | null,
  fullSceneText: string,
): Promise<{ groupVideo: string | null; lastPanelContext: any | null }> {
  const panels      = group.panels ?? [];
  const currentText = group.text ?? "";
  const vidPath  = path.join(outputDir, `g${String(groupIdx).padStart(2, "0")}.mp4`);

  console.log(`\n[group ${String(groupIdx).padStart(2, "0")}] ${panels.length} 个 panel，顺序处理...`);

  // ── 顺序处理每个 panel：资源选择 + 生图 ──
  const imgPaths: Array<string | null> = [];
  const videoPrompts: string[] = [];
  let prevCtx = prevPanelContext;

  for (let pi = 0; pi < panels.length; pi++) {
    const panel  = panels[pi];
    const prefix = `g${String(groupIdx).padStart(2, "0")}_p${String(pi).padStart(2, "0")}`;
    const imgPath = path.join(outputDir, `${prefix}.png`);
    const isCont  = panel.is_continuation === true;

    if (isCont) {
      console.log(`  [${prefix}] is_continuation=True，跳过生图`);
      imgPaths.push(null);
    } else if (fsSync.existsSync(imgPath)) {
      console.log(`  [${prefix}] 图片已存在，跳过生图`);
      imgPaths.push(imgPath);
    } else {
      console.log(`  [${prefix}] 资源选择...`);
      const { refPaths, imagePrompt } = await selectResources(panel, catalog, currentText, prevCtx, fullSceneText);
      console.log(`  [${prefix}] 参考图: ${refPaths.map((p) => path.basename(p))}`);
      await generateImage(imgSem, imagePrompt, refPaths, imgPath);
      imgPaths.push(imgPath);
    }

    const videoPrompt = `${(panel.video_prompt ?? "").trimEnd()} No background music or ambient sound.`;
    videoPrompts.push(videoPrompt);
    prevCtx = { shot_type: panel.shot_type, image_prompt: panel.image_prompt, video_prompt: videoPrompt };
  }

  const lastPanelContext = prevCtx;

  // ── 检查 group 视频是否已存在 ──
  if (fsSync.existsSync(vidPath)) {
    console.log(`\n[group ${String(groupIdx).padStart(2, "0")}] 视频已存在，跳过`);
    for (let pi = 0; pi < panels.length; pi++) {
      const key = `${groupIdx},${pi}`;
      videoEvents.get(key)?.resolve();
    }
    return { groupVideo: vidPath, lastPanelContext };
  }

  // ── 为本 group 所有 panel 预创建 event ──
  for (let pi = 0; pi < panels.length; pi++) {
    const key = `${groupIdx},${pi}`;
    if (!videoEvents.has(key)) {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => { resolve = r; });
      videoEvents.set(key, { resolve, promise });
    }
  }

  console.log(`  [group ${String(groupIdx).padStart(2, "0")}] 并行生成 ${panels.length} 个 panel 视频...`);

  // ── 并行生成 panel 视频 ──
  const panelVidTasks = panels.map(async (panel: any, pi: number): Promise<string | null> => {
    const prefix       = `g${String(groupIdx).padStart(2, "0")}_p${String(pi).padStart(2, "0")}`;
    const panelVidPath = path.join(outputDir, `${prefix}.mp4`);
    const key          = `${groupIdx},${pi}`;

    try {
      if (fsSync.existsSync(panelVidPath)) {
        console.log(`    [视频] ${prefix}.mp4 已存在，跳过`);
        return panelVidPath;
      }

      const isCont = panel.is_continuation === true;
      let actualImg = imgPaths[pi];

      if (isCont) {
        // 等待前驱视频完成
        let prevKey: string | null = null;
        if (pi > 0) {
          prevKey = `${groupIdx},${pi - 1}`;
        } else if (groupIdx > 0) {
          prevKey = prevGroupLastPanelKey;
        }

        if (prevKey && videoEvents.has(prevKey)) {
          console.log(`    [${prefix}] continuation: 等待 ${prevKey.replace(",", "_p").replace(/^(\d+)/, "g$1")} 视频完成...`);
          await videoEvents.get(prevKey)!.promise;
          const [pg, pp] = prevKey.split(",").map(Number);
          const prevVid   = path.join(outputDir, `g${String(pg).padStart(2, "0")}_p${String(pp).padStart(2, "0")}.mp4`);
          const lastFrame = path.join(outputDir, `g${String(pg).padStart(2, "0")}_p${String(pp).padStart(2, "0")}_lastframe.png`);
          if (fsSync.existsSync(prevVid) && (fsSync.existsSync(lastFrame) || await extractLastFrame(prevVid, lastFrame))) {
            actualImg = lastFrame;
            console.log(`    [${prefix}] continuation: 使用 ${path.basename(lastFrame)} 作为参考图`);
          } else {
            console.log(`    [${prefix}] continuation: 提帧失败，跳过`);
            return null;
          }
        } else {
          console.log(`    [${prefix}] continuation: 无前驱，跳过`);
          return null;
        }
      }

      if (!actualImg || !fsSync.existsSync(actualImg)) {
        console.log(`    [${prefix}] 无参考图，跳过`);
        return null;
      }

      const duration = parseInt(panel.duration ?? VIDEO_DEFAULT_DURATION, 10);
      await generateVideo(vidSem, actualImg, videoPrompts[pi], panelVidPath, duration);
      return fsSync.existsSync(panelVidPath) ? panelVidPath : null;
    } catch (e) {
      if (e instanceof FatalRenderError) throw e;
      console.log(`    [视频] ${prefix} 失败: ${e}`);
      return null;
    } finally {
      videoEvents.get(key)?.resolve();
    }
  });

  const results = await Promise.all(panelVidTasks);
  const validPanelVids = results.filter((r): r is string => r !== null && fsSync.existsSync(r));

  if (validPanelVids.length === 0) {
    console.log(`  [group ${String(groupIdx).padStart(2, "0")}] 所有 panel 视频均失败，跳过`);
    return { groupVideo: null, lastPanelContext };
  }

  // 拼接 panel 视频 → group 视频
  if (validPanelVids.length === 1) {
    await fs.copyFile(validPanelVids[0], vidPath);
  } else {
    await concatVideos(validPanelVids, vidPath);
  }
  console.log(`  拼接完成: ${path.basename(vidPath)}`);
  return { groupVideo: vidPath, lastPanelContext };
}

// ── TTS 管线 ──────────────────────────────────────────────────────────────────

function extractCleanText(jsonlContent: string): string {
  const lines: string[] = [];
  for (const raw of jsonlContent.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    try {
      const group = JSON.parse(trimmed);
      const text = (group.text ?? "").replace(/【[^】]*】/g, "").trim();
      if (text) lines.push(text);
    } catch { /* 跳过 */ }
  }
  return lines.join("\n");
}

const TTS_ANNOTATE_SYSTEM = `你是剧本分析助手。将收到一段小说原文，请拆成连续的语音片段并标注。

规则：
- 旁白（第一/三人称叙述、心理描写、过渡）→ speaker="旁白", gender="男"
- 识别说话人：根据"XXX说：""XXX道：""XXX问："等模式或上下文推断
- 说话人引导语（如"学姐说："）归入紧前的旁白片段，不单独成片段
- style：描述该片段朗读时的情绪、语气、语速、节奏，中文，15～40字

输出严格 JSON 数组，不要任何其他文字：
[
  {"speaker": "旁白", "gender": "男", "text": "...", "style": "..."},
  {"speaker": "学姐", "gender": "女", "text": "...", "style": "..."}
]`;

const TTS_ASSIGN_SYSTEM = `你是声音分配助手。

规则：
- 已有 voice_map 中的角色：直接沿用，不可更改
- 新角色：从同性别声音中选一个，优先选还没被其他角色使用的；若都用过则复用

输出完整的 voice_map JSON 对象（含原有映射 + 新增），不要任何其他文字：
{"学姐": "冰糖", ...}`;

const TTS_AGENT_SYSTEM = `你是 TTS 合成助手。你会收到一个文本片段、已分配的声音和风格描述。
请调用 generate_tts 工具合成语音。
style_prompt 参数：根据风格描述，写一句简洁的朗读指令（中文，20字以内）。`;

const TTS_TOOL_DEF = {
  type: "function" as const,
  function: {
    name: "generate_tts",
    description: "调用 MiMo TTS API 合成语音",
    parameters: {
      type: "object",
      properties: {
        text:         { type: "string", description: "要合成的文本" },
        voice:        { type: "string", description: "声音名称" },
        style_prompt: { type: "string", description: "风格提示词（中文，20字以内）" },
      },
      required: ["text", "voice", "style_prompt"],
    },
  },
};

async function ttsPhase1Annotate(fullText: string): Promise<any[]> {
  console.log("[TTS Phase 1] LLM 标注文本片段...");
  const client = await getOpenAI(LLM_API_KEY, LLM_BASE_URL);
  const resp = await client.chat.completions.create({
    model: LLM_MODEL,
    max_tokens: LLM_MAX_TOKENS,
    messages: [
      { role: "system", content: TTS_ANNOTATE_SYSTEM },
      { role: "user",   content: fullText },
    ],
    temperature: 0.3,
  });
  let raw = resp.choices[0].message.content?.trim() ?? "[]";
  const m = raw.match(/\[[\s\S]*\]/);
  if (m) raw = m[0];
  const segments = JSON.parse(raw);
  console.log(`[TTS Phase 1] 共 ${segments.length} 个片段`);
  return segments;
}

async function ttsPhase2AssignVoices(segments: any[], voiceMap: Record<string, string>): Promise<Record<string, string>> {
  console.log("[TTS Phase 2] LLM 分配声音...");
  const client = await getOpenAI(LLM_API_KEY, LLM_BASE_URL);

  // 过滤掉旁白（由 config 固定，不交给 LLM 选择）
  const chars: Record<string, string> = {};
  for (const seg of segments) {
    if (seg.speaker !== "旁白" && !(seg.speaker in chars)) {
      chars[seg.speaker] = seg.gender;
    }
  }

  const userContent = [
    `当前 voice_map：\n${JSON.stringify(voiceMap, null, 2)}`,
    `可用声音（名称→性别）：\n${JSON.stringify(MIMO_VOICES)}`,
    `本次出现的角色（名称→性别，不含旁白）：\n${JSON.stringify(chars)}`,
  ].join("\n\n");

  const resp = await client.chat.completions.create({
    model: LLM_MODEL,
    max_tokens: LLM_MAX_TOKENS,
    messages: [
      { role: "system", content: TTS_ASSIGN_SYSTEM },
      { role: "user",   content: userContent },
    ],
    temperature: 0,
  });
  let raw = resp.choices[0].message.content?.trim() ?? "{}";
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) raw = m[0];
  const newMap = JSON.parse(raw);

  // 注入旁白（config 固定，不由 LLM 分配）
  newMap["旁白"] = MIMO_NARRATOR;

  console.log(`[TTS Phase 2] voice_map: ${JSON.stringify(newMap)}`);
  return newMap;
}

async function ttsExecApi(text: string, voice: string, stylePrompt: string, outputPath: string): Promise<void> {
  const payload = {
    model: MIMO_TTS_MODEL,
    messages: [
      { role: "user",      content: stylePrompt },
      { role: "assistant", content: text },
    ],
    audio:  { format: "mp3", voice },
    stream: false,
  };

  const resp = await fetch(`${MIMO_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "api-key": MIMO_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await resp.json() as any;
  if (data.error) throw new Error(`TTS API 错误: ${JSON.stringify(data.error)}`);
  const audioB64: string = data.choices[0].message.audio.data;
  await fs.writeFile(outputPath, Buffer.from(audioB64, "base64"));
}

async function ttsPhase3GenerateAll(segments: any[], voiceMap: Record<string, string>, tmpDir: string): Promise<string[]> {
  console.log(`[TTS Phase 3] 并发生成 ${segments.length} 个片段...`);
  await fs.mkdir(tmpDir, { recursive: true });

  const ttsSem = new Semaphore(TTS_CONCURRENCY);
  const client = await getOpenAI(LLM_API_KEY, LLM_BASE_URL);

  const tasks = segments.map(async (seg: any, i: number): Promise<string> => {
    const voice      = voiceMap[seg.speaker] ?? MIMO_NARRATOR;
    const outputPath = path.join(tmpDir, `seg_${String(i).padStart(3, "0")}.mp3`);

    await ttsSem.acquire();
    try {
      console.log(`  [TTS seg ${String(i).padStart(2, "0")}] [${seg.speaker}→${voice}] ${seg.text.slice(0, 35)}...`);

      const resp = await client.chat.completions.create({
        model: LLM_MODEL,
        max_tokens: LLM_MAX_TOKENS,
        messages: [
          { role: "system", content: TTS_AGENT_SYSTEM },
          { role: "user",   content: `文本：${seg.text}\n声音：${voice}\n风格描述：${seg.style}` },
        ],
        tools: [TTS_TOOL_DEF],
        tool_choice: "required",
      } as any);

      const msg = resp.choices[0].message;
      if (!msg.tool_calls?.length) throw new Error(`TTS seg ${i}: LLM 未调用工具`);
      const args = JSON.parse(msg.tool_calls[0].function.arguments);
      args.voice = voice; // 强制使用预分配声音

      await ttsExecApi(args.text, args.voice, args.style_prompt, outputPath);
      const size = Math.round(fsSync.statSync(outputPath).size / 1024);
      console.log(`  [TTS seg ${String(i).padStart(2, "0")}] 完成 → ${path.basename(outputPath)} (${size}KB)`);
      return outputPath;
    } finally {
      ttsSem.release();
    }
  });

  return Promise.all(tasks);
}

async function ttsPhase4Concat(audioFiles: string[], outputPath: string): Promise<void> {
  console.log(`[TTS Phase 4] 拼接 ${audioFiles.length} 个片段...`);
  const sorted   = [...audioFiles].sort();
  const listFile = outputPath.replace(/\.mp3$/, "_concat_list.txt");

  const lines = sorted.map((p) => `file '${p.replace(/\\/g, "/")}'`).join("\n");
  await fs.writeFile(listFile, lines, "utf-8");

  await execFileAsync("ffmpeg", [
    "-y", "-f", "concat", "-safe", "0",
    "-i", listFile,
    "-c:a", "libmp3lame", "-q:a", "2",
    outputPath,
  ]);
  await fs.unlink(listFile).catch(() => {});
  console.log(`[TTS Phase 4] 完成 → ${path.basename(outputPath)}`);
}

async function runTtsPipeline(
  jsonlContent: string,
  outputDir: string,
  voiceMapPath: string,
  sceneName: string,
): Promise<string> {
  const ttsOut = path.join(outputDir, `_tts_${sceneName}.mp3`);
  const tmpDir = path.join(outputDir, "tts_segments");

  let voiceMap: Record<string, string> = {};
  if (fsSync.existsSync(voiceMapPath)) {
    voiceMap = JSON.parse(await fs.readFile(voiceMapPath, "utf-8"));
    console.log(`[TTS] 载入 voice_map: ${JSON.stringify(voiceMap)}`);
  }

  const fullText = extractCleanText(jsonlContent);
  console.log(`[TTS] 提取文本 ${fullText.length} 字`);

  const segments = await ttsPhase1Annotate(fullText);
  voiceMap       = await ttsPhase2AssignVoices(segments, voiceMap);
  await fs.writeFile(voiceMapPath, JSON.stringify(voiceMap, null, 2), "utf-8");
  console.log(`[TTS] voice_map 已保存`);

  const audioFiles = await ttsPhase3GenerateAll(segments, voiceMap, tmpDir);
  await ttsPhase4Concat(audioFiles, ttsOut);
  return ttsOut;
}

// ── 主渲染函数（供 pipeline 调用）────────────────────────────────────────────

export interface RenderProgress {
  scene: string;
  done: number;
  total: number;
}

export interface SceneRenderResult {
  sceneName: string;
  videoOnly: string;  // _video_only.mp4
  ttsAudio:  string;  // _tts_{sceneName}.mp3
}

export async function renderScene(
  sel: NovelSelection,
  sceneName: string,
  onProgress?: (p: RenderProgress) => void,
): Promise<SceneRenderResult> {
  const ep           = sel.episode;
  const jsonlPath    = novelPaths.storyboardJsonl(sel.novelName, ep, sceneName);
  const outputDir    = novelPaths.renderDir(sel.novelName, ep, sceneName);
  const voiceMapPath = novelPaths.voiceMap(sel.novelName);
  const workspaceDir = novelPaths.workspaceDir(sel.novelName);

  await fs.mkdir(outputDir, { recursive: true });

  // 读取 JSONL
  const rawContent    = await fs.readFile(jsonlPath, "utf-8");
  const groups        = parseJsonl(rawContent);
  const fullSceneText = groups.map((g: any) => g.text ?? "").filter(Boolean).join("\n");
  console.log(`\n场景: ${sceneName}，共 ${groups.length} 个 group`);
  console.log(`输出目录: ${outputDir}`);

  onProgress?.({ scene: sceneName, done: 0, total: groups.length });

  // 资源目录
  const catalog = await buildResourceCatalog(workspaceDir);
  console.log(`资源目录已构建，共 ${catalog.pathMap.size} 个资源`);

  const imgSem     = new Semaphore(IMAGE_CONCURRENCY);
  const vidSem     = new Semaphore(VIDEO_CONCURRENCY);
  const videoEvents = new Map<string, { resolve: () => void; promise: Promise<void> }>();

  // ── 视频管线 + TTS 管线并行启动 ──
  const videoTask = (async (): Promise<string> => {
    const groupVideos: string[] = [];
    let prevPanelCtx: any | null = null;

    for (let i = 0; i < groups.length; i++) {
      const prevGroupLastPanelKey = i > 0
        ? `${i - 1},${(groups[i - 1].panels ?? []).length - 1}`
        : null;
      const { groupVideo, lastPanelContext } = await processGroup(
        imgSem, vidSem, outputDir, catalog,
        i, groups[i], prevPanelCtx, videoEvents, prevGroupLastPanelKey, fullSceneText,
      );
      if (groupVideo) groupVideos.push(groupVideo);
      prevPanelCtx = lastPanelContext;
      onProgress?.({ scene: sceneName, done: i + 1, total: groups.length });
    }

    const validVideos = groupVideos.filter((p) => fsSync.existsSync(p) && !p.includes("_FAILED"));
    console.log(`\n所有 ${validVideos.length} 个 group 视频生成完毕`);

    const videoOnly = path.join(outputDir, "_video_only.mp4");
    await concatVideos(validVideos, videoOnly);
    return videoOnly;
  })();

  const ttsTask = runTtsPipeline(rawContent, outputDir, voiceMapPath, sceneName);

  // ── 等待两个管线都完成 ──
  const [videoResult, ttsResult] = await Promise.allSettled([videoTask, ttsTask]);

  if (videoResult.status === "rejected") {
    console.error(`[${sceneName}] 视频管线失败: ${videoResult.reason}`);
    throw videoResult.reason;
  }
  if (ttsResult.status === "rejected") {
    console.error(`[${sceneName}] TTS 管线失败: ${ttsResult.reason}`);
    throw ttsResult.reason;
  }

  const videoOnlyPath = videoResult.value;
  const ttsPath       = ttsResult.value;

  console.log(`\n[场景完成] ${sceneName}  视频: ${path.basename(videoOnlyPath)}  音频: ${path.basename(ttsPath)}`);

  return { sceneName, videoOnly: videoOnlyPath, ttsAudio: ttsPath };
}

// ── 全局音视频对齐合并 ────────────────────────────────────────────────────────

const GLOBAL_VIDEO_SPEED_MIN = 0.5;
const GLOBAL_VIDEO_SPEED_MAX = 2.0;
const GLOBAL_AUDIO_SPEED_MIN = 0.7;
const GLOBAL_AUDIO_SPEED_MAX = 1.6;
const GLOBAL_AUDIO_WEIGHT    = 0.7;  // 音频承担 70% 的调整量

/**
 * 计算全局目标时长 T，使视频和音频相向调整后时长对齐。
 *
 * 加权几何均值：T = V^(1-w) × A^w   （w = GLOBAL_AUDIO_WEIGHT）
 * 音频权重越大，T 越偏向 V，音频被迫调整越多。
 *
 * 妥协策略（无截断）：
 *   1. 计算可行区间 [T_min, T_max]（同时满足视频和音频速度约束）
 *   2. 若 T_ideal 在区间内 → 直接用
 *      若 T_ideal 超出区间但区间存在 → 取最近边界
 *      若区间不存在（两个约束冲突）→ 加权折中两个边界，音频权重更大
 */
function computeAlignTarget(totalVideo: number, totalAudio: number): {
  T: number; videoSpeed: number; audioSpeed: number; note: string;
} {
  const V = totalVideo;
  const A = totalAudio;
  const w = GLOBAL_AUDIO_WEIGHT;

  // 加权几何均值（T 偏向 V，音频调整更多）
  const T_ideal = Math.pow(V, 1 - w) * Math.pow(A, w);

  // 可行区间
  const T_min = Math.max(V / GLOBAL_VIDEO_SPEED_MAX, A / GLOBAL_AUDIO_SPEED_MAX);
  const T_max = Math.min(V / GLOBAL_VIDEO_SPEED_MIN, A / GLOBAL_AUDIO_SPEED_MIN);

  let T: number;
  let note: string;

  if (T_min <= T_max) {
    // 区间存在 → 夹到可行范围
    T    = Math.min(Math.max(T_ideal, T_min), T_max);
    note = T === T_ideal
      ? "理想值可行"
      : `理想值 ${T_ideal.toFixed(1)}s 超出范围，夹到 [${T_min.toFixed(1)}, ${T_max.toFixed(1)}]`;
  } else {
    // 区间不存在（差距过大）→ 加权折中两个边界
    const T_a_edge = A / GLOBAL_AUDIO_SPEED_MAX;  // 音频贴着上限
    const T_v_edge = V / GLOBAL_VIDEO_SPEED_MIN;   // 视频贴着下限
    T    = w * T_a_edge + (1 - w) * T_v_edge;
    note = `约束冲突，加权折中 T_a_edge=${T_a_edge.toFixed(1)}s T_v_edge=${T_v_edge.toFixed(1)}s → ${T.toFixed(1)}s`;
  }

  const videoSpeed = V / T;
  const audioSpeed = A / T;

  return { T, videoSpeed, audioSpeed, note };
}

/**
 * 全局对齐：收集所有场景的视频和音频，统一调整速度后拼接为集视频。
 *
 * 步骤：
 *   1. 量取每个场景的视频/音频时长
 *   2. 用 computeAlignTarget 计算全局目标速度
 *   3. 对每个场景：用 ffmpeg 调整视频 setpts 和音频 atempo，输出临时文件
 *   4. ffmpeg concat 所有调整后的视频 → 合成视频
 *   5. ffmpeg concat 所有调整后的音频 → 合成音频
 *   6. ffmpeg mux 合成视频 + 合成音频 → 集最终 mp4
 */
export async function globalAlignAndMerge(
  results: SceneRenderResult[],
  orderedScenes: string[],
  episodeVideoPath: string,
  epDir: string,
): Promise<void> {
  if (results.length === 0) {
    console.log("[全局对齐] 无场景，跳过");
    return;
  }

  // 按 orderedScenes 排序，过滤掉缺失文件的场景
  const ordered = orderedScenes
    .map((name) => results.find((r) => r.sceneName === name))
    .filter((r): r is SceneRenderResult =>
      r !== undefined &&
      fsSync.existsSync(r.videoOnly) &&
      fsSync.existsSync(r.ttsAudio),
    );

  if (ordered.length === 0) {
    console.log("[全局对齐] 无有效场景文件，跳过");
    return;
  }

  // ── 量取时长 ──
  console.log("\n[全局对齐] 量取各场景时长...");
  const durations = await Promise.all(
    ordered.map(async (r) => ({
      sceneName: r.sceneName,
      video: await getMediaDuration(r.videoOnly),
      audio: await getMediaDuration(r.ttsAudio),
    })),
  );

  const totalVideo = durations.reduce((s, d) => s + d.video, 0);
  const totalAudio = durations.reduce((s, d) => s + d.audio, 0);

  console.log(`[全局对齐] 视频总时长: ${totalVideo.toFixed(1)}s`);
  console.log(`[全局对齐] 音频总时长: ${totalAudio.toFixed(1)}s`);
  for (const d of durations) {
    console.log(`  ${d.sceneName}: 视频 ${d.video.toFixed(1)}s  音频 ${d.audio.toFixed(1)}s`);
  }

  // ── 计算目标速度 ──
  const { T, videoSpeed, audioSpeed, note } = computeAlignTarget(totalVideo, totalAudio);
  console.log(`[全局对齐] 目标时长: ${T.toFixed(1)}s  视频速度: ×${videoSpeed.toFixed(3)}  音频速度: ×${audioSpeed.toFixed(3)}`);
  console.log(`[全局对齐] ${note}`);

  const tmpDir = path.join(epDir, "_align_tmp");
  await fs.mkdir(tmpDir, { recursive: true });

  // ── 调整每个场景的视频和音频 ──
  const adjustedVideos: string[] = [];
  const adjustedAudios: string[] = [];

  await Promise.all(ordered.map(async (r, i) => {
    const idx    = String(i).padStart(2, "0");
    const adjVid = path.join(tmpDir, `v${idx}_${r.sceneName}.mp4`);
    const adjAud = path.join(tmpDir, `a${idx}_${r.sceneName}.mp3`);

    // 视频调速：setpts=(1/speed)*PTS
    const ptsExpr = `${(1 / videoSpeed).toFixed(6)}*PTS`;
    await execFileAsync("ffmpeg", [
      "-y", "-i", r.videoOnly,
      "-filter:v", `setpts=${ptsExpr}`,
      "-c:v", "libx264", "-preset", "fast", "-crf", "18",
      "-an",
      adjVid,
    ]);

    // 音频调速：atempo（范围 0.5~2.0，本方案约束在 0.7~1.6 内，单个滤镜够用）
    await execFileAsync("ffmpeg", [
      "-y", "-i", r.ttsAudio,
      "-filter:a", `atempo=${audioSpeed.toFixed(6)}`,
      "-c:a", "libmp3lame", "-q:a", "2",
      adjAud,
    ]);

    adjustedVideos[i] = adjVid;
    adjustedAudios[i] = adjAud;
    console.log(`  [对齐] ${r.sceneName} 完成`);
  }));

  // ── concat 所有调整后的视频 ──
  const mergedVideo = path.join(tmpDir, "_merged_video.mp4");
  const mergedAudio = path.join(tmpDir, "_merged_audio.mp3");

  const vidListPath = path.join(tmpDir, "_vid_list.txt");
  const audListPath = path.join(tmpDir, "_aud_list.txt");

  await fs.writeFile(vidListPath, adjustedVideos.map((p) => `file '${p.replace(/\\/g, "/")}'`).join("\n"), "utf-8");
  await fs.writeFile(audListPath, adjustedAudios.map((p) => `file '${p.replace(/\\/g, "/")}'`).join("\n"), "utf-8");

  console.log("[全局对齐] 拼接视频...");
  await execFileAsync("ffmpeg", [
    "-y", "-f", "concat", "-safe", "0",
    "-i", vidListPath,
    "-c:v", "copy",
    mergedVideo,
  ]);

  console.log("[全局对齐] 拼接音频...");
  await execFileAsync("ffmpeg", [
    "-y", "-f", "concat", "-safe", "0",
    "-i", audListPath,
    "-c:a", "libmp3lame", "-q:a", "2",
    mergedAudio,
  ]);

  // ── mux 合并 ──
  console.log("[全局对齐] mux 合并视频+音频...");
  await execFileAsync("ffmpeg", [
    "-y",
    "-i", mergedVideo,
    "-i", mergedAudio,
    "-map", "0:v", "-map", "1:a",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
    "-shortest",
    episodeVideoPath,
  ]);

  // 清理临时目录
  await fs.rm(tmpDir, { recursive: true, force: true });

  console.log(`[全局对齐] 完成 → ${path.basename(episodeVideoPath)}`);
  console.log(`  视频总: ${totalVideo.toFixed(1)}s → 目标: ${T.toFixed(1)}s  视频×${videoSpeed.toFixed(3)} 音频×${audioSpeed.toFixed(3)}`);
}

// ── JSONL 解析（带容错）──────────────────────────────────────────────────────

function parseJsonl(content: string): any[] {
  // 替换中文弯引号
  const raw = content.replace(/\u201c/g, "\uff02").replace(/\u201d/g, "\uff02");
  const groups: any[] = [];
  const decoder = { pos: 0 };

  function skipWs() {
    while (decoder.pos < raw.length && /\s/.test(raw[decoder.pos])) decoder.pos++;
  }

  skipWs();
  while (decoder.pos < raw.length) {
    try {
      // 尝试用 JSON.parse 解析当前位置开始的对象
      const sub = raw.slice(decoder.pos);
      // 找到第一个完整的 JSON 对象
      let depth = 0, end = -1;
      for (let i = 0; i < sub.length; i++) {
        if (sub[i] === "{") depth++;
        else if (sub[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
      }
      if (end === -1) break;
      const chunk = sub.slice(0, end + 1);
      try {
        groups.push(JSON.parse(chunk));
      } catch {
        // 容错：只提取 panels 数组
        const m = chunk.match(/"panels"\s*:\s*(\[[\s\S]*?\])\s*}/);
        if (m) {
          try { groups.push({ panels: JSON.parse(m[1]) }); } catch { /* 跳过 */ }
        }
      }
      decoder.pos += end + 1;
    } catch {
      decoder.pos++;
    }
    skipWs();
  }
  return groups;
}
