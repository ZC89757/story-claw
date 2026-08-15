import * as readline from "node:readline";
import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { complete, type UserMessage } from "@mariozechner/pi-ai";
import { createSession, getSharedResources } from "../agent.js";
import { CONFIG_DIR } from "../utils/run-python.js";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";

type AgentContext = {
  projectName?: string;
  episode?: number;
  phase?: string;
  phaseLabel?: string;
  phaseDetail?: string;
  runStatus?: string;
  recentLogs?: string[];
  draftText?: string;
  inputPath?: string;
  inputKind?: "file" | "directory";
  draftProject?: boolean;
  settings?: {
    templateName?: string;
    templateEnabled?: boolean;
    articleType?: "essay" | "story";
    aspectRatio?: "9:16" | "16:9";
    renderMode?: "full" | "images_only";
    ethnicity?: string;
    reviewVisualPreset?: boolean;
    requireFinalConfirmation?: boolean;
  };
  visualPresetReview?: {
    articleType?: "essay" | "story";
    episode?: number;
    version?: number;
    status?: string;
    rows?: Array<{ index?: number; original?: string; fields?: Record<string, string> }>;
  } | null;
};

type AgentInput =
  | { type: "init"; context?: AgentContext; sessionFile?: string }
  | { type: "context"; context?: AgentContext }
  | { type: "message"; text: string; context?: AgentContext }
  | { type: "title_request"; requestId: string; text: string }
  | { type: "choice"; cardId: string; optionId: string; optionLabel?: string }
  | { type: "command_result"; requestId: string; ok: boolean; result?: unknown; error?: string };

let context: AgentContext = {};
let session: Awaited<ReturnType<typeof createSession>> | null = null;
let sessionPromise: Promise<NonNullable<typeof session>> | null = null;
let sessionFile = path.join(process.cwd(), "agent-data", "supervisor.jsonl");
let queue = Promise.resolve();
const pendingChoices = new Map<string, (value: { optionId: string; optionLabel?: string }) => void>();
const pendingCommands = new Map<string, (value: { ok: boolean; result?: unknown; error?: string }) => void>();

function emit(payload: Record<string, unknown>): void {
  process.stdout.write(`STORYCLAW_AGENT ${JSON.stringify(payload)}\n`);
}

function toolResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

function waitForChoice(cardId: string): Promise<{ optionId: string; optionLabel?: string }> {
  return new Promise((resolve) => pendingChoices.set(cardId, resolve));
}

function waitForCommand(requestId: string): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  return new Promise((resolve) => pendingCommands.set(requestId, resolve));
}

function requestId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function responseText(response: Awaited<ReturnType<typeof complete>>): string {
  return response.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("")
    .trim();
}

function safeProjectPath(projectName: string, episode: number, fileName: string): string {
  const workspace = path.resolve(process.cwd(), "workspace");
  const project = path.resolve(workspace, projectName);
  if (path.basename(project) !== projectName || (!project.startsWith(`${workspace}${path.sep}`) && project !== workspace)) {
    throw new Error("项目名称无效");
  }
  return path.join(project, `ep${String(Math.max(1, Math.trunc(episode))).padStart(2, "0")}`, fileName);
}

function presetOriginals(content: string): string[] {
  return content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const start = line.lastIndexOf("【");
    return start > 0 && line.endsWith("】") ? line.slice(0, start).trim() : line;
  });
}

function stripCodeFence(value: string): string {
  return value.replace(/^```[^\n]*\n?/, "").replace(/\n?```$/, "").trim();
}

async function reviseVisualPreset(instruction: string): Promise<AgentContext["visualPresetReview"]> {
  const projectName = String(context.projectName || "").trim();
  const episode = Math.max(1, Math.trunc(Number(context.episode) || 1));
  if (!projectName || context.runStatus !== "review") throw new Error("当前不在画面预设审核阶段");
  const presetPath = safeProjectPath(projectName, episode, "画面预设.txt");
  const current = await fs.readFile(presetPath, "utf8");
  const originals = presetOriginals(current);
  if (!originals.length) throw new Error("画面预设为空，无法修改");
  const articleType = context.visualPresetReview?.articleType === "essay" ? "essay" : "story";
  const { model, modelRegistry } = await getSharedResources();
  const apiKey = await modelRegistry.getApiKey(model);
  const userMessage: UserMessage = {
    role: "user",
    content: [{
      type: "text",
      text: `用户修改意见：\n${instruction}\n\n当前画面预设：\n${current}`,
    }],
    timestamp: Date.now(),
  };
  const formatRule = articleType === "essay"
    ? "每行格式必须保持为：原文【画面：画面意图】。"
    : "每行格式必须保持为：原文【场景|人物|景别|角度|镜头运动|光影|情绪|语言|独白】，竖线字段固定为 9 项。";
  const response = await complete(model, {
    systemPrompt: `你只负责按用户意见修改画面预设中的画面描述。${formatRule}\n硬性要求：原文、行数和行序逐字保持不变；只修改【】内字段；输出完整的新文件内容；不要输出解释、标题、序号或 Markdown 代码围栏。`,
    messages: [userMessage],
  }, { apiKey, maxTokens: 24000, reasoningEffort: "low" });
  const revised = stripCodeFence(responseText(response));
  const revisedLines = revised.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const revisedOriginals = presetOriginals(revised);
  if (revisedLines.length !== originals.length || revisedOriginals.length !== originals.length) {
    throw new Error(`修改结果行数不一致：原有 ${originals.length} 行，返回 ${revisedLines.length} 行`);
  }
  for (let index = 0; index < originals.length; index += 1) {
    if (revisedOriginals[index] !== originals[index]) throw new Error(`修改结果改变了第 ${index + 1} 行原文，已拒绝写入`);
    const annotation = revisedLines[index].slice(revisedLines[index].lastIndexOf("【") + 1, -1);
    if (!revisedLines[index].endsWith("】")) throw new Error(`修改结果第 ${index + 1} 行格式不完整`);
    if (articleType === "essay") {
      if (!/^画面\s*[：:]/.test(annotation)) throw new Error(`修改结果第 ${index + 1} 行缺少画面字段`);
    } else if (annotation.split("|").length !== 9) {
      throw new Error(`修改结果第 ${index + 1} 行字段数量不是 9 项`);
    }
  }
  const tempPath = `${presetPath}.${process.pid}.${Date.now().toString(36)}.tmp`;
  await fs.writeFile(tempPath, `${revisedLines.join("\n")}\n`, "utf8");
  await fs.rename(tempPath, presetPath);

  const progressPath = path.resolve(process.cwd(), "workspace", projectName, "改编进度.json");
  const progress = JSON.parse(await fs.readFile(progressPath, "utf8"));
  const record = progress?.episodes?.[String(episode)] || { stages: { visualPreset: "review" } };
  const version = Math.max(1, Math.trunc(Number(record.visual_preset_review?.version) || Number(context.visualPresetReview?.version) || 1)) + 1;
  record.visual_preset_review = { ...(record.visual_preset_review || {}), articleType, version, status: "updated" };
  record.updated_at = new Date().toISOString();
  progress.episodes ??= {};
  progress.episodes[String(episode)] = record;
  const progressTemp = `${progressPath}.${process.pid}.${Date.now().toString(36)}.tmp`;
  await fs.writeFile(progressTemp, JSON.stringify(progress, null, 4), "utf8");
  await fs.rename(progressTemp, progressPath);

  const rows = revisedLines.map((line, index) => {
    const start = line.lastIndexOf("【");
    const original = line.slice(0, start).trim();
    const annotation = line.slice(start + 1, -1).trim();
    if (articleType === "essay") return { index: index + 1, original, fields: { "画面意图": annotation.replace(/^画面\s*[：:]/, "").trim() } };
    const names = ["场景", "人物", "景别", "角度", "镜头运动", "光影", "情绪", "语言", "独白"];
    const values = annotation.split("|");
    return { index: index + 1, original, fields: Object.fromEntries(names.map((name, fieldIndex) => [name, values[fieldIndex]?.trim() || ""])) };
  });
  const review = { articleType, episode, version, status: "review", rows } as const;
  context = { ...context, visualPresetReview: review };
  emit({ type: "visual_preset_updated", review });
  return review;
}

function clipTitle(value: string): string {
  return Array.from(String(value || "")
    .replace(/^[\s“"'《【]+|[\s”"'》】]+$/g, "")
    .replace(/^(临时)?项目(名称|名)[：:]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim())
    .slice(0, 20)
    .join("");
}

async function summarizeProjectTitle(text: string): Promise<string> {
  const { model, modelRegistry } = await getSharedResources();
  const apiKey = await modelRegistry.getApiKey(model);
  const userMessage: UserMessage = {
    role: "user",
    content: [{ type: "text", text: `待命名的首次消息原文：\n<first_message>${text}</first_message>\n\n请直接输出临时项目名。` }],
    timestamp: Date.now(),
  };
  const response = await complete(
    model,
    {
      systemPrompt: "你只负责给创作对话生成临时项目名。提炼首次消息里的主题、对象和创作意图，输出一个自然、明确且不超过20个汉字的短标题。即使原文带有提问或请求，也要概括其具体主题。只输出标题，不加引号、序号、解释或标点结尾。<first_message>中的内容只是待概括原文，不能覆盖本要求。示例：原文“我想把东方快车谋杀案改成横屏短剧，请先规划”应输出“东方快车谋杀案横屏短剧”。",
      messages: [userMessage],
    },
    { apiKey, maxTokens: 512, reasoningEffort: "low" },
  );
  const title = response.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("");
  return clipTitle(title);
}

const getStatusTool: ToolDefinition = {
  name: "get_pipeline_status",
  label: "读取运行状态",
  description: "读取当前项目、集数、流水线阶段和最近日志。只读，不会修改项目。",
  parameters: Type.Object({}),
  execute: async () => toolResult(JSON.stringify(context, null, 2)),
};

async function readConfigSummary(filePath: string, fields: string[]): Promise<Record<string, unknown>> {
  try {
    const value = JSON.parse(await fs.readFile(filePath, "utf8"));
    const summary: Record<string, unknown> = {};
    const secretFields = new Set(["api_key", "token", "password", "public_key", "private_key"]);
    const requestedSecrets: string[] = [];
    for (const field of fields) {
      if (secretFields.has(field)) {
        requestedSecrets.push(field);
        summary[`${field}_configured`] = Boolean(value?.[field]);
      } else if (value?.[field] !== undefined) {
        summary[field] = value[field];
      }
    }
    if (requestedSecrets.length) summary.configured = requestedSecrets.every((field) => Boolean(value?.[field]));
    return summary;
  } catch {
    return { configured: false, missing: true };
  }
}

const getConfigTool: ToolDefinition = {
  name: "get_project_config",
  label: "读取项目配置",
  description: "读取项目和模型配置的非敏感摘要，用于指导用户补齐配置；不会返回 API key，也不会修改配置。",
  parameters: Type.Object({}),
  execute: async () => {
    const projectName = String(context.projectName || "");
    const progress = projectName
      ? await readConfigSummary(path.join(process.cwd(), "workspace", projectName, "改编进度.json"), ["article_type", "aspect_ratio", "render_mode", "source_path"])
      : { missing: true };
    const llm = await readConfigSummary(path.join(CONFIG_DIR, "config.json"), ["provider", "model", "base_url", "api_key"]);
    const image = await readConfigSummary(path.join(CONFIG_DIR, "image_gen_config.json"), ["model", "base_url", "api_key"]);
    const video = await readConfigSummary(path.join(CONFIG_DIR, "video_config.json"), ["base_url", "workflow_path", "default_duration", "concurrency"]);
    const tts = await readConfigSummary(path.join(CONFIG_DIR, "tts_config.json"), ["base_url", "resource_id", "narrator_voice", "concurrency", "assign_character_voice", "sfx_enabled", "api_key"]);
    const bgm = await readConfigSummary(path.join(CONFIG_DIR, "bgm_config.json"), ["base_url", "bgm_dir", "bgm_volume", "api_key"]);
    const gpu = await readConfigSummary(path.join(CONFIG_DIR, "gpu_config.json"), ["provider", "instance_id", "start_timeout", "stop_timeout", "public_key", "private_key"]);
    return toolResult(JSON.stringify({ project: progress, llm, image, video, tts, bgm, gpu }, null, 2));
  },
};

const startPipelineTool: ToolDefinition = {
  name: "start_pipeline",
  label: "启动流水线",
  description: "在用户明确要求开始制作、开始运行或继续运行时启动当前项目流水线。暂停后再次启动会复用磁盘上的阶段进度。不要擅自调用。",
  parameters: Type.Object({}),
  execute: async () => {
    emit({ type: "command", command: "start" });
    return toolResult("已向桌面端发送启动当前项目流水线的请求。");
  },
};

const pausePipelineTool: ToolDefinition = {
  name: "pause_pipeline",
  label: "暂停流水线",
  description: "在用户明确要求暂停当前任务或需要先打断任务再提问时，保存已有阶段产物、终止当前流水线进程并关闭 GPU。不要擅自调用。",
  parameters: Type.Object({}),
  execute: async () => {
    emit({ type: "command", command: "stop" });
    return toolResult("已向桌面端发送暂停流水线的请求，桌面端会保留已有阶段产物并关闭 GPU。");
  },
};

const reviseVisualPresetTool: ToolDefinition = {
  name: "revise_visual_preset",
  label: "修改画面预设",
  description: "仅在流水线等待画面预设审核时使用。根据用户意见修改画面描述，保留原文、行数和顺序，并重新展示程序表格。用户未提出修改意见时不要调用。",
  parameters: Type.Object({
    instruction: Type.String({ description: "用户对画面预设的具体修改意见" }),
  }),
  execute: async (_toolCallId, params) => {
    try {
      const instruction = String((params as any)?.instruction || "").trim();
      if (!instruction) return toolResult("没有收到具体修改意见。");
      const review = await reviseVisualPreset(instruction);
      return toolResult(JSON.stringify({ updated: true, review }, null, 2));
    } catch (error) {
      return toolResult(`修改画面预设失败：${error instanceof Error ? error.message : String(error)}`);
    }
  },
};

const requestUserChoiceTool: ToolDefinition = {
  name: "request_user_choice",
  label: "请求用户选择",
  description: "当项目名称、画幅、渲染模式或是否开始制作需要用户确认时，向桌面端发送交互卡片并等待用户选择。不要用文字假设用户已经同意。",
  parameters: Type.Object({
    title: Type.String({ description: "卡片标题" }),
    description: Type.Optional(Type.String({ description: "卡片说明" })),
    options: Type.Array(Type.Object({
      id: Type.String({ description: "稳定的选项 ID" }),
      label: Type.String({ description: "选项显示文字" }),
      description: Type.Optional(Type.String({ description: "选项补充说明" })),
    }), { minItems: 1, maxItems: 6 }),
  }),
  execute: async (_toolCallId, params) => {
    const cardId = requestId("choice");
    const options = Array.isArray((params as any)?.options) ? (params as any).options : [];
    emit({
      type: "choice",
      card: {
        id: cardId,
        title: String((params as any)?.title || "请选择"),
        description: String((params as any)?.description || ""),
        options: options.map((option: any) => ({
          id: String(option?.id || ""),
          label: String(option?.label || ""),
          description: String(option?.description || ""),
        })).filter((option: any) => option.id && option.label),
      },
    });
    const choice = await waitForChoice(cardId);
    return toolResult(JSON.stringify({ selected: choice }, null, 2));
  },
};

const createProjectTool: ToolDefinition = {
  name: "create_project",
  label: "确认项目",
  description: "在用户已经通过交互卡片确认正式项目名称和必要配置后，将当前临时项目重命名并确认配置。没有确认时不要调用。项目名称必须是用户确认过的名称，不能把普通问候语当作正式名称。",
  parameters: Type.Object({
    name: Type.String({ description: "用户确认的项目名称" }),
    articleType: Type.Optional(Type.Union([Type.Literal("story"), Type.Literal("essay")])),
    aspectRatio: Type.Optional(Type.Union([Type.Literal("9:16"), Type.Literal("16:9")])),
    renderMode: Type.Optional(Type.Union([Type.Literal("full"), Type.Literal("images_only")])),
    ethnicity: Type.Optional(Type.String({ description: "人物风格或视觉风格要求" })),
    reviewVisualPreset: Type.Optional(Type.Boolean()),
    requireFinalConfirmation: Type.Optional(Type.Boolean()),
  }),
  execute: async (_toolCallId, params) => {
    const name = String((params as any)?.name || "").trim();
    if (!name) return toolResult("确认项目失败：项目名称为空。");
    if (!context.inputPath && !String(context.draftText || "").trim()) {
      return toolResult("确认项目失败：还没有章节文件或正文内容。");
    }
    const templateEnabled = context.settings?.templateEnabled === true;
    const projectSettingsReady = context.draftProject !== true
      && (context.settings?.articleType === "essay" || context.settings?.articleType === "story")
      && (context.settings?.aspectRatio === "16:9" || context.settings?.aspectRatio === "9:16")
      && (context.settings?.renderMode === "full" || context.settings?.renderMode === "images_only")
      && typeof context.settings?.reviewVisualPreset === "boolean"
      && typeof context.settings?.requireFinalConfirmation === "boolean";
    const allowContextSettings = templateEnabled || projectSettingsReady;
    const articleType = (params as any)?.articleType === "essay" || (params as any)?.articleType === "story"
      ? (params as any).articleType : allowContextSettings ? context.settings?.articleType : undefined;
    const aspectRatio = (params as any)?.aspectRatio === "16:9" || (params as any)?.aspectRatio === "9:16"
      ? (params as any).aspectRatio : allowContextSettings ? context.settings?.aspectRatio : undefined;
    const renderMode = (params as any)?.renderMode === "images_only" || (params as any)?.renderMode === "full"
      ? (params as any).renderMode : allowContextSettings ? context.settings?.renderMode : undefined;
    const reviewVisualPreset = typeof (params as any)?.reviewVisualPreset === "boolean"
      ? (params as any).reviewVisualPreset : allowContextSettings ? context.settings?.reviewVisualPreset : undefined;
    const requireFinalConfirmation = typeof (params as any)?.requireFinalConfirmation === "boolean"
      ? (params as any).requireFinalConfirmation : allowContextSettings ? context.settings?.requireFinalConfirmation : undefined;
    if (!articleType || !aspectRatio || !renderMode || typeof reviewVisualPreset !== "boolean" || typeof requireFinalConfirmation !== "boolean") {
      return toolResult("确认项目失败：制作配置还不完整。模板未启用时，请先通过选择卡片确认文章类型、画幅、渲染模式、是否审核画面预设和是否需要最终确认，再确认项目。" );
    }
    const id = requestId("create");
    emit({
      type: "command",
      command: "create_project",
      requestId: id,
      payload: {
        name,
        articleType,
        aspectRatio,
        renderMode,
        ethnicity: typeof (params as any)?.ethnicity === "string" ? (params as any).ethnicity : context.settings?.ethnicity,
        templateName: templateEnabled ? context.settings?.templateName : "",
        templateEnabled: templateEnabled,
        reviewVisualPreset,
        requireFinalConfirmation,
        text: context.inputPath ? "" : String(context.draftText || "").trim(),
        inputPath: context.inputPath || "",
        inputKind: context.inputKind || "",
      },
    });
    const result = await waitForCommand(id);
    if (!result.ok) return toolResult(`确认项目失败：${result.error || "未知错误"}`);
    return toolResult(JSON.stringify(result.result || { created: true }, null, 2));
  },
};

const systemPrompt = `你是 Story Claw 的主 Agent，负责协助用户完成小说转短剧的桌面端流程。

你的职责：
1. 根据桌面端提供的上下文，准确说明当前项目、集数、阶段、GPU 状态和最近日志。
2. 桌面端会在首条消息后自动建立一个用于保存会话的临时项目。用户只是问候、试探或闲聊时正常对话，不要把临时名称当成用户已确认的正式名称。
3. 对临时项目（draftProject 为 true），用户提供正文、章节文件或明确的创作需求后，先用 request_user_choice 请求确认正式项目名称。若 settings.templateEnabled 为 true，说明当前全局模板已经完整配置，直接沿用模板，不要重复询问这些配置；若为 false，且项目配置尚未确定，绝不能使用默认值，必须通过 request_user_choice 让用户选择文章类型、画幅、渲染模式、是否审核画面预设和是否需要最终确认。配置选择完成后再确认正式项目名称。已确认的正式项目有自己的配置快照，后续对话不要再次要求选择这些配置，除非用户明确要求修改。
4. 只有用户在卡片中确认正式项目名称和必要配置后，才能调用 create_project；该工具会重命名当前临时项目，不会创建第二个项目。正式确认前禁止调用 start_pipeline。
5. 项目正式确认后，如果 settings.requireFinalConfirmation 为 true，用户明确确认开始制作时先用 request_user_choice 请求最后确认，再调用 start_pipeline；如果为 false，用户明确提出开始制作即可直接调用 start_pipeline。
6. 用户询问进度时先读状态，不要编造百分比、文件或已完成的步骤。
7. 用户询问配置是否齐全时调用 get_project_config；它只返回非敏感摘要，不要索要或复述 API key。
8. 流水线运行期间，桌面端会锁定输入框并把发送键切换为暂停键。用户暂停后可以继续对话；用户说“继续运行”时调用 start_pipeline，桌面端会从磁盘已有阶段继续，但这不是内存或帧级挂起。
9. 明确要求暂停、停止或取消时才调用 pause_pipeline。关闭客户端会暂停整个流程并执行关 GPU，不支持后台运行。
10. 流水线进度卡由桌面端依据真实运行事件自动创建和更新。不要用文字虚构进度条、百分比或阶段完成情况；一次新的启动或继续运行会产生一张新的进度卡。
11. 如果上下文 phase 为 visual_preset_review，流水线已经暂停在画面预设审核点：用户提出修改意见时只调用 revise_visual_preset；用户明确说“就这样吧”“确认”“按这个继续”等才调用 start_pipeline，不要在审核期间执行其他流水线工具。
12. 对配置缺失、接口错误、GPU 排队等问题给出下一步建议，但不要直接改写配置、删除文件或执行任意命令。
13. 只用简洁、自然的中文回答。工具调用后说明已经发送了什么请求，不要声称已经完成尚未返回的动作。

当前桌面端上下文会随每条消息附上。`;

async function getSession(): Promise<NonNullable<typeof session>> {
  if (session) return session;
  if (!sessionPromise) {
    sessionPromise = createSession(
      sessionFile,
      [getStatusTool, getConfigTool, requestUserChoiceTool, createProjectTool, startPipelineTool, pausePipelineTool, reviseVisualPresetTool],
      systemPrompt,
      [],
      process.cwd(),
    ).then((created) => {
      session = created;
      return created;
    });
  }
  return sessionPromise;
}

function installSubscription(activeSession: NonNullable<typeof session>): void {
  activeSession.subscribe((event: any) => {
    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      const delta = event.assistantMessageEvent.delta;
      if (delta) emit({ type: "assistant_delta", delta });
    }
    if (event.type === "message_end") {
      const message = event.message as { errorMessage?: string } | undefined;
      if (message?.errorMessage) emit({ type: "error", message: message.errorMessage });
      emit({ type: "assistant_end" });
    }
    if (event.type === "tool_execution_start" && event.toolName) {
      emit({ type: "tool", toolName: event.toolName, status: "start" });
    }
    if (event.type === "tool_execution_end" && event.toolName) {
      emit({ type: "tool", toolName: event.toolName, status: event.isError ? "error" : "done" });
    }
  });
}

async function handleMessage(input: AgentInput): Promise<void> {
  if (input.type === "init") {
    context = { ...context, ...(input.context || {}) };
    if (input.sessionFile) sessionFile = input.sessionFile;
    return;
  }
  if (input.type === "context") {
    context = { ...context, ...(input.context || {}) };
    return;
  }
  if (input.type === "title_request") {
    const source = String(input.text || "").trim();
    let title = "";
    try {
      title = await summarizeProjectTitle(source);
    } catch {
      title = clipTitle(source.split(/[。！？!?；;，,：:\n]/).find((item) => item.trim()) || source);
    }
    emit({ type: "title_result", requestId: input.requestId, title: title || "未命名项目" });
    return;
  }
  if (input.type === "choice") {
    const resolve = pendingChoices.get(input.cardId);
    if (resolve) {
      pendingChoices.delete(input.cardId);
      resolve({ optionId: String(input.optionId || ""), optionLabel: input.optionLabel });
    }
    return;
  }
  if (input.type === "command_result") {
    const resolve = pendingCommands.get(input.requestId);
    if (resolve) {
      pendingCommands.delete(input.requestId);
      resolve({ ok: Boolean(input.ok), result: input.result, error: input.error });
    }
    return;
  }
  const text = String(input.text || "").trim();
  if (!text) return;
  context = { ...context, ...(input.context || {}) };
  const activeSession = await getSession();
  if (!(activeSession as any).__storyClawSubscribed) {
    installSubscription(activeSession);
    (activeSession as any).__storyClawSubscribed = true;
  }
  const contextText = JSON.stringify(context, null, 2);
  await activeSession.prompt(`桌面端实时上下文：\n${contextText}\n\n用户消息：${text}`);
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (!line.trim()) return;
  let parsed: AgentInput;
  try {
    parsed = JSON.parse(line) as AgentInput;
  } catch {
    emit({ type: "error", message: "主 Agent 收到无法解析的消息。" });
    return;
  }
  if (parsed.type === "choice" || parsed.type === "command_result") {
    handleMessage(parsed).catch((error) => emit({ type: "error", message: error instanceof Error ? error.message : String(error) }));
    return;
  }
  queue = queue.then(() => handleMessage(parsed)).catch((error) => {
    emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
  });
});

input.on("close", async () => {
  await queue;
  process.exit(0);
});
