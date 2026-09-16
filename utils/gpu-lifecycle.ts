import {createHash} from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {CONFIG_DIR, WORK_DIR} from "./runtime-paths.js";

type GpuConfig = {
  provider?: string;
  public_key?: string;
  private_key?: string;
  instance_id?: string;
  start_timeout?: number;
  stop_timeout?: number;
  base_url?: string;
};

type VideoConfig = {base_url?: string; workflow_path?: string};
type JsonObject = Record<string, any>;

const API_URL = "https://api.compshare.cn";
const TEST_IMAGE_B64 = "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAS0lEQVR42u3PMQ0AAAwDoDqv9UrYvQQckD4XAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAYHLANtV0Vq+zpWkAAAAAElFTkSuQmCC";
const sleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));
const now = (): string => new Date().toLocaleTimeString("zh-CN", {hour12: false});

const readJson = async <T>(filePath: string): Promise<T> => JSON.parse(await fs.readFile(filePath, "utf8")) as T;
const gpuConfig = (): Promise<GpuConfig> => readJson(path.join(CONFIG_DIR, "gpu_config.json"));

export const flattenGpuApiParams = (input: JsonObject, prefix = "", output: Record<string, string> = {}): Record<string, string> => {
  for (const [key, raw] of Object.entries(input)) {
    if (raw === null || raw === undefined) continue;
    const name = prefix ? `${prefix}.${key}` : key;
    if (Array.isArray(raw)) {
      raw.forEach((value, index) => flattenGpuApiParams({[index]: value}, name, output));
    } else if (typeof raw === "object") {
      flattenGpuApiParams(raw, name, output);
    } else {
      output[name] = typeof raw === "boolean" ? String(raw).toLowerCase() : String(raw);
    }
  }
  return output;
};

export const signGpuApiParams = (params: Record<string, string>, privateKey: string): string => {
  const content = Object.keys(params).sort().map((key) => `${key}${params[key]}`).join("") + privateKey;
  return createHash("sha1").update(content, "utf8").digest("hex");
};

const invokeCompShare = async (config: GpuConfig, action: string, params: JsonObject): Promise<JsonObject> => {
  const publicKey = process.env.COMPSHARE_PUBLIC_KEY || config.public_key || "";
  const privateKey = process.env.COMPSHARE_PRIVATE_KEY || config.private_key || "";
  if (!publicKey || !privateKey) throw new Error("CompShare GPU 配置缺少 public_key 或 private_key");
  const payload = flattenGpuApiParams({Action: action, ...params, PublicKey: publicKey});
  payload.Signature = signGpuApiParams(payload, privateKey);
  const response = await fetch(config.base_url || API_URL, {
    method: "POST",
    headers: {"content-type": "application/x-www-form-urlencoded", "u-timestamp-ms": String(Date.now())},
    body: new URLSearchParams(payload),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`CompShare ${action} HTTP ${response.status}`);
  const result = await response.json() as JsonObject;
  if (Number(result.RetCode ?? -1) !== 0) {
    throw new Error(`${action} RetCode=${result.RetCode ?? "?"}: ${result.Message || "unknown API error"}`);
  }
  return result;
};

const providerName = (config: GpuConfig): string => (config.provider || "compshare").trim().toLowerCase();
const isExternalProvider = (config: GpuConfig): boolean => ["external", "remote", "none", "manual"].includes(providerName(config));

const locateInstance = async (config: GpuConfig): Promise<{region: string; zone: string; state: string}> => {
  const instanceId = process.env.STORY_CLAW_GPU_INSTANCE || config.instance_id || "";
  if (!instanceId) throw new Error("CompShare GPU 配置缺少 instance_id");
  const result = await invokeCompShare(config, "DescribeCompShareInstance", {UHostIds: [instanceId], Limit: 1, Offset: 0});
  const host = (result.UHostSet || []).find((item: JsonObject) => String(item.UHostId || "") === instanceId);
  if (!host) throw new Error(`找不到 CompShare 实例 ${instanceId}`);
  if (!host.Region || !host.Zone) throw new Error(`实例 ${instanceId} 未返回 Region/Zone`);
  return {region: String(host.Region), zone: String(host.Zone), state: String(host.State || host.Status || "")};
};

const waitForState = async (config: GpuConfig, desired: string, timeoutSeconds: number): Promise<void> => {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let last = "unknown";
  while (Date.now() < deadline) {
    const current = await locateInstance(config);
    last = current.state || "unknown";
    if (last.toLowerCase() === desired.toLowerCase()) return;
    await sleep(5000);
  }
  throw new Error(`等待 GPU 状态 ${desired} 超时，当前状态 ${last}`);
};

const workflowPath = (configured: string): string => path.isAbsolute(configured)
  ? configured
  : path.resolve(WORK_DIR, configured);

const submitHealthCheck = async (baseUrl: string, workflow: JsonObject): Promise<string | null> => {
  const response = await fetch(`${baseUrl}/prompt`, {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({prompt: workflow}),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) return null;
  const result = await response.json() as JsonObject;
  return typeof result.prompt_id === "string" ? result.prompt_id : null;
};

/** Wait until the remote render service completes one minimum-size video request. */
export const waitForRenderService = async (): Promise<void> => {
  const video = await readJson<VideoConfig>(path.join(CONFIG_DIR, "video_config.json"));
  if (!video.workflow_path) throw new Error("video_config.json 缺少 workflow_path");
  const baseUrl = (video.base_url || "http://127.0.0.1:8188").replace(/\/$/, "");
  const workflow = await readJson<JsonObject>(workflowPath(video.workflow_path));
  workflow["324"].inputs.base64_data = TEST_IMAGE_B64;
  workflow["320:319"].inputs.value = "a quiet test scene";
  workflow["320:312"].inputs.value = 1024;
  workflow["320:299"].inputs.value = 1536;
  workflow["320:295"].inputs.length = 9;
  workflow["320:305"].inputs.frames_number = 9;

  console.log(`[${now()}] GPU 实例已启动，正在等待远程渲染服务预热与轻量自检...`);
  let promptId: string | null = null;
  let attempt = 0;
  while (!promptId) {
    attempt += 1;
    try { promptId = await submitHealthCheck(baseUrl, workflow); } catch { /* Keep polling while the service boots. */ }
    if (!promptId) {
      console.log(`[${now()}] 渲染服务尚未就绪（第 ${attempt} 次检测），5 秒后继续...`);
      await sleep(5000);
    }
  }

  let missingSince: number | null = null;
  let polls = 0;
  while (true) {
    await sleep(5000);
    polls += 1;
    try {
      const response = await fetch(`${baseUrl}/history/${promptId}`, {signal: AbortSignal.timeout(10_000)});
      if (!response.ok) continue;
      const result = await response.json() as JsonObject;
      const currentPromptId = promptId;
      if (!currentPromptId) continue;
      const entry = result[currentPromptId];
      if (!entry) {
        missingSince ??= Date.now();
        if (Date.now() - missingSince >= 60_000) {
          console.log(`[${now()}] 自检任务未登记，远程服务可能已重启，正在重新提交...`);
          promptId = null;
          while (!promptId) {
            try { promptId = await submitHealthCheck(baseUrl, workflow); } catch { /* retry */ }
            if (!promptId) await sleep(5000);
          }
          missingSince = null;
          polls = 0;
        }
        continue;
      }
      missingSince = null;
      const status = String(entry.status?.status_str || "");
      if (["success", "queued_sttn", "sttn"].includes(status)) {
        console.log(`[${now()}] GPU 视频生成服务已通过自检（${status}）`);
        return;
      }
      if (status === "error") {
        console.warn(`[${now()}] 轻量自检任务返回 error，将继续运行（可能是后处理阶段暂时异常）`);
        return;
      }
      if (polls % 6 === 0) console.log(`[${now()}] 轻量自检进行中（${polls * 5}s，状态 ${status || "unknown"}）`);
    } catch { /* Transient network errors are expected while booting. */ }
  }
};

/** Start the configured managed GPU, then verify that its video endpoint works. */
export const startGpu = async (): Promise<void> => {
  const config = await gpuConfig();
  if (!isExternalProvider(config)) {
    const instanceId = process.env.STORY_CLAW_GPU_INSTANCE || config.instance_id || "";
    if (!instanceId) throw new Error("CompShare GPU 配置缺少 instance_id");
    const publicKey = process.env.COMPSHARE_PUBLIC_KEY || config.public_key || "";
    const privateKey = process.env.COMPSHARE_PRIVATE_KEY || config.private_key || "";
    if (!publicKey || !privateKey) throw new Error("CompShare GPU 配置缺少 public_key 或 private_key");
    let attempt = 0;
    while (true) {
      attempt += 1;
      try {
        const current = await locateInstance(config);
        if (current.state.toLowerCase() !== "running") {
          await invokeCompShare(config, "StartCompShareInstance", {Region: current.region, Zone: current.zone, UHostId: instanceId});
          await waitForState(config, "Running", Math.max(1, Number(config.start_timeout) || 180));
        }
        console.log(`[${now()}] CompShare GPU 已运行（尝试 ${attempt}）`);
        break;
      } catch (error) {
        const delay = 5000 + Math.floor(Math.random() * 5000);
        console.warn(`[${now()}] GPU 启动尝试 ${attempt} 失败：${error instanceof Error ? error.message : String(error)}；${(delay / 1000).toFixed(1)} 秒后重试`);
        await sleep(delay);
      }
    }
  } else {
    console.log(`[${now()}] GPU provider=${providerName(config)}，跳过云实例启停，仅检测远程服务`);
  }
  await waitForRenderService();
};

/** Stop the configured managed GPU. External/manual providers are left untouched. */
export const stopGpu = async (): Promise<void> => {
  const config = await gpuConfig();
  if (isExternalProvider(config)) return;
  const instanceId = process.env.STORY_CLAW_GPU_INSTANCE || config.instance_id || "";
  if (!instanceId) throw new Error("CompShare GPU 配置缺少 instance_id");
  const current = await locateInstance(config);
  if (current.state.toLowerCase() === "stopped") return;
  await invokeCompShare(config, "StopCompShareInstance", {Region: current.region, Zone: current.zone, UHostId: instanceId});
  await waitForState(config, "Stopped", Math.max(1, Number(config.stop_timeout) || 600));
  console.log(`[${now()}] CompShare GPU 已停止`);
};

/** Read-only diagnostic used by tests and the desktop settings screen. */
export const inspectGpu = async (): Promise<{provider: string; state: string; region?: string; zone?: string}> => {
  const config = await gpuConfig();
  if (isExternalProvider(config)) return {provider: providerName(config), state: "external"};
  const current = await locateInstance(config);
  return {provider: providerName(config), ...current};
};
