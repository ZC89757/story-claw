import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {CONFIG_DIR, WORK_DIR} from "./runtime-paths.js";

/** Shared H3 configuration for story, essay panels and generated MG video. */
export interface StoryVideoConfig {
  baseUrl: string;
  workflowPath: string;
  maxDuration: number;
  fps: 24;
  concurrency: number;
  maxRetries: number;
  pollIntervalMs: number;
  timeoutMs: number;
}

export const H3_FPS = 24 as const;
export const H3_MAX_DURATION = 15;

const positive = (value: unknown, fallback: number): number => {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error("H3 视频配置必须是正数");
  return number;
};

/** Resolve both source checkouts and the compiled desktop runtime's bundled asset. */
export function bundledH3WorkflowPath(): string {
  const candidates = [
    new URL("../workflows/minimax-h3-reference-api.json", import.meta.url),
    new URL("../../../workflows/minimax-h3-reference-api.json", import.meta.url),
  ].map((url) => fileURLToPath(url));
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

/** Legacy backend fields are intentionally ignored; H3 is the only generation backend. */
export function getStoryVideoConfig(configPath = path.join(CONFIG_DIR, "video_config.json")): StoryVideoConfig {
  const raw = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
  const configuredWorkflow = raw.h3_workflow_path;
  if (configuredWorkflow !== undefined && typeof configuredWorkflow !== "string") throw new Error("H3 工作流路径须为字符串");
  const workflowPath = configuredWorkflow?.trim()
    ? path.resolve(WORK_DIR, configuredWorkflow.trim())
    : bundledH3WorkflowPath();
  const maxDuration = positive(raw.h3_max_duration, H3_MAX_DURATION);
  if (maxDuration < 0.1 || maxDuration > H3_MAX_DURATION) {
    throw new Error(`H3 目标时长上限须在 0.1–${H3_MAX_DURATION} 秒之间，请拆分过长镜头`);
  }
  const retryValue = Number(raw.h3_max_retries ?? 2);
  if (!Number.isInteger(retryValue) || retryValue < 0 || retryValue > 10) throw new Error("H3 视频重试次数须为 0–10 的整数");
  const concurrency = positive(raw.h3_concurrency, 1);
  if (!Number.isInteger(concurrency) || concurrency > 16) throw new Error("H3 并发须为 1–16 的整数");
  const baseUrl = String(raw.h3_base_url || "http://127.0.0.1:8188").replace(/\/+$/, "");
  const serviceUrl = new URL(baseUrl);
  if (!["http:", "https:"].includes(serviceUrl.protocol)) throw new Error("H3 服务地址须为 HTTP 或 HTTPS");
  if (serviceUrl.port === "8191") throw new Error("H3 必须直连 ComfyUI（通常 8188），不能使用 旧处理服务的 8191 端口");
  const pollIntervalMs = positive(raw.h3_poll_interval_ms, 5000);
  const timeoutMs = positive(raw.h3_timeout_ms, 1_800_000);
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs > 600_000) throw new Error("H3 轮询间隔须为 1–600000 毫秒的整数");
  if (!Number.isInteger(timeoutMs) || timeoutMs > 86_400_000) throw new Error("H3 超时须为 1–86400000 毫秒的整数");
  return {
    baseUrl,
    workflowPath,
    maxDuration,
    fps: H3_FPS,
    concurrency,
    maxRetries: retryValue,
    pollIntervalMs,
    timeoutMs,
  };
}
