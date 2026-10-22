import fs from "node:fs/promises";
import path from "node:path";
import {randomBytes, randomUUID} from "node:crypto";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {getStoryVideoConfig, H3_FPS, H3_MAX_DURATION, type StoryVideoConfig} from "./story-video-config.js";
import {resolveMediaCommand} from "./media-binaries.js";
import {PATHS} from "./paths.js";

type ApiNode = {class_type: string; inputs: Record<string, any>};
export type H3ApiWorkflow = Record<string, ApiNode>;
const execFileAsync = promisify(execFile);
const MIN_NATIVE_FRAMES = 124;
const MAX_NATIVE_FRAMES = 362;
class H3ServiceNotReadyError extends Error {}
class H3SubmissionUnknownError extends Error {}

/** Native generation stays within H3's documented 124–362 trained-frame range. */
export function durationToH3Frames(duration: number, maxDuration = H3_MAX_DURATION): number {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("H3 镜头时长必须大于零");
  if (!Number.isFinite(maxDuration) || maxDuration <= 0 || maxDuration > H3_MAX_DURATION) throw new Error("H3 时长上限超出当前验证范围");
  if (duration > maxDuration + 1e-8) throw new Error(`H3 镜头 ${duration.toFixed(3)} 秒超过 ${maxDuration} 秒上限，请拆分镜头`);
  const frames = Math.max(MIN_NATIVE_FRAMES, Math.ceil((duration * H3_FPS - 5 - 1e-8) / 17) * 17 + 5);
  if (frames > MAX_NATIVE_FRAMES) throw new Error("H3 原生帧数超过当前验证范围，请拆分镜头");
  return frames;
}

/** Divide one TTS group on the final 24 fps timeline, without LTX's 8k+1 grid. */
export function distributeH3PanelDurations(groupSeconds: number, panelCount: number): number[] {
  if (!Number.isFinite(groupSeconds) || groupSeconds <= 0 || !Number.isInteger(panelCount) || panelCount < 1) throw new Error("H3 分镜时长分配参数无效");
  const totalFrames = Math.round(groupSeconds * H3_FPS);
  if (totalFrames < panelCount) throw new Error("H3 组时长不足以为每个镜头分配一帧");
  const base = Math.floor(totalFrames / panelCount);
  const remainder = totalFrames % panelCount;
  return Array.from({length: panelCount}, (_, index) => (base + (index < remainder ? 1 : 0)) / H3_FPS);
}

const nodeIds = (graph: H3ApiWorkflow, classType: string): string[] =>
  Object.keys(graph).filter((id) => graph[id].class_type === classType);
const onlyNode = (graph: H3ApiWorkflow, classType: string): string => {
  const ids = nodeIds(graph, classType);
  if (ids.length !== 1) throw new Error(`H3 API 工作流必须恰好包含一个 ${classType} 节点`);
  return ids[0];
};

export function validateH3Workflow(value: unknown): asserts value is H3ApiWorkflow {
  if (!value || typeof value !== "object" || Array.isArray(value) || "nodes" in value || "links" in value) throw new Error("H3 必须使用 ComfyUI API 工作流，不能使用 UI 工作流");
  const graph = value as H3ApiWorkflow;
  if (!Object.keys(graph).length || Object.values(graph).some((node) => !node || typeof node.class_type !== "string" || !node.inputs || typeof node.inputs !== "object" || Array.isArray(node.inputs))) throw new Error("H3 API 工作流格式无效");
  onlyNode(graph, "MiniMaxH3ReferenceToVideo");
  onlyNode(graph, "SaveVideo");
  onlyNode(graph, "CreateVideo");
  if (!nodeIds(graph, "BasicGuider").length || !nodeIds(graph, "RandomNoise").length) throw new Error("H3 API 工作流缺少采样节点");
}

export interface H3WorkflowInputs {
  references: string[];
  prompt: string;
  firstFrame?: string;
  aspectRatio: string;
  duration: number;
  seed: number;
  filenamePrefix: string;
  maxDuration?: number;
}

/** Build a request copy; ordinary Picture references and frame-zero guide never share a slot. */
export function buildH3Workflow(template: H3ApiWorkflow, input: H3WorkflowInputs): H3ApiWorkflow {
  validateH3Workflow(template);
  if (!input.references.length || input.references.length > 9) throw new Error("H3 须提供 1–9 张普通参考图");
  if (!input.prompt.trim()) throw new Error("H3 视频提示词不能为空");
  for (const match of input.prompt.matchAll(/<Picture\s+(\d+)>/g)) {
    if (Number(match[1]) < 1 || Number(match[1]) > input.references.length) throw new Error(`H3 提示词引用了不存在的 ${match[0]}`);
  }
  if (input.aspectRatio !== "9:16" && input.aspectRatio !== "16:9") throw new Error("H3 仅支持故事的 9:16 或 16:9 画幅");
  const frames = durationToH3Frames(input.duration, input.maxDuration);
  const graph: H3ApiWorkflow = structuredClone(template);
  const refId = onlyNode(graph, "MiniMaxH3ReferenceToVideo");
  const ref = graph[refId];
  // Eliminate every stale reference/guide from a previously submitted API graph.
  for (const key of Object.keys(ref.inputs)) if (/^ref_(images|videos|video_audios|audios)\./.test(key)) delete ref.inputs[key];
  for (const id of nodeIds(graph, "MiniMaxH3AddGuide")) {
    for (const node of Object.values(graph)) {
      for (const [key, value] of Object.entries(node.inputs)) {
        if (Array.isArray(value) && value[0] === id) node.inputs[key] = [refId, 0];
      }
    }
    delete graph[id];
  }
  for (const id of nodeIds(graph, "LoadImage")) delete graph[id];
  const freshId = (label: string): string => {
    let id = `story_h3_${label}`;
    while (graph[id]) id += "_";
    return id;
  };
  const widthLink = ref.inputs.width;
  const heightLink = ref.inputs.height;
  if (Array.isArray(widthLink) && Array.isArray(heightLink)
    && widthLink[0] === heightLink[0] && widthLink[1] === 0 && heightLink[1] === 1
    && graph[widthLink[0]]?.class_type === "ResolutionSelector") {
    // Keep the official pixel budget and resolution calculation; only change the story's aspect ratio.
    graph[widthLink[0]].inputs.aspect_ratio = input.aspectRatio === "9:16"
      ? "9:16 (Portrait Widescreen)" : "16:9 (Widescreen)";
  } else {
    if (Array.isArray(widthLink) || Array.isArray(heightLink)) throw new Error("H3 分辨率接线须来自同一个 ResolutionSelector");
    const shortSide = Math.min(Number(widthLink) || 416, Number(heightLink) || 736);
    const longSide = Math.max(Number(widthLink) || 416, Number(heightLink) || 736);
    const dimensions = input.aspectRatio === "9:16" ? [shortSide, longSide] : [longSide, shortSide];
    Object.assign(ref.inputs, {width: dimensions[0], height: dimensions[1]});
  }
  Object.assign(ref.inputs, {prompt: input.prompt, length: frames});
  input.references.forEach((image, index) => {
    const id = freshId(`reference_${index}`);
    graph[id] = {class_type: "LoadImage", inputs: {image}};
    ref.inputs[`ref_images.ref_image_${index}`] = [id, 0];
  });
  if (input.firstFrame) {
    const imageId = freshId("first_frame");
    graph[imageId] = {class_type: "LoadImage", inputs: {image: input.firstFrame}};
    const guideId = freshId("guide");
    if (!ref.inputs.vae) throw new Error("H3 首帧引导需要视频 VAE");
    graph[guideId] = {class_type: "MiniMaxH3AddGuide", inputs: {
      positive: [refId, 0], vae: structuredClone(ref.inputs.vae), latent: [refId, 1], image: [imageId, 0], frame_idx: 0,
    }};
    for (const id of nodeIds(graph, "BasicGuider")) graph[id].inputs.conditioning = [guideId, 0];
  } else {
    for (const id of nodeIds(graph, "BasicGuider")) graph[id].inputs.conditioning = [refId, 0];
  }
  for (const id of nodeIds(graph, "RandomNoise")) graph[id].inputs.noise_seed = input.seed;
  graph[onlyNode(graph, "CreateVideo")].inputs.fps = H3_FPS;
  graph[onlyNode(graph, "SaveVideo")].inputs.filename_prefix = input.filenamePrefix;
  for (const node of Object.values(graph)) {
    for (const value of Object.values(node.inputs)) {
      if (Array.isArray(value) && typeof value[0] === "string" && typeof value[1] === "number" && !graph[value[0]]) throw new Error(`H3 工作流存在失效连接: ${value[0]}`);
    }
  }
  return graph;
}

const sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
const request = async (url: string, init: RequestInit, deadline: number): Promise<Response> => {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("H3 请求超时");
  return fetch(url, {...init, signal: AbortSignal.timeout(Math.min(30_000, remaining))});
};
const responseJson = async (response: Response, action: string): Promise<any> => {
  if (!response.ok) throw new Error(`${action}失败: HTTP ${response.status} ${(await response.text()).slice(0, 600)}`);
  return response.json();
};

async function uploadImage(baseUrl: string, imagePath: string, requestId: string, index: number, deadline: number): Promise<string> {
  const file = await fs.readFile(imagePath);
  const extension = path.extname(imagePath).toLowerCase();
  const mime = extension === ".jpg" || extension === ".jpeg" ? "image/jpeg" : extension === ".webp" ? "image/webp" : "image/png";
  const form = new FormData();
  form.append("image", new Blob([file], {type: mime}), `ref_${index}${extension || ".png"}`);
  form.append("type", "input");
  form.append("subfolder", `story_claw_h3/${requestId}`);
  form.append("overwrite", "false");
  const result = await responseJson(await request(`${baseUrl}/upload/image`, {method: "POST", body: form}, deadline), "H3 参考图上传");
  if (typeof result.name !== "string" || !result.name) throw new Error("ComfyUI 上传未返回图片名称");
  return [result.subfolder, result.name].filter(Boolean).join("/");
}

async function renderNative(graph: H3ApiWorkflow, config: StoryVideoConfig, nativePath: string, deadline: number): Promise<void> {
  let response: Response;
  try {
    response = await request(`${config.baseUrl}/prompt`, {
      method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({prompt: graph}),
    }, deadline);
  } catch (error) {
    // A timed-out or disconnected POST may already have entered ComfyUI's queue.
    throw new H3SubmissionUnknownError("H3 提交响应丢失，任务可能仍在服务器运行；为避免重复 GPU 任务，不自动重新提交", {cause: error});
  }
  // A received failure response is an explicit rejection and may be retried.
  if (!response.ok) await responseJson(response, "H3 提交");
  let submitted: any;
  try { submitted = await response.json(); }
  catch (error) {
    throw new H3SubmissionUnknownError("H3 提交成功响应无法解析，任务可能仍在服务器运行；为避免重复 GPU 任务，不自动重新提交", {cause: error});
  }
  if (submitted && Object.keys(submitted.node_errors ?? {}).length) throw new Error(`H3 提交被拒绝: ${JSON.stringify(submitted.node_errors).slice(0, 1000)}`);
  if (typeof submitted?.prompt_id !== "string" || !submitted.prompt_id.trim()) throw new H3SubmissionUnknownError("H3 提交成功响应没有有效任务 ID，任务可能仍在服务器运行；为避免重复 GPU 任务，不自动重新提交");
  const saveId = onlyNode(graph, "SaveVideo");
  let consecutivePollErrors = 0;
  while (Date.now() < deadline) {
    await sleep(Math.min(config.pollIntervalMs, Math.max(1, deadline - Date.now())));
    let history: any;
    try {
      history = await responseJson(await request(`${config.baseUrl}/history/${encodeURIComponent(submitted.prompt_id)}`, {}, deadline), "H3 状态查询");
      consecutivePollErrors = 0;
    } catch (error) {
      // The accepted GPU job can still be running; do not queue duplicates on a transient poll failure.
      consecutivePollErrors += 1;
      if (consecutivePollErrors > 3 || Date.now() >= deadline) throw new Error(`H3 已提交任务 ${submitted.prompt_id} 的状态查询失败；任务可能仍在服务器运行`, {cause: error});
      continue;
    }
    const entry = history[submitted.prompt_id];
    if (!entry) continue;
    if (entry.status?.status_str === "error") throw new Error(`H3 生成失败: ${JSON.stringify(entry.status).slice(0, 1200)}`);
    if (entry.status?.status_str !== "success" && !entry.status?.completed) continue;
    const files = entry.outputs?.[saveId]?.videos ?? entry.outputs?.[saveId]?.images;
    const video = files?.find((file: any) => typeof file.filename === "string" && /\.(mp4|webm|mov|mkv)$/i.test(file.filename));
    if (!video) throw new Error(`H3 SaveVideo ${saveId} 未返回视频文件`);
    const query = new URLSearchParams({filename: video.filename, subfolder: video.subfolder ?? "", type: video.type ?? "output"});
    const downloaded = await request(`${config.baseUrl}/view?${query}`, {}, deadline);
    if (!downloaded.ok) throw new Error(`H3 下载失败: HTTP ${downloaded.status}`);
    const bytes = Buffer.from(await downloaded.arrayBuffer());
    if (!bytes.length) throw new Error("H3 下载视频为空");
    await fs.mkdir(path.dirname(nativePath), {recursive: true});
    await fs.writeFile(nativePath, bytes);
    return;
  }
  throw new Error("H3 生成超时");
}

/** Keep native motion speed: trim excess frames or freeze a short tail, never stretch a long shot. */
export async function normalizeH3Video(nativePath: string, outputPath: string, aspectRatio: string, duration: number): Promise<void> {
  const targetFrames = Math.round(duration * H3_FPS);
  if (targetFrames < 1) throw new Error("H3 目标视频不足一帧");
  const [width, height] = aspectRatio === "16:9" ? [1280, 720] : [720, 1280];
  const tempPath = path.join(path.dirname(outputPath), `.h3-${randomUUID()}.mp4`);
  await fs.mkdir(path.dirname(outputPath), {recursive: true});
  try {
    const filter = [
      `scale=${width}:${height}:force_original_aspect_ratio=increase`,
      `crop=${width}:${height}`, "setsar=1", "setpts=PTS-STARTPTS", `fps=${H3_FPS}`,
      `tpad=stop_mode=clone:stop_duration=${(targetFrames / H3_FPS).toFixed(8)}`,
      `trim=end_frame=${targetFrames}`, "setpts=PTS-STARTPTS",
    ].join(",");
    await execFileAsync(resolveMediaCommand("ffmpeg"), [
      "-y", "-i", nativePath, "-map", "0:v:0", "-vf", filter, "-frames:v", String(targetFrames),
      "-r", String(H3_FPS), "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p", "-an", "-movflags", "+faststart", tempPath,
    ], {timeout: 300_000, maxBuffer: 2 * 1024 * 1024});
    const {stdout} = await execFileAsync(resolveMediaCommand("ffprobe"), ["-v", "error", "-count_frames", "-show_entries", "stream=codec_type,nb_read_frames,r_frame_rate", "-of", "json", tempPath]);
    const streams = JSON.parse(String(stdout)).streams ?? [];
    const video = streams.find((stream: any) => stream.codec_type === "video");
    if (Number(video?.nb_read_frames) !== targetFrames || video?.r_frame_rate !== "24/1" || streams.some((stream: any) => stream.codec_type === "audio")) throw new Error("H3 时间轴视频规格校验失败");
    await fs.rename(tempPath, outputPath);
  } finally {
    await fs.unlink(tempPath).catch(() => {});
  }
}

const limiters = new Map<string, {active: number; queue: Array<() => void>}>();
async function withLimit<T>(config: StoryVideoConfig, operation: () => Promise<T>): Promise<T> {
  const key = `${config.baseUrl}:${config.concurrency}`;
  const limiter = limiters.get(key) ?? {active: 0, queue: []};
  limiters.set(key, limiter);
  if (limiter.active >= config.concurrency) await new Promise<void>((resolve) => limiter.queue.push(resolve));
  else limiter.active += 1;
  try { return await operation(); }
  finally {
    const next = limiter.queue.shift();
    if (next) next(); else limiter.active -= 1;
  }
}

export interface GenerateH3VideoOptions {
  references: string[];
  prompt: string;
  firstFrame?: string;
  outputPath: string;
  nativePath: string;
  requestPath: string;
  aspectRatio: string;
  duration: number;
}

export async function generateH3Video(input: GenerateH3VideoOptions, config = getStoryVideoConfig()): Promise<void> {
  if (config.fps !== H3_FPS || !Number.isInteger(config.maxRetries) || config.maxRetries < 0 || config.maxRetries > 10 || !Number.isInteger(config.concurrency) || config.concurrency < 1 || !Number.isFinite(config.pollIntervalMs) || config.pollIntervalMs < 1 || !Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0) throw new Error("H3 调用配置无效");
  durationToH3Frames(input.duration, config.maxDuration);
  const canonical = (file: string) => process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file);
  if (new Set([input.outputPath, input.nativePath, input.requestPath, config.workflowPath].map(canonical)).size !== 4) throw new Error("H3 输出、原生视频、请求文件和工作流模板路径必须各不相同");
  const outputs = new Set([input.outputPath, input.nativePath, input.requestPath].map(canonical));
  if ([...input.references, ...(input.firstFrame ? [input.firstFrame] : [])].some((file) => outputs.has(canonical(file)))) throw new Error("H3 产物路径不能覆盖输入参考图");
  const template = JSON.parse(await fs.readFile(config.workflowPath, "utf8"));
  validateH3Workflow(template);
  // Validate the request before uploads, and never overwrite the source workflow.
  buildH3Workflow(template, {...input, seed: 0, filenamePrefix: "validation", maxDuration: config.maxDuration});
  await withLimit(config, async () => {
    const requestId = randomUUID();
    const deadline = Date.now() + config.timeoutMs;
    const references: string[] = [];
    for (const [index, file] of input.references.entries()) references.push(await uploadImage(config.baseUrl, file, requestId, index, deadline));
    const firstFrame = input.firstFrame ? await uploadImage(config.baseUrl, input.firstFrame, requestId, input.references.length, deadline) : undefined;
    await fs.mkdir(path.dirname(input.requestPath), {recursive: true});
    for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
      const graph = buildH3Workflow(template, {
        ...input, references, firstFrame, maxDuration: config.maxDuration,
        seed: randomBytes(6).readUIntBE(0, 6), filenamePrefix: `story_claw_h3/${requestId}/attempt_${attempt + 1}`,
      });
      await fs.writeFile(input.requestPath, JSON.stringify({prompt: graph}, null, 2) + "\n", "utf8");
      try {
        await renderNative(graph, config, input.nativePath, deadline);
        await normalizeH3Video(input.nativePath, input.outputPath, input.aspectRatio, input.duration);
        return;
      } catch (error) {
        if (attempt === config.maxRetries || Date.now() >= deadline || error instanceof H3SubmissionUnknownError || (error instanceof Error && error.message.includes("任务可能仍在服务器运行"))) throw error;
        console.warn(`[H3] 第 ${attempt + 1} 次失败，重新随机种子重试: ${error instanceof Error ? error.message : error}`);
        await sleep(Math.min(1000, Math.max(1, deadline - Date.now())));
      }
    }
  });
}

/** Read-only node/model availability check; it never queues a GPU generation job. */
export async function checkH3RenderService(config = getStoryVideoConfig()): Promise<void> {
  if (!Number.isFinite(config.timeoutMs) || config.timeoutMs < 1 || !Number.isFinite(config.pollIntervalMs) || config.pollIntervalMs < 1) throw new Error("H3 自检超时或轮询间隔无效");
  if (new URL(config.baseUrl).port === "8191") throw new Error("H3 不能使用 LTX wrapper 的 8191 端口");
  const graph = JSON.parse(await fs.readFile(config.workflowPath, "utf8"));
  validateH3Workflow(graph);
  const deadline = Date.now() + Math.min(config.timeoutMs, 180_000);
  let info: any;
  let lastNotReady: unknown;
  while (Date.now() < deadline) {
    try {
      let response: Response;
      try {
        response = await request(`${config.baseUrl}/object_info`, {}, deadline);
      } catch (error) {
        throw new H3ServiceNotReadyError(`H3 服务暂不可连接: ${error instanceof Error ? error.message : error}`);
      }
      if (!response.ok) {
        if ([404, 408, 425, 429].includes(response.status) || response.status >= 500) throw new H3ServiceNotReadyError(`H3 服务尚未就绪: HTTP ${response.status}`);
        throw new Error(`H3 服务自检失败: HTTP ${response.status} ${(await response.text()).slice(0, 500)}`);
      }
      let parsed: unknown;
      try { parsed = await response.json(); }
      catch { throw new H3ServiceNotReadyError("H3 服务尚未返回有效的节点信息 JSON"); }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new H3ServiceNotReadyError("H3 服务返回的节点信息格式无效");
      info = parsed;
      break;
    } catch (error) {
      if (!(error instanceof H3ServiceNotReadyError)) throw error;
      lastNotReady = error;
      if (Date.now() >= deadline) break;
      await sleep(Math.min(config.pollIntervalMs, Math.max(1, deadline - Date.now())));
    }
  }
  if (!info) throw new Error(`等待 H3 ComfyUI 服务就绪超时（最多 ${Math.min(config.timeoutMs, 180_000) / 1000} 秒）：${lastNotReady instanceof Error ? lastNotReady.message : "未取得节点信息"}`);
  // A successfully returned node registry is authoritative: missing nodes/models fail immediately.
  for (const type of new Set([...Object.values(graph).map((node) => node.class_type), "LoadImage", "MiniMaxH3AddGuide"])) {
    if (!info[type]) throw new Error(`ComfyUI 缺少 H3 工作流节点: ${type}`);
  }
  for (const node of Object.values(graph)) {
    const required = info[node.class_type]?.input?.required ?? {};
    for (const key of Object.keys(required)) {
      if (!(key in node.inputs) && !Object.keys(node.inputs).some((input) => input.startsWith(`${key}.`))) {
        throw new Error(`H3 工作流节点 ${node.class_type} 缺少服务器必填输入: ${key}`);
      }
    }
    const field = node.class_type === "UNETLoader" ? "unet_name" : node.class_type === "CLIPLoader" ? "clip_name" : node.class_type === "VAELoader" ? "vae_name" : null;
    if (!field) continue;
    const names = info[node.class_type]?.input?.required?.[field]?.[0];
    if (!Array.isArray(names) || !names.includes(node.inputs[field])) throw new Error(`ComfyUI 缺少 H3 模型文件: ${node.inputs[field]}`);
  }
}

/** A real minimum-length inference: load models, sample, decode both VAEs and verify a playable video. */
export async function warmH3RenderService(config = getStoryVideoConfig()): Promise<string> {
  await checkH3RenderService(config);
  const directory = path.join(PATHS.h3Warmups, randomUUID());
  await fs.mkdir(directory, {recursive: true});
  const reference = path.join(directory, "reference.png");
  const workflowPath = path.join(directory, "workflow.json");
  const nativePath = path.join(directory, "native.mp4");
  const outputPath = path.join(directory, "warmup.mp4");
  const {default: sharp} = await import("sharp");
  await sharp({create: {width: 256, height: 256, channels: 3, background: "#8b9aab"}}).png().toFile(reference);
  const graph = JSON.parse(await fs.readFile(config.workflowPath, "utf8")) as H3ApiWorkflow;
  // Only reduce sampling work. Keep the validated pixel budget, minimum native frames and audio/video decode path.
  const schedulers = nodeIds(graph, "BasicScheduler");
  if (!schedulers.length) throw new Error("H3 预热需要 BasicScheduler，不能跳过实际采样");
  for (const id of schedulers) graph[id].inputs.steps = 1;
  await fs.writeFile(workflowPath, JSON.stringify(graph, null, 2));
  await generateH3Video({references: [reference], prompt: "A quiet plain scene with a small gentle camera motion. No text.",
    outputPath, nativePath, requestPath: path.join(directory, "request.json"), aspectRatio: "16:9", duration: 1 / H3_FPS},
    {...config, workflowPath, maxRetries: 0});
  const {stdout} = await execFileAsync(resolveMediaCommand("ffprobe"), ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames,r_frame_rate", "-of", "json", nativePath], {timeout: 120_000});
  const stream = JSON.parse(String(stdout)).streams?.[0];
  if (Number(stream?.nb_read_frames) < MIN_NATIVE_FRAMES || stream?.r_frame_rate !== "24/1") throw new Error("H3 预热原生视频帧数或帧率不合格");
  await execFileAsync(resolveMediaCommand("ffmpeg"), ["-v", "error", "-xerror", "-i", nativePath, "-f", "null", "-"], {timeout: 120_000, maxBuffer: 1024 * 1024});
  await fs.writeFile(path.join(directory, "completed.json"), JSON.stringify({backend: "h3", nativeFrames: Number(stream.nb_read_frames), fps: H3_FPS, completedAt: new Date().toISOString()}));
  return nativePath;
}
