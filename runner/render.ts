/**
 * render.ts — 分镜渲染阶段
 *
 * 输入：storyboard_{场景名}.jsonl
 * 输出：render_{场景名}/final.mp4（已合并 TTS 音频）
 *
 * 流程：
 *   1. 解析 JSONL → groups
 *   2. 视频管线 + TTS 管线 并行启动
 *      视频：所有 panels 并行（生图→生视频），continuation 通过 videoEvents 等待前驱 → _video_only.mp4
 *      TTS ：Phase1 标注 → Phase2 分配音色 → Phase3 并行合成 → Phase4 拼接 → _tts.mp3
 *   3. 合并：以 TTS 音频时长为准，缩放视频速度 → final.mp4
 */

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR } from "../utils/run-python.js";
import { novelPaths } from "../utils/paths.js";
import type { NovelSelection } from "../ui/select.js";

const RENDER_DIR = path.dirname(fileURLToPath(import.meta.url));

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

// 图片生成（gpt-image-gen.py via Vertex AI SDK）
const IMAGE_CONCURRENCY = (imgCfg.concurrency ?? 4) as number;
const IMAGE_MAX_RETRIES = 3;
const IMAGE_RETRY_SLEEP = 3000; // ms
const SOFTEN_MAX = 2; // 被内容安全系统拒绝时，提示词递进软化的最大档数

// 视频生成（ComfyUI）
const VIDEO_BASE_URL         = (vidCfg.base_url         ?? "http://127.0.0.1:8188") as string;
const VIDEO_WORKFLOW_PATH    = vidCfg.workflow_path as string;
const VIDEO_DEFAULT_DURATION = (vidCfg.default_duration ?? 4) as number;
const VIDEO_CONCURRENCY      = (vidCfg.concurrency      ?? 6) as number;
const VIDEO_MAX_RETRIES      = (vidCfg.max_retries      ?? 3) as number;
const VIDEO_RETRY_SLEEP      = (vidCfg.retry_sleep_ms   ?? 8000) as number;
const VIDEO_POLL_INTERVAL    = (vidCfg.poll_interval_ms ?? 5000) as number;

// workflow JSON 缓存（启动时加载一次）
let _workflowTemplate: any = null;
function getWorkflowTemplate(): any {
  if (!_workflowTemplate) {
    _workflowTemplate = JSON.parse(fsSync.readFileSync(VIDEO_WORKFLOW_PATH, "utf-8"));
  }
  return _workflowTemplate;
}

// LTX latent 时间维压缩因子：帧数必须为 LTX_FRAME_STEP·k + 1（模型架构属性，非可调参数）
const LTX_FRAME_STEP = 8;

// fps 的唯一真值来源：workflow 节点 320:300（同时驱动输出帧率与音频帧率）。
// 改帧率只需改这个节点，代码自动适配——切勿在别处硬编码 fps。
function getVideoFps(): number {
  return (getWorkflowTemplate()["320:300"].inputs.value as number) ?? 25;
}

// 目标时长（秒）→ LTX 合法帧数（最近的 LTX_FRAME_STEP·k+1，k≥1）。
// 输出时长 = 帧数 / fps，栅格步进 = LTX_FRAME_STEP / fps（25fps 时 0.32s）。
function durationToFrames(durSec: number, fps: number): number {
  const ideal = durSec * fps;
  const k = Math.max(1, Math.round((ideal - 1) / LTX_FRAME_STEP));
  return k * LTX_FRAME_STEP + 1;
}

// LLM（资源选择）
const LLM_API_KEY    = llmCfg.api_key as string;
const LLM_BASE_URL   = (llmCfg.base_url  ?? "https://zenmux.ai/api/v1") as string;
const LLM_MODEL      = (llmCfg.model     ?? "anthropic/claude-sonnet-4.6") as string;
const LLM_TIMEOUT_MS  = (llmCfg.timeout_ms  ?? 300_000) as number;
const LLM_MAX_TOKENS  = (llmCfg.max_tokens  ?? 128_000) as number;

// TTS（豆包 / 火山引擎 语音合成大模型 V3，HTTP Chunked 单向流式）
const DOUBAO_API_KEY     = ttsCfg.api_key as string;
const DOUBAO_BASE_URL    = (ttsCfg.base_url    ?? "https://openspeech.bytedance.com/api/v3/tts/unidirectional") as string;
const DOUBAO_RESOURCE_ID = (ttsCfg.resource_id ?? "seed-tts-1.0") as string;
const DOUBAO_VOICES      = (ttsCfg.voices ?? {
  "zh_male_jieshuonansheng_mars_bigtts": "男",
  "zh_male_qingcang_mars_bigtts": "男",
  "zh_male_silang_mars_bigtts": "男",
  "ICL_zh_male_badaozongcai_v1_tob": "男",
  "ICL_zh_male_lengmonanyou_tob": "男",
  "ICL_zh_male_wenrounanyou_tob": "男",
  "ICL_zh_male_shaonianjiangjun_tob": "男",
  "zh_female_gaolengyujie_moon_bigtts": "女",
  "zh_female_wuzetian_mars_bigtts": "女",
  "zh_female_gufengshaoyu_mars_bigtts": "女",
  "zh_female_wenroushunv_mars_bigtts": "女",
  "ICL_zh_female_bingjiaojiejie_tob": "女",
  "zh_female_yangmi_mars_bigtts": "女",
  "ICL_zh_female_wenrounvshen_239eff5e8ffa_tob": "女",
}) as Record<string, string>;
const DOUBAO_NARRATOR    = (ttsCfg.narrator_voice ?? "zh_male_changtianyi_mars_bigtts") as string;
const TTS_CONCURRENCY    = (ttsCfg.concurrency ?? 4) as number;
// 是否启用角色音色：关闭时音色照常分配，但 TTS 合成时全部强制用旁白音
const ASSIGN_CHARACTER_VOICE = (ttsCfg.assign_character_voice ?? true) as boolean;

// SFX（音效）：字级时间戳触发，叠进子片段音频层
const SFX_ENABLED = (ttsCfg.sfx_enabled ?? true) as boolean;
const SFX_VOLUME  = (ttsCfg.sfx_volume ?? 0.7) as number;   // 音效相对音量 0–1
const SFX_DIR     = path.join(CONFIG_DIR, "sfx");           // 全局音效库

// ── 动态导入（避免 top-level import 拖慢启动）────────────────────────────────

async function getOpenAI(apiKey: string, baseUrl: string) {
  const { default: OpenAI } = await import("openai");
  return new OpenAI({ apiKey, baseURL: baseUrl, timeout: LLM_TIMEOUT_MS, maxRetries: 1 });
}

// ── 工具函数 ───────────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 将 group 总时长均分给各 panel，返回分数秒（不取整、不设地板）。
 * 实际视频时长在 tryGenerateVideoComfyUI 里按 fps 吸附到 LTX 帧栅格，
 * 误差 ≤ 半个步进（25fps 时 ±0.16s），不再有 4s 地板撑长短组。
 */
function distributePanelDurations(groupDur: number, panels: any[]): number[] {
  const dur = groupDur / panels.length;
  return panels.map(() => dur);
}

/** ffprobe 获取媒体时长（秒） */
async function getMediaDuration(filePath: string): Promise<number> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", filePath,
  ]);
  return parseFloat(stdout.trim());
}

// ── 音效库（全局，扫 ~/.story-claw/sfx/）─────────────────────────────────────

/** 扫 SFX_DIR 下 *.mp3/*.wav，返回 tag（去扩展名文件名）→ 绝对路径。目录不存在返回空 Map。 */
export function loadSfxCatalog(): Map<string, string> {
  const catalog = new Map<string, string>();
  if (!fsSync.existsSync(SFX_DIR)) return catalog;
  for (const f of fsSync.readdirSync(SFX_DIR)) {
    if (/\.(mp3|wav)$/i.test(f)) {
      const tag = f.replace(/\.(mp3|wav)$/i, "");
      catalog.set(tag, path.join(SFX_DIR, f));
    }
  }
  return catalog;
}

/** 音效时长缓存（避免对同一文件重复 ffprobe） */
const _sfxDurCache = new Map<string, number>();
async function getSfxDuration(filePath: string): Promise<number> {
  const cached = _sfxDurCache.get(filePath);
  if (cached !== undefined) return cached;
  const d = await getMediaDuration(filePath);
  _sfxDurCache.set(filePath, d);
  return d;
}

/**
 * 把音效延迟 triggerTime 秒后叠进子片段音频，覆盖写回原文件。
 * ffmpeg 不能原地读写同一文件，故输出临时文件再覆盖。
 * duration=first 保证输出长度 = 子片段原长（调用方已确保音效放得下，绝不撑长）。
 */
async function mixSfx(segPath: string, sfxFile: string, triggerTime: number): Promise<void> {
  const ms  = Math.max(0, Math.round(triggerTime * 1000));
  const tmp = segPath.replace(/\.mp3$/i, "_sfx.mp3");
  await execFileAsync("ffmpeg", [
    "-y", "-i", segPath, "-i", sfxFile,
    "-filter_complex",
    `[1:a]adelay=${ms}|${ms},volume=${SFX_VOLUME}[s];[0:a][s]amix=inputs=2:duration=first:dropout_transition=0[a]`,
    "-map", "[a]", "-c:a", "libmp3lame", "-q:a", "2", tmp,
  ]);
  await fs.copyFile(tmp, segPath);
  await fs.unlink(tmp).catch(() => {});
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
  const charFiles = await fs.readdir(charsDir).catch(() => []);
  const charPngs  = charFiles.filter((f) => f.endsWith(".png"));
  for (const file of charFiles.filter((f) => f.endsWith(".json"))) {
    try {
      const data = JSON.parse(await fs.readFile(path.join(charsDir, file), "utf-8"));
      const name = data.name ?? path.basename(file, ".json");
      // JSON 中登记的造型描述：stage 名 → prompt
      const stagePrompts = new Map<string, string>(
        (data.stages ?? []).map((st: any) => [st.stage, st.prompt ?? ""]),
      );
      // 扫描磁盘上该角色所有 {name}_*.png，JSON 未登记的（手动放入的参考图）也纳入候选
      const prefix = `${name}_`;
      for (const png of charPngs.filter((f) => f.startsWith(prefix)).sort()) {
        const suffix = png.slice(prefix.length, -4); // 去掉 {name}_ 前缀与 .png
        const abs = path.join(charsDir, png);
        let desc: string;
        if (suffix === "原型") {
          desc = `${name} 原型 — ${data.base_prompt ?? ""}`;
        } else if (stagePrompts.has(suffix)) {
          desc = `${name} 造型/${suffix} — ${stagePrompts.get(suffix)}`;
        } else {
          desc = `${name} 参考图/${suffix}（用户提供的真实参考图）`;
        }
        lines.push(`路径: ${abs}`);
        lines.push(`  描述: ${desc}`);
        pathMap.set(abs, abs);
      }
    } catch { /* 跳过解析失败 */ }
  }

  lines.push("");
  lines.push("== 可用场景资源 ==");
  const sceneFiles = await fs.readdir(scenesDir).catch(() => []);
  const scenePngs  = sceneFiles.filter((f) => f.endsWith(".png"));
  for (const file of sceneFiles.filter((f) => f.endsWith(".json"))) {
    try {
      const data = JSON.parse(await fs.readFile(path.join(scenesDir, file), "utf-8"));
      const loc = data.location ?? path.basename(file, ".json");
      const softDesc = Object.entries(data.soft_scenes ?? {}).map(([k, v]) => `${k}: ${v}`).join("  ");
      // 底图 {loc}.png + 用户手动放入的变体 {loc}_*.png 都纳入候选
      const matches = scenePngs.filter((f) => f === `${loc}.png` || f.startsWith(`${loc}_`)).sort();
      for (const png of matches) {
        const abs = path.join(scenesDir, png);
        let desc: string;
        if (png === `${loc}.png`) {
          desc = `${loc} — ${data.base_prompt ?? ""}  ${softDesc}`;
        } else {
          const suffix = png.slice(loc.length + 1, -4); // 去掉 {loc}_ 前缀与 .png
          desc = `${loc} 参考图/${suffix}（用户提供的真实参考图）`;
        }
        lines.push(`路径: ${abs}`);
        lines.push(`  描述: ${desc}`);
        pathMap.set(abs, abs);
      }
    } catch { /* 跳过 */ }
  }

  return { text: lines.join("\n"), pathMap };
}

// ── LLM：资源选择 + image_prompt 微调 ────────────────────────────────────────

const RESOURCE_SELECTOR_SYSTEM = `你是分镜资源选择专员。根据 panel 信息和可用资源，选出最合适的参考图列表，并微调生图提示词。

规则：
1. image_prompt 中的 [角色名·阶段] 是分镜阶段给的人物身份提示：
   - 角色名是确定的：直接在资源目录里找到该角色，选它的图作参考
   - 阶段是提示（不必精确）：从该角色现有的图（原型 / 各造型 / 用户参考图）里，挑最贴合这个阶段提示的一张；拿不准时结合「完整场景上下文」判断。造型图/用户参考图优先于原型图
2. 改写 image_prompt：
   - 把每个 [角色名·阶段] 整体（连同方括号）替换为 "the person in image N"
   - 把场景/背景的文字描述替换为 "the background in image N"
   - N 从 1 开始，与 reference_images 顺序一致；其余动作、姿态、情绪、景别、光影描述全部保留，不大幅改写
3. 景别决定选图策略：
   - 特写 / 近景：优先选角色图（面部细节重要），场景图可省略
   - 中景：角色图 + 场景图
   - 全景 / 远景：场景图为主，角色图可选
4. 若某 [角色名·阶段] 在资源目录里找不到对应角色，则把该标签替换为不带方括号的简短描述（如"the boy"），不要把方括号留在提示词里
5. 若整个 panel 无合适资源，reference_images 输出空数组，但仍须把 image_prompt 里的所有 [..] 方括号去掉
6. 若有上一 panel 上下文：根据其信息，确保空间布局、人物位置、动作方向自然衔接

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

const IMAGE_TIMEOUT_MS = 600_000;

function runPython(args: string[]): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("python", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve({ ok, stderr });
    };

    const timer = setTimeout(() => {
      child.kill();
      stderr += "\n[timeout] process killed after " + IMAGE_TIMEOUT_MS / 1000 + "s";
      finish(false);
    }, IMAGE_TIMEOUT_MS);

    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      finish(code === 0);
    });
    child.on("error", (err: Error) => {
      clearTimeout(timer);
      stderr += "\n" + err.message;
      finish(false);
    });
  });
}

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

/** 用主文本 LLM 软化提示词，使其通过内容安全审核（递进：传入的可能是上一档软化结果） */
async function softenPrompt(prompt: string, rejectionInfo: string): Promise<string> {
  const client = await getOpenAI(LLM_API_KEY, LLM_BASE_URL);
  const resp = await client.chat.completions.create({
    model: LLM_MODEL,
    max_tokens: LLM_MAX_TOKENS,
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

async function generateImage(
  imgSem: Semaphore,
  prompt: string,
  refPaths: string[],
  outputPath: string,
  aspectRatio: string,
): Promise<void> {
  await imgSem.acquire();
  try {
    console.log(`    [生图] 提交: ${path.basename(outputPath)}（参考图 ${refPaths.length} 张，宽高比 ${aspectRatio}）`);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });

    const gptHelperPath = path.join(RENDER_DIR, "../utils/gpt-image-gen.py");

    // ── 主路径：gpt-image-gen.py（普通失败重试 + 安全拒绝时递进软化）──────
    let curPrompt = prompt;   // 当前使用的提示词（可能被软化覆盖）
    let softenCount = 0;      // 已软化档数
    let normalAttempt = 0;    // 普通失败重试次数
    while (true) {
      const args = [gptHelperPath, outputPath, curPrompt, "--aspect", aspectRatio, ...refPaths];
      const { ok, stderr } = await runPython(args);
      if (ok) {
        console.log(`    [生图] [gpt-image-2] 已保存: ${path.basename(outputPath)}`);
        return;
      }
      const errMsg = stderr.slice(-1500);

      // 内容安全拒绝：递进软化提示词后立即重试（不计入普通重试、不 sleep）
      if (isSafetyRejection(stderr)) {
        if (softenCount >= SOFTEN_MAX) {
          console.log(`    [生图] 安全拒绝，已软化 ${SOFTEN_MAX} 档仍未通过，降级 Gemini...`);
          break;
        }
        try {
          const softened = await softenPrompt(curPrompt, errMsg);
          softenCount++;
          console.log(`    [生图] 检测到内容安全拒绝，第 ${softenCount}/${SOFTEN_MAX} 次软化提示词后重试`);
          curPrompt = softened;
          continue;
        } catch (e: any) {
          console.log(`    [生图] 软化提示词失败（${e?.message ?? e}），降级 Gemini...`);
          break;
        }
      }

      // 普通失败：限次重试 + sleep
      normalAttempt++;
      console.log(`    [生图] [${normalAttempt}/${IMAGE_MAX_RETRIES}] gpt-image-gen 失败: ${errMsg}`);
      if (normalAttempt >= IMAGE_MAX_RETRIES) break;
      console.log(`    [生图] ${IMAGE_RETRY_SLEEP / 1000}s 后重试...`);
      await sleep(IMAGE_RETRY_SLEEP);
    }

    // ── 降级：调用 Gemini Python helper（使用最新（可能已软化的）提示词）──
    console.log(`    [生图] gpt-image-2 失败，降级到 Gemini...`);
    const geminiPath = path.join(RENDER_DIR, "../utils/gemini-image-gen.py");
    const geminiArgs = [geminiPath, outputPath, curPrompt, "--aspect", aspectRatio, ...refPaths];
    const { ok: geminiOk, stderr: geminiErr } = await runPython(geminiArgs);
    if (geminiOk) {
      console.log(`    [生图] [Gemini] 已保存: ${path.basename(outputPath)}`);
      return;
    }
    throw new Error(`生图失败（gpt-image-2 + Gemini 降级，软化 ${softenCount} 档）: ${path.basename(outputPath)}: ${geminiErr.slice(-1500)}`);
  } finally {
    imgSem.release();
  }
}

// ── 视频生成（ComfyUI）────────────────────────────────────────────────────────

/** 按 aspectRatio 返回 [width, height] */
function videoSize(aspectRatio: string): [number, number] {
  return aspectRatio === "16:9" ? [1280, 720] : [720, 1280];
}

async function tryGenerateVideoComfyUI(
  imgBase64: string,
  prompt: string,
  outputPath: string,
  duration: number,
  aspectRatio: string,
): Promise<void> {
  const [width, height] = videoSize(aspectRatio);

  // 深拷贝 workflow，注入参数
  const workflow = JSON.parse(JSON.stringify(getWorkflowTemplate()));
  workflow["324"].inputs.base64_data          = imgBase64;
  workflow["320:319"].inputs.value            = prompt;
  workflow["320:312"].inputs.value            = width;
  workflow["320:299"].inputs.value            = height;

  // 时长控制：把秒按 fps 吸附到 LTX 合法帧数，直接写入 latent 长度的两个消费节点，
  // 绕过 workflow 内 a*fps+1（320:323）的整数秒瓶颈，使视频时长精确贴合音频。
  const fps    = getVideoFps();
  const frames = durationToFrames(duration, fps);
  workflow["320:295"].inputs.length         = frames;  // EmptyLTXVLatentVideo（视频）
  workflow["320:305"].inputs.frames_number  = frames;  // LTXVEmptyLatentAudio（音频，须与视频同帧数）

  // 提交任务
  const submitResp = await fetch(`${VIDEO_BASE_URL}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: workflow }),
  });
  if (!submitResp.ok) {
    throw new Error(`ComfyUI 提交失败: HTTP ${submitResp.status} ${(await submitResp.text()).slice(0, 200)}`);
  }
  const { prompt_id } = await submitResp.json() as { prompt_id: string };
  console.log(`    [视频] prompt_id=${prompt_id}，轮询中...`);

  // 轮询 /history/{prompt_id}
  while (true) {
    await sleep(VIDEO_POLL_INTERVAL);
    const histResp = await fetch(`${VIDEO_BASE_URL}/history/${prompt_id}`);
    if (!histResp.ok) continue;
    const hist = await histResp.json() as Record<string, any>;
    const entry = hist[prompt_id];
    if (!entry) continue;

    const status = entry.status?.status_str ?? "";
    if (status === "error") {
      throw new Error(`ComfyUI 生成失败: ${JSON.stringify(entry.status)}`);
    }
    if (status !== "success" && !entry.status?.completed) continue;

    // 从 SaveVideo 节点（75）的输出拿文件信息（ComfyUI 返回 key 为 images）
    const videoOutputs = entry.outputs?.["75"]?.videos ?? entry.outputs?.["75"]?.images;
    if (!videoOutputs?.length) {
      throw new Error(`ComfyUI 输出中未找到视频: ${JSON.stringify(entry.outputs)}`);
    }
    const { filename, subfolder, type } = videoOutputs[0];

    // 下载视频
    const viewUrl = `${VIDEO_BASE_URL}/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder ?? "")}&type=${encodeURIComponent(type ?? "output")}`;
    const vidResp = await fetch(viewUrl);
    if (!vidResp.ok) {
      throw new Error(`ComfyUI 下载失败: HTTP ${vidResp.status}`);
    }
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, Buffer.from(await vidResp.arrayBuffer()));
    console.log(`    [视频] 已保存: ${path.basename(outputPath)}`);
    return;
  }
}

async function generateVideo(
  vidSem: Semaphore,
  imagePath: string,
  prompt: string,
  outputPath: string,
  aspectRatio: string,
  duration: number = VIDEO_DEFAULT_DURATION,
): Promise<void> {
  await vidSem.acquire();
  try {
    const imgBase64 = (await fs.readFile(imagePath)).toString("base64");
    const _fps = getVideoFps();
    const _frames = durationToFrames(duration, _fps);
    console.log(`    [视频] 提交: ${path.basename(outputPath)}（目标 ${duration.toFixed(2)}s → ${_frames}帧/${(_frames / _fps).toFixed(2)}s, ${aspectRatio}）`);

    for (let attempt = 1; attempt <= VIDEO_MAX_RETRIES; attempt++) {
      try {
        await tryGenerateVideoComfyUI(imgBase64, prompt, outputPath, duration, aspectRatio);
        return;
      } catch (e) {
        if (attempt < VIDEO_MAX_RETRIES) {
          const cause = (e as any)?.cause;
          const causeStr = cause
            ? ` [cause: ${cause?.code ?? cause?.message ?? String(cause)}]`
            : "";
          const now = new Date();
          const ts = `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}:${String(now.getSeconds()).padStart(2,"0")}`;
          console.log(`    [视频][${ts}] 第 ${attempt} 次失败: ${e}${causeStr}，${VIDEO_RETRY_SLEEP / 1000}s 后重试...`);
          await sleep(VIDEO_RETRY_SLEEP);
        } else {
          throw new Error(`视频生成失败（${VIDEO_MAX_RETRIES}次）: ${path.basename(outputPath)}: ${e}`);
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

// 模块级单例：跨场景共享，让 IMAGE_CONCURRENCY / VIDEO_CONCURRENCY 真正限制全局并发。
// （之前每个 renderScene 各自 new 一次，N 个场景并行时实际并发被乘 N 倍。）
const _globalImgSem = new Semaphore(IMAGE_CONCURRENCY);
const _globalVidSem = new Semaphore(VIDEO_CONCURRENCY);


// ── TTS 管线 ──────────────────────────────────────────────────────────────────

interface TtsWord { word: string; startTime: number; endTime: number; }

async function ttsExecApi(
  text: string,
  voice: string,
  _stylePrompt: string,
  outputPath: string,
  opts?: { timestamp?: boolean },
): Promise<{ words: TtsWord[] }> {
  // 豆包 V3 HTTP Chunked 单向流式：一次性输入文本，响应体为多行 JSON，每行 data 为 base64 音频分片。
  // 注：seed-tts-1.0 接口无自由文本风格控制（仅多情感音色支持 emotion 枚举），故 stylePrompt 不下发。
  // enable_timestamp（仅 TTS1.0 支持）开启时，响应里额外带 sentence.words[]，每项 {word,startTime,endTime}（驼峰、秒）。
  const audioParams: Record<string, any> = { format: "mp3", sample_rate: 24000 };
  if (opts?.timestamp) audioParams.enable_timestamp = true;
  const payload = {
    user: { uid: "story-claw" },
    req_params: {
      text,
      speaker: voice,
      audio_params: audioParams,
      additions: JSON.stringify({ disable_markdown_filter: true }),
    },
  };

  const resp = await fetch(DOUBAO_BASE_URL, {
    method: "POST",
    headers: {
      "X-Api-Key": DOUBAO_API_KEY,
      "X-Api-Resource-Id": DOUBAO_RESOURCE_ID,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`TTS API HTTP ${resp.status}: ${errText.slice(0, 300)}`);
  }

  const body = await resp.text();
  const chunks: Buffer[] = [];
  const words: TtsWord[] = [];
  for (const line of body.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let d: any;
    try { d = JSON.parse(s); } catch { continue; }
    // 时间戳：同次请求内多子句的 words 按出现顺序拼平，startTime 连续 = 子片段本地时间轴
    if (opts?.timestamp && d.sentence?.words) {
      for (const w of d.sentence.words) {
        words.push({ word: String(w.word ?? ""), startTime: w.startTime, endTime: w.endTime });
      }
    }
    if (d.code === 0 && d.data) {
      chunks.push(Buffer.from(d.data as string, "base64"));
    } else if (d.code === 20000000) {
      break;  // 合成结束
    } else if (typeof d.code === "number" && d.code > 0) {
      throw new Error(`TTS API 错误: ${JSON.stringify(d)}`);
    }
  }
  if (!chunks.length) throw new Error(`TTS API 未返回音频: ${body.slice(0, 200)}`);
  await fs.writeFile(outputPath, Buffer.concat(chunks));
  return { words };
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

// ── 阶段一:音色分配（archive 调用，按角色一次性分配，写入 voice_map）────────────

const ASSIGN_VOICE_SYSTEM = `你是配音音色分配助手。为本章新角色分配 TTS 音色。

规则：
- 只为"本章新角色"分配，current_map 里已有的角色不要输出
- 根据角色外貌描述判断性别，从"可用音色池"里选同性别的音色
- 尽量避开已被占用的音色（current_map 的值），不够再复用
- 旁白不在此处理，不要输出旁白

只输出 JSON 对象（新角色名 → 音色名），不要任何其他文字：
{"角色名":"音色名"}`;

/** 粗略从外貌描述猜性别（仅 LLM 失败时的兜底用） */
function guessGender(desc: string): string {
  return /女|女性|女子|少女|姑娘|妇人|母亲|姐|妹|娘/.test(desc) ? "女" : "男";
}

/**
 * 为本章新角色批量分配音色，合并进 voice_map.json。
 * LLM 只输出新增分配；代码负责合并；旁白不入表（TTS 直接用 narrator_voice）。
 */
export async function assignVoices(
  novelName: string,
  newCharacters: Array<{ name: string; base_prompt?: string; gender?: string }>,
): Promise<void> {
  if (!newCharacters?.length) return;

  const voiceMapPath = novelPaths.voiceMap(novelName);
  let voiceMap: Record<string, string> = {};
  if (fsSync.existsSync(voiceMapPath)) {
    voiceMap = JSON.parse(await fs.readFile(voiceMapPath, "utf-8"));
  }

  const pending = newCharacters.filter((c) => c.name && !(c.name in voiceMap));
  if (!pending.length) return;

  let newAssign: Record<string, string> = {};
  try {
    const client = await getOpenAI(LLM_API_KEY, LLM_BASE_URL);
    const userContent = [
      `可用音色池（名称→性别）：\n${JSON.stringify(DOUBAO_VOICES)}`,
      `current_map（已占用，勿改动，其值即已占用音色）：\n${JSON.stringify(voiceMap)}`,
      `本章新角色（name + 外貌 desc，据此判性别）：\n${JSON.stringify(
        pending.map((c) => ({ name: c.name, gender: c.gender ?? "", desc: c.base_prompt ?? "" })),
      )}`,
    ].join("\n\n");
    const resp = await client.chat.completions.create({
      model: LLM_MODEL,
      max_tokens: LLM_MAX_TOKENS,
      messages: [
        { role: "system", content: ASSIGN_VOICE_SYSTEM },
        { role: "user", content: userContent },
      ],
    });
    let raw = resp.choices[0].message.content?.trim() ?? "{}";
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) raw = m[0];
    newAssign = JSON.parse(raw);
  } catch (e) {
    console.error(`[音色分配] LLM 失败，改用规则兜底: ${e}`);
    newAssign = {};
  }

  // 校验 + 规则兜底（无效/缺失的按性别从池中挑未占用的）
  const poolByGender: Record<string, string[]> = {};
  for (const [v, g] of Object.entries(DOUBAO_VOICES)) (poolByGender[g] ??= []).push(v);
  const used = new Set(Object.values(voiceMap));

  for (const c of pending) {
    let v = newAssign[c.name];
    if (!v || !(v in DOUBAO_VOICES)) {
      const g = c.gender || guessGender(c.base_prompt ?? "");
      const pool = poolByGender[g] ?? Object.keys(DOUBAO_VOICES);
      v = pool.find((x) => !used.has(x)) ?? pool[0] ?? Object.keys(DOUBAO_VOICES)[0];
    }
    voiceMap[c.name] = v;
    used.add(v);
  }

  await fs.writeFile(voiceMapPath, JSON.stringify(voiceMap, null, 2), "utf-8");
  console.log(`[音色分配] 新增 ${JSON.stringify(Object.fromEntries(pending.map((c) => [c.name, voiceMap[c.name]])))}`);
}

// ── 阶段二:逐 group 配音（按说话人切分多音色 → 并行合成 → 拼成组音频）──────────

const GROUP_TTS_SYSTEM = `你是配音切分助手。给定剧本中的一句话（可能含【】画面预设标注）和角色音色映射，把它按"说话人"从左到右切成有序片段，给每段配音色。

会提供给你：
- voice_map：角色名 → 音色名
- narrator_voice：旁白音色名
- 说话人参考（可能有）：画面预设已标注的「(说话人)台词」，直接告诉你这句里哪段是谁说的台词，优先据此判断台词归属

规则：
- 叙述、说话引导语（如"他说："、"XX道："）→ 用 narrator_voice
- 引号内台词 / 角色说出的话 → 用该角色的音色（优先看"说话人参考"确定说话人，再在 voice_map 里查；简称/别名也要匹配到对应角色；查不到 → narrator_voice）
- 内心独白 → 用该角色的音色
- 从左到右、按原文顺序切；同一连续片段用同一音色，直到说话人切换
- text 必须是原文逐字（去掉【】标注部分），覆盖所有可读文字，不遗漏、不改写
- style：该片段朗读风格（情绪/语气/语速，中文，简短），可参考【情绪】字段
- voice 字段只能填 voice_map 的某个值，或 narrator_voice

只输出 JSON 数组，不要任何其他文字：
[{"text":"...","voice":"音色名","style":"..."}]`;

/**
 * 阶段二：逐 group 配音。每个 group 由 LLM 按说话人切分 → 并行合成子片段 → 拼成组音频。
 * 返回每个 group 的真实音频时长（秒），并把全部组音频按序拼成场景音频 _tts_{scene}.mp3。
 */
async function runGroupTtsPipeline(
  groups: any[],
  voiceMap: Record<string, string>,
  outputDir: string,
  sceneName: string,
): Promise<number[]> {
  const tmpDir = path.join(outputDir, "tts_segments");
  await fs.mkdir(tmpDir, { recursive: true });

  const validVoices = new Set<string>([...Object.keys(DOUBAO_VOICES), DOUBAO_NARRATOR]);
  // 音色名 → 可读说话人（旁白 / 角色名），仅用于日志
  const speakerOf = (v: string): string =>
    v === DOUBAO_NARRATOR ? "旁白"
      : (Object.entries(voiceMap).find(([, vv]) => vv === v)?.[0] ?? v);
  const llmSem = new Semaphore(TTS_CONCURRENCY);
  const ttsSem = new Semaphore(TTS_CONCURRENCY);
  const groupAudio = (gi: number) => path.join(outputDir, `g${String(gi).padStart(2, "0")}_tts.mp3`);
  // 音效库（一次性加载）：group.sfx 里的 sound 标签据此解析为文件路径
  const sfxCatalog = SFX_ENABLED ? loadSfxCatalog() : new Map<string, string>();

  const durations = await Promise.all(groups.map(async (group: any, gi: number): Promise<number> => {
    const ga = groupAudio(gi);
    if (fsSync.existsSync(ga)) return getMediaDuration(ga);  // 续跑：已存在直接量时长

    const text = String(group.text ?? "").trim();

    // 从本 group 的【】里抽出【语言】字段（画面预设标注的「(说话人)台词」），显式拼给切分 LLM 作参考
    const langRefs: string[] = [];
    for (const mm of text.matchAll(/【([^】]*)】/g)) {
      const f = mm[1].split("|").map((s) => s.trim());
      if (f.length >= 8 && f[7] && f[7] !== "无") langRefs.push(f[7]);
    }
    const langRef = langRefs.join("　");

    // 1. LLM 按说话人切分
    let segs: Array<{ text: string; voice: string; style?: string }> = [];
    await llmSem.acquire();
    try {
      const client = await getOpenAI(LLM_API_KEY, LLM_BASE_URL);
      const resp = await client.chat.completions.create({
        model: LLM_MODEL,
        max_tokens: LLM_MAX_TOKENS,
        messages: [
          { role: "system", content: GROUP_TTS_SYSTEM },
          { role: "user", content: `voice_map：${JSON.stringify(voiceMap)}\nnarrator_voice：${DOUBAO_NARRATOR}\n\n句子：${text}${langRef ? `\n\n说话人参考（画面预设已标注的「(说话人)台词」，据此判断台词归谁；名字对不上就回旁白）：${langRef}` : ""}` },
        ],
      });
      let raw = resp.choices[0].message.content?.trim() ?? "[]";
      const m = raw.match(/\[[\s\S]*\]/);
      if (m) raw = m[0];
      segs = JSON.parse(raw);
    } catch (e) {
      console.error(`[groupTTS g${String(gi).padStart(2, "0")}] 切分失败，整句用旁白: ${e}`);
    } finally {
      llmSem.release();
    }
    if (!Array.isArray(segs) || !segs.length) {
      segs = [{ text: text.replace(/【[^】]*】/g, "").trim(), voice: DOUBAO_NARRATOR, style: "平稳叙述" }];
    }

    // 过滤无可朗读内容的片段（纯标点/空白）：豆包对空内容返回无音频会导致 ttsExecApi 抛错
    const speakable = (t: string) => /[\p{L}\p{N}]/u.test(t);
    const synthSegs = segs.filter((s) => speakable(String(s.text ?? "")));

    if (!synthSegs.length) {
      // 整组无可朗读内容（极少见）：写一段极短静音占位，保证后续拼接/时长不崩
      console.warn(`[groupTTS g${String(gi).padStart(2, "0")}] 无可朗读内容，写入静音占位`);
      await execFileAsync("ffmpeg", [
        "-y", "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono",
        "-t", "0.3", "-c:a", "libmp3lame", "-q:a", "9", ga,
      ]);
      return getMediaDuration(ga);
    }

    // 该 group 的音效任务：仅当启用、有 sfx、库非空时开字级时间戳
    const sfxList: Array<{ anchor: string; sound: string }> =
      (SFX_ENABLED && sfxCatalog.size > 0 && Array.isArray(group.sfx)) ? group.sfx : [];
    const wantTs = sfxList.length > 0;

    // 2. 并行合成各子片段
    const usedVoices: string[] = [];
    const segResults = await Promise.all(synthSegs.map(async (s, j): Promise<{ p: string; words: TtsWord[] }> => {
      const p = path.join(tmpDir, `g${String(gi).padStart(2, "0")}_s${String(j).padStart(2, "0")}.mp3`);
      const voice = ASSIGN_CHARACTER_VOICE
        ? (validVoices.has(s.voice) ? s.voice : DOUBAO_NARRATOR)
        : DOUBAO_NARRATOR;
      usedVoices[j] = voice;
      let words: TtsWord[] = [];
      await ttsSem.acquire();
      try {
        // TTS 重试机制：限流或临时错误时等待 3 秒后重试，最多重试 3 次
        for (let retry = 0; retry <= 3; retry++) {
          try {
            const r = await ttsExecApi(String(s.text ?? ""), voice, String(s.style ?? ""), p, wantTs ? { timestamp: true } : undefined);
            words = r.words;
            break; // 成功则跳出重试循环
          } catch (err: any) {
            const isRetryable = err.message?.includes("quota exceeded") ||
                               err.message?.includes("HTTP 403") ||
                               err.message?.includes("HTTP 429") ||
                               err.message?.includes("HTTP 500");
            if (isRetryable && retry < 3) {
              console.warn(`[TTS] 临时错误，${3}秒后重试 (${retry + 1}/3): ${err.message?.slice(0, 100)}`);
              await new Promise(r => setTimeout(r, 3000));
            } else {
              throw err; // 非重试错误或重试次数用尽，抛出异常
            }
          }
        }
      } finally {
        ttsSem.release();
      }
      return { p, words };
    }));
    const segPaths = segResults.map((r) => r.p);

    // 2.5 音效叠入：每项 sfx 落在第一个含其 anchor 的子片段，命中即消费、不重复
    if (wantTs) {
      const gtag = `g${String(gi).padStart(2, "0")}`;
      const items = sfxList.filter((x) => x && x.anchor && x.sound);
      const consumed = new Set<number>();
      for (let j = 0; j < segResults.length; j++) {
        const { p, words } = segResults[j];
        if (!words.length) continue;
        // 按字展开：每个字映射其所属 token 的 startTime（标点黏前字，随该 token 一起展开）
        const chars: string[] = [];
        const charTime: number[] = [];
        for (const w of words) for (const ch of w.word) { chars.push(ch); charTime.push(w.startTime); }
        const joined = chars.join("");
        for (let k = 0; k < items.length; k++) {
          if (consumed.has(k)) continue;
          const { anchor, sound } = items[k];
          const sfxFile = sfxCatalog.get(sound);
          if (!sfxFile) { console.warn(`[sfx ${gtag}] 标签未找到: 「${sound}」，跳过`); consumed.add(k); continue; }
          const idx = joined.indexOf(anchor);
          if (idx < 0) continue;  // 此子片段不含 anchor，留给后续子片段
          const triggerTime = charTime[idx];
          const sfxDur = await getSfxDuration(sfxFile);
          const segDur = await getMediaDuration(p);
          if (+(segDur - triggerTime).toFixed(2) < +sfxDur.toFixed(2)) {
            console.warn(`[sfx ${gtag}] anchor「${anchor}」放不下（剩余 ${(segDur - triggerTime).toFixed(2)}s < 音效 ${sfxDur.toFixed(2)}s），跳过`);
            consumed.add(k);
            continue;
          }
          await mixSfx(p, sfxFile, triggerTime);
          console.log(`[sfx ${gtag}] anchor「${anchor}」→「${sound}」@${triggerTime.toFixed(2)}s 已叠入 ${path.basename(p)}`);
          consumed.add(k);
        }
      }
      for (let k = 0; k < items.length; k++) {
        if (!consumed.has(k)) console.warn(`[sfx ${gtag}] anchor「${items[k].anchor}」在所有子片段均未匹配，跳过`);
      }
    }

    // 音色分配明细（便于核对每段说话人是否正确）
    const assignment = synthSegs.map((s, j) => ({
      说话人: speakerOf(usedVoices[j]),
      LLM返回: s.voice,
      在池中: validVoices.has(s.voice),
      实际音色: usedVoices[j],
      回退旁白: !validVoices.has(s.voice),
      text: String(s.text ?? "").slice(0, 24),
    }));
    console.log(`[groupTTS g${String(gi).padStart(2, "0")}] 池大小=${validVoices.size} 音色分配: ${JSON.stringify(assignment, null, 0)}`);

    // 3. 子片段按序拼成组音频
    await ttsPhase4Concat(segPaths, ga);
    const d = await getMediaDuration(ga);
    console.log(`[groupTTS g${String(gi).padStart(2, "0")}] ${segs.length}段 → ${d.toFixed(1)}s`);
    return d;
  }));

  // 全部组音频按序拼成场景音频
  const sceneAudio = path.join(outputDir, `_tts_${sceneName}.mp3`);
  await ttsPhase4Concat(groups.map((_: any, gi: number) => groupAudio(gi)), sceneAudio);
  console.log(`[groupTTS] 场景音频 → ${path.basename(sceneAudio)}`);
  return durations;
}

// ── 主渲染函数（供 pipeline 调用）────────────────────────────────────────────

export interface RenderProgress {
  scene: string;
  done: number;
  total: number;
}

export interface SceneRenderResult {
  groups: Array<{
    globalOrder: number;
    videoPath: string;
    ttsPath: string;
  }>;
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

  // 全局共享，跨场景统一限并发（不再 per-scene 各 new 一把）
  const imgSem     = _globalImgSem;
  const vidSem     = _globalVidSem;
  const videoEvents = new Map<string, { resolve: () => void; promise: Promise<void> }>();

  // ── 阶段二:先逐 group 配音，拿到每组真实时长 d_g 驱动视频（imagesOnly 跳过）──
  let groupDurations: number[] = groups.map(() => VIDEO_DEFAULT_DURATION);
  let sceneAudio = "";
  if (!sel.imagesOnly) {
    let voiceMap: Record<string, string> = {};
    if (fsSync.existsSync(voiceMapPath)) {
      voiceMap = JSON.parse(await fs.readFile(voiceMapPath, "utf-8"));
    }
    groupDurations = await runGroupTtsPipeline(groups, voiceMap, outputDir, sceneName);
    sceneAudio = path.join(outputDir, `_tts_${sceneName}.mp3`);
  }

  // ── 视频管线（时长由 d_g 驱动）──
  const videoTask = (async (): Promise<string> => {
    // ── 预注册所有 panel 的 videoEvent ──
    for (let gi = 0; gi < groups.length; gi++) {
      for (let pi = 0; pi < (groups[gi].panels ?? []).length; pi++) {
        const key = `${gi},${pi}`;
        let resolve!: () => void;
        const promise = new Promise<void>((r) => { resolve = r; });
        videoEvents.set(key, { resolve, promise });
      }
    }

    // ── 预计算每个 panel 的 videoPrompt（来自 JSON，无需等待生图）──
    const videoPromptMap = new Map<string, string>();
    for (let gi = 0; gi < groups.length; gi++) {
      for (const [pi, panel] of (groups[gi].panels ?? []).entries()) {
        videoPromptMap.set(
          `${gi},${pi}`,
          `${(panel.video_prompt ?? "").trimEnd()} No background music or ambient sound. No subtitles or text overlays.`,
        );
      }
    }

    // ── 根据 JSONL 数据预计算 prevCtx（所有字段均来自 JSON，无需等待生图）──
    function getPrevCtx(gi: number, pi: number): any | null {
      if (pi > 0) {
        const prev = (groups[gi].panels ?? [])[pi - 1];
        return { shot_type: prev.shot_type, image_prompt: prev.image_prompt, video_prompt: videoPromptMap.get(`${gi},${pi - 1}`) };
      }
      if (gi > 0) {
        const prevPanels = groups[gi - 1].panels ?? [];
        if (prevPanels.length > 0) {
          const prev = prevPanels[prevPanels.length - 1];
          return { shot_type: prev.shot_type, image_prompt: prev.image_prompt, video_prompt: videoPromptMap.get(`${gi - 1},${prevPanels.length - 1}`) };
        }
      }
      return null;
    }

    // ── 所有 panel 并行：生图 → 生视频，continuation 通过 videoEvents 等待前驱 ──
    console.log(`\n[${sceneName}] 并行处理所有 panels...`);
    await Promise.all(
      groups.flatMap((group: any, gi: number) => {
        const panels      = group.panels ?? [];
        const currentText = group.text ?? "";
        const groupDur    = groupDurations[gi] ?? VIDEO_DEFAULT_DURATION;  // 真实 TTS 时长驱动
        const panelDurations = distributePanelDurations(groupDur, panels);

        return panels.map(async (panel: any, pi: number) => {
          const prefix       = `g${String(gi).padStart(2, "0")}_p${String(pi).padStart(2, "0")}`;
          const imgPath      = path.join(outputDir, `${prefix}.png`);
          const panelVidPath = path.join(outputDir, `${prefix}.mp4`);
          const key          = `${gi},${pi}`;
          const duration     = panelDurations[pi] ?? VIDEO_DEFAULT_DURATION;
          const videoPrompt  = videoPromptMap.get(key)!;

          try {
            // ── 生图阶段 ──
            let actualImg: string | null = null;

            if (panel.is_continuation === true) {
              console.log(`  [${sceneName}][${prefix}] is_continuation，跳过生图`);
            } else if (fsSync.existsSync(imgPath)) {
              console.log(`  [${sceneName}][${prefix}] 图片已存在，跳过生图`);
              actualImg = imgPath;
            } else {
              const { refPaths, imagePrompt } = await selectResources(panel, catalog, currentText, getPrevCtx(gi, pi), fullSceneText);
              // 兜底：选择器若漏剥离 [角色名·阶段] 身份标签，避免中文身份词污染生图
              const cleanPrompt = imagePrompt.replace(/\[[^\]]*\]/g, refPaths.length ? "the person in image 1" : "the person");
              console.log(`  [${sceneName}][${prefix}] 参考图: ${refPaths.map((p) => path.basename(p)).join(", ") || "无"}`);
              console.log(`  [${sceneName}][${prefix}] image_prompt: ${cleanPrompt}`);
              await generateImage(imgSem, cleanPrompt, refPaths, imgPath, sel.aspectRatio);
              actualImg = imgPath;
            }

            // images-only：生完静态图即止，跳过生视频（continuation panel 也在此返回）
            if (sel.imagesOnly) return;

            // ── 生视频阶段 ──
            if (fsSync.existsSync(panelVidPath)) {
              console.log(`    [视频] ${prefix}.mp4 已存在，跳过`);
              return;
            }

            if (panel.is_continuation === true) {
              let prevKey: string | null = null;
              if (pi > 0) {
                prevKey = `${gi},${pi - 1}`;
              } else if (gi > 0) {
                const prevPanels = groups[gi - 1].panels ?? [];
                prevKey = `${gi - 1},${prevPanels.length - 1}`;
              }

              if (prevKey && videoEvents.has(prevKey)) {
                console.log(`    [${prefix}] continuation: 等待 ${prevKey.replace(",", "_p").replace(/^(\d+)/, "g$1")} 视频完成...`);
                await videoEvents.get(prevKey)!.promise;
                const [pg, pp] = prevKey.split(",").map(Number);
                const prevVid   = path.join(outputDir, `g${String(pg).padStart(2, "0")}_p${String(pp).padStart(2, "0")}.mp4`);
                const lastFrame = path.join(outputDir, `g${String(pg).padStart(2, "0")}_p${String(pp).padStart(2, "0")}_lastframe.png`);
                if (fsSync.existsSync(prevVid) && (fsSync.existsSync(lastFrame) || await extractLastFrame(prevVid, lastFrame))) {
                  actualImg = lastFrame;
                  console.log(`    [${prefix}] continuation: 使用 ${path.basename(lastFrame)}`);
                } else {
                  console.log(`    [${prefix}] continuation: 提帧失败，跳过`);
                  return;
                }
              } else {
                console.log(`    [${prefix}] continuation: 无前驱，跳过`);
                return;
              }
            }

            if (!actualImg || !fsSync.existsSync(actualImg)) {
              console.log(`    [${prefix}] 无参考图，跳过`);
              return;
            }

            await generateVideo(vidSem, actualImg, videoPrompt, panelVidPath, sel.aspectRatio, duration);
          } catch (e) {
            console.log(`    [${prefix}] 失败: ${e}`);
          } finally {
            videoEvents.get(key)?.resolve();
          }
        });
      }),
    );

    if (sel.imagesOnly) {
      console.log(`\n[${sceneName}] images-only：所有分镜图已生成，跳过视频拼接/TTS/合并`);
      return "";
    }

    // ── 按 group 顺序拼接 panel 视频 → group 视频 ──
    const groupVideos: string[] = [];
    for (let gi = 0; gi < groups.length; gi++) {
      const panels       = groups[gi].panels ?? [];
      const groupVidPath = path.join(outputDir, `g${String(gi).padStart(2, "0")}.mp4`);

      if (fsSync.existsSync(groupVidPath)) {
        console.log(`\n[group ${String(gi).padStart(2, "0")}] 视频已存在，跳过`);
        groupVideos.push(groupVidPath);
        onProgress?.({ scene: sceneName, done: gi + 1, total: groups.length });
        continue;
      }

      const panelVids = panels
        .map((_: any, pi: number) => path.join(outputDir, `g${String(gi).padStart(2, "0")}_p${String(pi).padStart(2, "0")}.mp4`))
        .filter((p: string) => fsSync.existsSync(p));

      if (panelVids.length === 0) {
        console.log(`\n[group ${String(gi).padStart(2, "0")}] 所有 panel 视频均失败，跳过`);
        onProgress?.({ scene: sceneName, done: gi + 1, total: groups.length });
        continue;
      }

      if (panelVids.length === 1) {
        await fs.copyFile(panelVids[0], groupVidPath);
      } else {
        await concatVideos(panelVids, groupVidPath);
      }
      console.log(`  拼接完成: ${path.basename(groupVidPath)}`);
      groupVideos.push(groupVidPath);
      onProgress?.({ scene: sceneName, done: gi + 1, total: groups.length });
    }

    const validVideos = groupVideos.filter((p) => fsSync.existsSync(p));
    console.log(`\n所有 ${validVideos.length} 个 group 视频生成完毕`);

    return validVideos;
  })();

  // ── 等待视频管线（TTS 已在前面完成）──
  const groupVideoPaths = await videoTask;

  // 收集所有 group 的 TTS 音频路径和 global_order
  const resultGroups: Array<{ globalOrder: number; videoPath: string; ttsPath: string }> = [];
  for (let gi = 0; gi < groups.length; gi++) {
    const videoPath = groupVideoPaths[gi];
    const ttsPath = path.join(outputDir, `g${String(gi).padStart(2, "0")}_tts.mp3`);
    const globalOrder = groups[gi].global_order ?? gi;

    if (videoPath && fsSync.existsSync(videoPath) && fsSync.existsSync(ttsPath)) {
      resultGroups.push({ globalOrder, videoPath, ttsPath });
    }
  }

  console.log(`\n[场景完成] ${sceneName}  共 ${resultGroups.length} 个有效 group`);

  return { groups: resultGroups };
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
 * 全局对齐：收集所有 group 的视频和音频，按 globalOrder 排列，统一调整速度后拼接为集视频。
 *
 * 步骤：
 *   1. 收集所有场景的 group（已按 globalOrder 排序）
 *   2. 量取所有 group 的视频/音频总时长
 *   3. 用 computeAlignTarget 计算全局目标速度
 *   4. 对每个 group：用 ffmpeg 调整视频 setpts 和音频 atempo，输出临时文件
 *   5. ffmpeg concat 所有调整后的视频 → 合成视频
 *   6. ffmpeg concat 所有调整后的音频 → 合成音频
 *   7. ffmpeg mux 合成视频 + 合成音频 → 集最终 mp4
 */
export async function globalAlignAndMerge(
  results: SceneRenderResult[],
  episodeVideoPath: string,
  epDir: string,
): Promise<void> {
  if (results.length === 0) {
    console.log("[全局对齐] 无场景，跳过");
    return;
  }

  // ── 收集所有 group 并按 globalOrder 排序 ──
  const allGroups: Array<{ globalOrder: number; videoPath: string; ttsPath: string }> = [];
  for (const result of results) {
    allGroups.push(...result.groups);
  }

  allGroups.sort((a, b) => a.globalOrder - b.globalOrder);

  // ── 过滤掉不存在的文件 ──
  const validGroups = allGroups.filter(g =>
    g.videoPath && g.ttsPath &&
    fsSync.existsSync(g.videoPath) && fsSync.existsSync(g.ttsPath)
  );

  if (validGroups.length === 0) {
    console.log("[全局对齐] 无有效的 group 文件，跳过");
    return;
  }

  console.log(`[全局对齐] 共 ${validGroups.length} 个有效 group`);

  // ── 量取时长 ──
  console.log("\n[全局对齐] 量取各 group 时长...");
  let totalVideo = 0;
  let totalAudio = 0;
  for (const group of validGroups) {
    totalVideo += await getMediaDuration(group.videoPath);
    totalAudio += await getMediaDuration(group.ttsPath);
  }

  console.log(`[全局对齐] 视频总时长: ${totalVideo.toFixed(1)}s`);
  console.log(`[全局对齐] 音频总时长: ${totalAudio.toFixed(1)}s`);

  // ── 计算目标速度 ──
  const { T, videoSpeed, audioSpeed, note } = computeAlignTarget(totalVideo, totalAudio);
  console.log(`[全局对齐] 目标时长: ${T.toFixed(1)}s  视频速度: ×${videoSpeed.toFixed(3)}  音频速度: ×${audioSpeed.toFixed(3)}`);
  console.log(`[全局对齐] ${note}`);

  const tmpDir = path.join(epDir, "_align_tmp");
  await fs.mkdir(tmpDir, { recursive: true });

  // ── 调整每个 group 的视频和音频 ──
  const adjustedVideos: string[] = [];
  const adjustedAudios: string[] = [];

  await Promise.all(validGroups.map(async (group, i) => {
    const idx    = String(i).padStart(3, "0");
    const adjVid = path.join(tmpDir, `v${idx}.mp4`);
    const adjAud = path.join(tmpDir, `a${idx}.mp3`);

    // 视频调速：setpts=(1/speed)*PTS
    const ptsExpr = `${(1 / videoSpeed).toFixed(6)}*PTS`;
    await execFileAsync("ffmpeg", [
      "-y", "-i", group.videoPath,
      "-filter:v", `setpts=${ptsExpr}`,
      "-c:v", "libx264", "-preset", "fast", "-crf", "18",
      "-an",
      adjVid,
    ]);

    // 音频调速：atempo（范围 0.5~2.0，本方案约束在 0.7~1.6 内，单个滤镜够用）
    await execFileAsync("ffmpeg", [
      "-y", "-i", group.ttsPath,
      "-filter:a", `atempo=${audioSpeed.toFixed(6)}`,
      "-c:a", "libmp3lame", "-q:a", "2",
      adjAud,
    ]);

    adjustedVideos[i] = adjVid;
    adjustedAudios[i] = adjAud;
    console.log(`  [对齐] group ${idx} (order=${group.globalOrder}) 完成`);
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
