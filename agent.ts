/**
 * agent.ts — Agent 基础设施
 *
 * 提供：
 * - getSharedResources()     共享资源（单例）
 * - createSession()          创建 Agent Session
 * - runSubAgent()            Sub-agent 运行器
 */

import fs from "node:fs/promises";
import { readFileSync, createWriteStream, mkdirSync } from "node:fs";
import path from "node:path";
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSession,
  writeTool,
  readTool,
} from "@mariozechner/pi-coding-agent";
import { PATHS } from "./utils/paths.js";
import { CONFIG_DIR } from "./utils/run-python.js";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";

// ─── 配置文件加载 ──────────────────────────────────────────────

const SUPPORTED_PROVIDERS = ["openai", "anthropic", "google"] as const;
type Provider = typeof SUPPORTED_PROVIDERS[number];

const API_FORMAT: Record<Provider, string> = {
  openai:    "openai-completions",
  anthropic: "anthropic-messages",
  google:    "google-generative-ai",
};

interface ConfigFile {
  provider: Provider;
  model: string;
  api_key: string;
  base_url?: string;  // 可选，不填则使用官方 API
}

const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

function loadConfig(): ConfigFile {
  try {
    const content = readFileSync(CONFIG_PATH, "utf-8");
    const cfg = JSON.parse(content);

    if (!cfg.provider || !cfg.model || !cfg.api_key) {
      throw new Error("缺少必填字段: provider, model, api_key");
    }
    if (!SUPPORTED_PROVIDERS.includes(cfg.provider)) {
      throw new Error(`provider 必须是 ${SUPPORTED_PROVIDERS.join(" / ")}，当前: "${cfg.provider}"`);
    }

    return cfg as ConfigFile;
  } catch (err) {
    console.error(
      `配置文件读取失败: ${CONFIG_PATH}\n` +
      `  必填: provider (openai/anthropic/google), model, api_key\n` +
      `  可选: base_url（不填则使用官方 API）\n` +
      `  错误: ${err}`,
    );
    process.exit(1);
  }
}

// ─── 共享资源（只初始化一次） ──────────────────────────────────────

const DATA_DIR = PATHS.agentData;
const AGENT_LOGS_DIR = path.join(path.dirname(DATA_DIR), "agent-logs");

let _authStorage: AuthStorage | null = null;
let _modelRegistry: ModelRegistry | null = null;
let _model: any = null;
let _settingsManager: any = null;

export async function getSharedResources() {
  if (_authStorage) {
    return {
      authStorage: _authStorage,
      modelRegistry: _modelRegistry!,
      model: _model!,
      settingsManager: _settingsManager!,
    };
  }

  const config = loadConfig();
  const { provider, model: modelId, api_key: apiKey, base_url: baseUrl } = config;

  await fs.mkdir(DATA_DIR, { recursive: true });

  const authStorage = new AuthStorage(path.join(DATA_DIR, "auth.json"));
  authStorage.setRuntimeApiKey(provider, apiKey);

  const modelRegistry = new ModelRegistry(authStorage, path.join(DATA_DIR, "models.json"));

  let model = modelRegistry.find(provider, modelId);

  if (!model) {
    const api = API_FORMAT[provider as Provider];
    try {
      modelRegistry.registerProvider(provider, {
        ...(baseUrl ? { baseUrl } : {}),
        apiKey,
        models: [{
          id: modelId,
          name: modelId,
          api,
          reasoning: true,
          input: ["text", "image"],
          compat: { supportsDeveloperRole: false },
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200000,
          maxTokens: 64000,
        }],
      });
      model = modelRegistry.find(provider, modelId);
    } catch {
      // 继续走报错逻辑
    }
  }

  if (!model) {
    console.error(`Model not found: ${provider}/${modelId}`);
    process.exit(1);
  }

  const settingsManager = SettingsManager.create(process.cwd(), DATA_DIR);

  _authStorage = authStorage;
  _modelRegistry = modelRegistry;
  _model = model;
  _settingsManager = settingsManager;

  return { authStorage, modelRegistry, model, settingsManager };
}

// ─── Session 创建 ──────────────────────────────────────────────

export async function createSession(
  sessionFile: string,
  customTools: ToolDefinition[],
  systemPrompt: string,
): Promise<AgentSession> {
  const { authStorage, modelRegistry, model, settingsManager } = await getSharedResources();
  const sessionManager = SessionManager.open(sessionFile);

  const { session } = await createAgentSession({
    cwd: process.cwd(),
    agentDir: DATA_DIR,
    authStorage,
    modelRegistry,
    model,
    tools: [writeTool, readTool],
    customTools,
    sessionManager,
    settingsManager,
  });

  session.agent.setSystemPrompt(systemPrompt);
  return session;
}

// ─── 事件类型 ──────────────────────────────────────────────────

type AgentEvent = {
  type: string;
  message?: { role?: string; content?: Array<{ type: string; text?: string }> };
  assistantMessageEvent?: { type: string; delta?: string; content?: string };
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
};

// ─── Sub-agent 运行器 ──────────────────────────────────────────

const SESSION_FILE = path.join(DATA_DIR, "session.jsonl");

export async function runSubAgent(
  customTools: ToolDefinition[],
  systemPrompt: string,
  taskPrompt: string,
  logPrefix = "[Sub]",
): Promise<string> {
  const tempFile = path.join(
    DATA_DIR,
    `sub_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.jsonl`,
  );

  mkdirSync(AGENT_LOGS_DIR, { recursive: true });
  const safePrefix = logPrefix.replace(/[[\]:\/\\]/g, "_");
  const logPath = path.join(AGENT_LOGS_DIR, `${safePrefix}_${Date.now()}.log`);
  const logStream = createWriteStream(logPath, { encoding: "utf-8" });

  const session = await createSession(tempFile, customTools, systemPrompt);

  let lastText = "";
  let currentText = "";

  const unsub = session.subscribe((evt: AgentEvent) => {
    if (evt.type === "message_update" && evt.assistantMessageEvent) {
      const ame = evt.assistantMessageEvent;
      if (ame.type === "text_delta" && ame.delta) {
        logStream.write(ame.delta);
        currentText += ame.delta;
      }
    }
    if (evt.type === "message_end") {
      const msg = evt.message as { role?: string; errorMessage?: string };
      if (msg?.errorMessage) {
        console.error(`\n${logPrefix} [Error] ${msg.errorMessage}`);
      }
      if (currentText) {
        lastText = currentText;
        currentText = "";
      }
    }
    if (evt.type === "tool_execution_start" && evt.toolName) {
      console.log(`\n${logPrefix} [Tool] ${evt.toolName}`);
    }
    if (evt.type === "tool_execution_end" && evt.toolName) {
      console.log(`${logPrefix} [Tool] ${evt.toolName} -> ${evt.isError ? "FAILED" : "OK"}`);
      if (evt.isError) {
        console.error(`${logPrefix} [详情] ${logPath}`);
      }
    }
  });

  try {
    await session.prompt(taskPrompt);
  } finally {
    unsub();
    logStream.end();
    try { await fs.unlink(tempFile); } catch { /* 临时文件删除失败忽略 */ }
  }

  return lastText || "(无输出)";
}
