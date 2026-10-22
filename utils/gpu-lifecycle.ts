import {createHash} from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {CONFIG_DIR} from "./runtime-paths.js";
import {warmH3RenderService} from "./h3-video.js";
import {getStoryVideoConfig} from "./story-video-config.js";

type GpuConfig = {
  provider?: string;
  public_key?: string;
  private_key?: string;
  instance_id?: string;
  start_timeout?: number;
  stop_timeout?: number;
  base_url?: string;
};

type JsonObject = Record<string, any>;

const API_URL = "https://api.compshare.cn";
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
  let reported = "";
  while (Date.now() < deadline) {
    const current = await locateInstance(config);
    last = current.state || "unknown";
    if (last.toLowerCase() === desired.toLowerCase()) return;
    if (last !== reported) {
      console.log(`[${now()}] GPU 当前状态 ${last}，等待 ${desired}...`);
      reported = last;
    }
    await sleep(5000);
  }
  throw new Error(`等待 GPU 状态 ${desired} 超时，当前状态 ${last}`);
};

/** Model/node availability alone cannot establish that H3 can sample and decode. */
export const waitForRenderService = async (_mode: "h3" = "h3"): Promise<void> => {
  console.log(`[${now()}] 等待 H3 服务，随后执行最小合法长度的实际视频预热...`);
  const preview = await warmH3RenderService(getStoryVideoConfig());
  console.log(`[${now()}] H3 采样、解码与视频校验通过：${preview}`);
};

/** Start the configured managed GPU, then verify that its video endpoint works. */
export const startGpu = async (mode: "h3" = "h3"): Promise<void> => {
  const config = await gpuConfig();
  if (!isExternalProvider(config)) {
    const instanceId = process.env.STORY_CLAW_GPU_INSTANCE || config.instance_id || "";
    if (!instanceId) throw new Error("CompShare GPU 配置缺少 instance_id");
    const publicKey = process.env.COMPSHARE_PUBLIC_KEY || config.public_key || "";
    const privateKey = process.env.COMPSHARE_PRIVATE_KEY || config.private_key || "";
    if (!publicKey || !privateKey) throw new Error("CompShare GPU 配置缺少 public_key 或 private_key");
    const startupDeadline = Date.now() + Math.max(1, Number(config.start_timeout) || 180) * 1000;
    let attempt = 0;
    while (true) {
      attempt += 1;
      try {
        const current = await locateInstance(config);
        if (current.state.toLowerCase() !== "running") {
          // A prior accepted start may still be booting, including after a lost API response.
          if (!["initializing", "starting", "pending"].includes(current.state.toLowerCase())) {
            await invokeCompShare(config, "StartCompShareInstance", {Region: current.region, Zone: current.zone, UHostId: instanceId});
          }
          await waitForState(config, "Running", Math.max(1, (startupDeadline - Date.now()) / 1000));
        }
        console.log(`[${now()}] CompShare GPU 已运行（尝试 ${attempt}）`);
        break;
      } catch (error) {
        if (Date.now() >= startupDeadline) throw new Error(`GPU 启动超时；已停止重试：${error instanceof Error ? error.message : String(error)}`, {cause: error});
        const delay = 5000 + Math.floor(Math.random() * 5000);
        console.warn(`[${now()}] GPU 启动尝试 ${attempt} 失败：${error instanceof Error ? error.message : String(error)}；${(delay / 1000).toFixed(1)} 秒后重试`);
        await sleep(delay);
      }
    }
  } else {
    console.log(`[${now()}] GPU provider=${providerName(config)}，跳过云实例启停，仅检测远程服务`);
  }
  await waitForRenderService(mode);
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
