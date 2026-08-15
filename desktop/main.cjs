const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawn, execFile } = require("node:child_process");
const os = require("node:os");

const projectRoot = path.resolve(__dirname, "..");
const workspaceRoot = path.join(projectRoot, "workspace");
const rendererPath = path.join(__dirname, "renderer", "index.html");
const sessionsFileName = "sessions.json";
const userConfigRoot = path.join(os.homedir(), ".story-claw");
const desktopSettingsPath = path.join(userConfigRoot, "desktop_settings.json");
const SYSTEM_CONFIG_SECTIONS = Object.freeze({
  llm: {
    fileName: "config.json",
    fields: {
      provider: { type: "string", maxLength: 120 },
      model: { type: "string", maxLength: 240 },
      api_key: { type: "string", maxLength: 4096 },
      base_url: { type: "string", maxLength: 2048 },
    },
  },
  image: {
    fileName: "image_gen_config.json",
    fields: {
      model: { type: "string", maxLength: 240 },
      api_key: { type: "string", maxLength: 4096 },
      base_url: { type: "string", maxLength: 2048 },
      api_format: { type: "string", maxLength: 120 },
    },
  },
  video: {
    fileName: "video_config.json",
    fields: {
      base_url: { type: "string", maxLength: 2048 },
      workflow_path: { type: "string", maxLength: 2048 },
      default_duration: { type: "number", min: 0.1, max: 3600 },
      concurrency: { type: "integer", min: 1, max: 100 },
      poll_interval_ms: { type: "integer", min: 100, max: 600000 },
      max_retries: { type: "integer", min: 0, max: 100 },
      retry_sleep_ms: { type: "integer", min: 0, max: 3600000 },
    },
  },
  tts: {
    fileName: "tts_config.json",
    fields: {
      api_key: { type: "string", maxLength: 4096 },
      base_url: { type: "string", maxLength: 2048 },
      resource_id: { type: "string", maxLength: 240 },
      narrator_voice: { type: "string", maxLength: 240 },
      voices: { type: "stringMap", maxEntries: 500 },
      concurrency: { type: "integer", min: 1, max: 100 },
      assign_character_voice: { type: "boolean" },
      sfx_enabled: { type: "boolean" },
      sfx_volume: { type: "number", min: 0, max: 1 },
    },
  },
  bgm: {
    fileName: "bgm_config.json",
    fields: {
      api_key: { type: "string", maxLength: 4096 },
      base_url: { type: "string", maxLength: 2048 },
      bgm_dir: { type: "string", maxLength: 2048 },
      crossfade_sec: { type: "number", min: 0, max: 60 },
      bgm_volume: { type: "number", min: 0, max: 1 },
      min_segments: { type: "integer", min: 1, max: 100 },
      max_segments: { type: "integer", min: 1, max: 100 },
    },
  },
  gpu: {
    fileName: "gpu_config.json",
    fields: {
      provider: { type: "string", maxLength: 120 },
      public_key: { type: "string", maxLength: 4096 },
      private_key: { type: "string", maxLength: 4096 },
      instance_id: { type: "string", maxLength: 240 },
      start_timeout: { type: "integer", min: 1, max: 86400 },
      stop_timeout: { type: "integer", min: 1, max: 86400 },
    },
  },
});
const TEMPLATE_FIELDS = [
  "articleType",
  "aspectRatio",
  "renderMode",
  "reviewVisualPreset",
  "requireFinalConfirmation",
];
let mainWindow;
let activeRun = null;
let nextRunId = 1;
let quitting = false;
let activeAgent = null;
const mediaDurationCache = new Map();
const pendingTitleRequests = new Map();
const sessionWriteQueues = new Map();
const projectNameAliases = new Map();

function send(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

function isWithin(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
}

function projectDir(novelName) {
  const dir = path.resolve(workspaceRoot, novelName);
  if (!isWithin(workspaceRoot, dir) || path.basename(dir) !== novelName) {
    throw new Error("项目名称无效");
  }
  return dir;
}

function safeProjectName(input) {
  const value = String(input || "").trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_");
  if (!value || value === "." || value === "..") throw new Error("项目名称不能为空");
  return value.slice(0, 80);
}

function codePoints(value) {
  return Array.from(String(value || ""));
}

function clipText(value, limit) {
  return codePoints(value).slice(0, limit).join("");
}

function normalizeFirstMessage(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function fallbackProjectTitle(value) {
  const normalized = normalizeFirstMessage(value);
  const clause = normalized.split(/[。！？!?；;，,：:\n]/).map((item) => item.trim()).find(Boolean) || normalized;
  return clipText(clause, 20) || "未命名项目";
}

async function uniqueProjectName(input) {
  const base = safeProjectName(input);
  if (!fsSync.existsSync(projectDir(base))) return base;
  for (let index = 2; index < 10000; index += 1) {
    const suffix = ` ${index}`;
    const candidate = safeProjectName(`${clipText(base, Math.max(1, 20 - codePoints(suffix).length))}${suffix}`);
    if (!fsSync.existsSync(projectDir(candidate))) return candidate;
  }
  throw new Error("无法生成不重复的临时项目名称");
}

function imageMime(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ({
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
  })[ext] || "application/octet-stream";
}

async function toDataUrl(filePath) {
  try {
    const buffer = await fs.readFile(filePath);
    return `data:${imageMime(filePath)};base64,${buffer.toString("base64")}`;
  } catch {
    return null;
  }
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function normalizeConversation(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && ["user", "assistant", "system"].includes(item.role))
    .map((item) => ({ role: item.role, text: String(item.text || "").trim() }))
    .filter((item) => item.text);
}

function normalizeProgressCards(value) {
  if (!Array.isArray(value)) return [];
  const validStatuses = new Set(["active", "stopping", "paused", "completed", "failed", "review", "approved"]);
  return value
    .filter((item) => item && typeof item === "object" && item.id)
    .map((item) => ({
      id: String(item.id),
      runId: String(item.runId ?? ""),
      projectName: String(item.projectName || ""),
      episode: Math.max(1, Math.trunc(Number(item.episode) || 1)),
      messageIndex: Math.max(0, Math.trunc(Number(item.messageIndex) || 0)),
      createdAt: String(item.createdAt || ""),
      imagesOnly: Boolean(item.imagesOnly),
      status: validStatuses.has(item.status) ? item.status : "paused",
      phase: String(item.phase || "planning"),
      label: String(item.label || ""),
      detail: String(item.detail || ""),
      log: String(item.log || ""),
      currentIndex: Math.max(0, Math.trunc(Number(item.currentIndex) || 0)),
      pauseNoticeAdded: Boolean(item.pauseNoticeAdded),
      settingsOnly: Boolean(item.settingsOnly),
      presetReview: item.presetReview && typeof item.presetReview === "object"
        ? normalizePresetReview(item.presetReview)
        : null,
      settingsSummary: item.settingsSummary && typeof item.settingsSummary === "object"
        ? settingsSummary(item.settingsSummary)
        : null,
    }));
}

function normalizePresetReview(value) {
  if (!value || typeof value !== "object") return null;
  const rows = Array.isArray(value.rows) ? value.rows.map((row, index) => ({
    index: Math.max(1, Math.trunc(Number(row?.index) || index + 1)),
    original: String(row?.original || ""),
    fields: row?.fields && typeof row.fields === "object"
      ? Object.fromEntries(Object.entries(row.fields).map(([key, item]) => [String(key), String(item ?? "")]))
      : {},
  })).filter((row) => row.original || Object.keys(row.fields).length) : [];
  return {
    articleType: value.articleType === "essay" ? "essay" : "story",
    episode: Math.max(1, Math.trunc(Number(value.episode) || 1)),
    version: Math.max(1, Math.trunc(Number(value.version) || 1)),
    status: ["review", "approved", "updated"].includes(value.status) ? value.status : "review",
    rows,
  };
}

function normalizeProductionSettings(value) {
  const source = value && typeof value === "object" ? value : {};
  const result = {};
  if (source.articleType === "essay" || source.articleType === "story") result.articleType = source.articleType;
  if (source.aspectRatio === "16:9" || source.aspectRatio === "9:16") result.aspectRatio = source.aspectRatio;
  if (source.renderMode === "images_only" || source.renderMode === "full") result.renderMode = source.renderMode;
  if (typeof source.ethnicity === "string") result.ethnicity = source.ethnicity.slice(0, 120);
  if (typeof source.reviewVisualPreset === "boolean") result.reviewVisualPreset = source.reviewVisualPreset;
  if (typeof source.requireFinalConfirmation === "boolean") result.requireFinalConfirmation = source.requireFinalConfirmation;
  return result;
}

function normalizeTemplateSettings(value) {
  return normalizeProductionSettings(value);
}

function isCompleteTemplate(value) {
  const settings = normalizeTemplateSettings(value);
  return TEMPLATE_FIELDS.every((field) => Object.prototype.hasOwnProperty.call(settings, field));
}

function settingsSummary(value) {
  return normalizeProductionSettings(value);
}

function settingsFromProgress(progress) {
  return settingsSummary({
    articleType: progress?.article_type,
    aspectRatio: progress?.aspect_ratio,
    renderMode: progress?.render_mode,
    ethnicity: progress?.ethnicity,
    reviewVisualPreset: progress?.review_visual_preset,
    requireFinalConfirmation: progress?.require_final_confirmation,
  });
}

function validProjectSettings(payload = {}) {
  const settings = {};
  if (payload.articleType === "essay" || payload.articleType === "story") settings.articleType = payload.articleType;
  if (payload.aspectRatio === "16:9" || payload.aspectRatio === "9:16") settings.aspectRatio = payload.aspectRatio;
  if (payload.renderMode === "images_only" || payload.renderMode === "full") settings.renderMode = payload.renderMode;
  if (typeof payload.ethnicity === "string") settings.ethnicity = payload.ethnicity.slice(0, 120);
  if (typeof payload.reviewVisualPreset === "boolean") settings.reviewVisualPreset = payload.reviewVisualPreset;
  if (typeof payload.requireFinalConfirmation === "boolean") settings.requireFinalConfirmation = payload.requireFinalConfirmation;
  return settings;
}

function hasRequiredProjectSettings(settings) {
  return TEMPLATE_FIELDS.every((field) => Object.prototype.hasOwnProperty.call(settings, field)
    && settings[field] !== undefined);
}

function normalizeDesktopSettings(value) {
  const source = value && typeof value === "object" ? value : {};
  const sourceTemplates = source.templates && typeof source.templates === "object" ? source.templates : {};
  const templates = {};
  for (const [name, template] of Object.entries(sourceTemplates)) {
    const cleanName = String(name || "").trim().slice(0, 40);
    if (cleanName) templates[cleanName] = normalizeTemplateSettings(template);
  }
  const requestedActive = String(source.activeTemplate || "").trim();
  const activeTemplate = Object.prototype.hasOwnProperty.call(templates, requestedActive)
    ? requestedActive
    : "";
  return {
    version: 1,
    templateEnabled: source.templateEnabled === true,
    activeTemplate,
    templates,
  };
}

async function readDesktopSettings() {
  return normalizeDesktopSettings(await readJson(desktopSettingsPath));
}

async function getActiveTemplateSettings() {
  const settings = await readDesktopSettings();
  if (!settings.templateEnabled) {
    return { templateName: "", templateEnabled: false };
  }
  const template = settings.templates[settings.activeTemplate];
  if (!template || !isCompleteTemplate(template)) {
    throw new Error("当前启用的模板配置不完整，请先补全模板后再创建项目");
  }
  return { ...template, templateName: settings.activeTemplate, templateEnabled: true };
}

async function saveDesktopSettings(payload = {}) {
  const current = await readDesktopSettings();
  const requestedName = String(payload.templateName || payload.activeTemplate || current.activeTemplate || "")
    .trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 40);
  const templateEnabled = payload.templateEnabled === true;
  if (templateEnabled && !requestedName) throw new Error("启用模板前必须填写模板名称");
  const baseTemplateName = String(payload.baseTemplateName || "").trim();
  if (requestedName && Object.prototype.hasOwnProperty.call(current.templates, requestedName) && requestedName !== baseTemplateName) {
    throw new Error(`模板“${requestedName}”已存在，请换一个名称`);
  }
  const settings = normalizeTemplateSettings(payload.settings);
  if (templateEnabled && !isCompleteTemplate(settings)) {
    throw new Error("启用模板前必须补全文章类型、画幅、渲染模式和两个确认开关");
  }
  if (requestedName) current.templates[requestedName] = settings;
  current.templateEnabled = templateEnabled;
  current.activeTemplate = requestedName || current.activeTemplate;
  if (current.templateEnabled) {
    const active = current.templates[current.activeTemplate];
    if (!active || !isCompleteTemplate(active)) throw new Error("当前启用的模板配置不完整，请先补全模板后再保存");
  }
  await fs.mkdir(userConfigRoot, { recursive: true });
  await writeJsonAtomic(desktopSettingsPath, current);
  return current;
}

async function activateDesktopTemplate(templateName) {
  const current = await readDesktopSettings();
  const requestedName = String(templateName || "").trim();
  if (!Object.prototype.hasOwnProperty.call(current.templates, requestedName)) {
    throw new Error("设置模板不存在");
  }
  if (current.templateEnabled && !isCompleteTemplate(current.templates[requestedName])) {
    throw new Error("该模板配置不完整，补全后才能启用");
  }
  current.activeTemplate = requestedName;
  await fs.mkdir(userConfigRoot, { recursive: true });
  await writeJsonAtomic(desktopSettingsPath, current);
  return current;
}

function createAgentSessionId() {
  return `project_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function resolveProjectName(novelName) {
  let current = safeProjectName(novelName);
  const visited = new Set();
  while (projectNameAliases.has(current) && !visited.has(current)) {
    visited.add(current);
    current = projectNameAliases.get(current);
  }
  return current;
}

function projectSessionsPath(dir) {
  return path.join(dir, sessionsFileName);
}

async function writeJsonAtomic(filePath, value) {
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}.tmp`,
  );
  try {
    await fs.writeFile(tempPath, JSON.stringify(value, null, 2), "utf8");
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function readSystemConfigObject(filePath) {
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, value: {} };
    throw error;
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`${path.basename(filePath)} 不是有效的 JSON，请先修复文件格式`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path.basename(filePath)} 的根节点必须是 JSON 对象`);
  }
  return { exists: true, value };
}

function systemConfigValue(fieldName, rule, value) {
  if (value === null) return { remove: true };
  if (rule.type === "string") {
    if (typeof value !== "string") throw new Error(`${fieldName} 必须是文本`);
    const result = value.trim();
    if (!result) return { remove: true };
    if (result.length > rule.maxLength) throw new Error(`${fieldName} 内容过长`);
    return { value: result };
  }
  if (rule.type === "boolean") {
    if (typeof value !== "boolean") throw new Error(`${fieldName} 必须是开关值`);
    return { value };
  }
  if (rule.type === "number" || rule.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${fieldName} 必须是数字`);
    if (rule.type === "integer" && !Number.isInteger(value)) throw new Error(`${fieldName} 必须是整数`);
    if (value < rule.min || value > rule.max) throw new Error(`${fieldName} 必须在 ${rule.min} 到 ${rule.max} 之间`);
    return { value };
  }
  if (rule.type === "stringMap") {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${fieldName} 必须是 JSON 对象`);
    const entries = Object.entries(value);
    if (entries.length > rule.maxEntries) throw new Error(`${fieldName} 条目过多`);
    const result = {};
    for (const [key, item] of entries) {
      const cleanKey = String(key).trim();
      if (!cleanKey || typeof item !== "string") throw new Error(`${fieldName} 的键和值都必须是非空文本`);
      result[cleanKey] = item.trim();
    }
    return { value: result };
  }
  throw new Error(`不支持的系统配置字段：${fieldName}`);
}

async function readSystemConfig() {
  const sections = {};
  for (const [sectionName, descriptor] of Object.entries(SYSTEM_CONFIG_SECTIONS)) {
    const filePath = path.join(userConfigRoot, descriptor.fileName);
    const { exists, value } = await readSystemConfigObject(filePath);
    const values = {};
    for (const fieldName of Object.keys(descriptor.fields)) {
      if (Object.prototype.hasOwnProperty.call(value, fieldName)) values[fieldName] = value[fieldName];
    }
    sections[sectionName] = { fileName: descriptor.fileName, exists, values };
  }
  return { sections };
}

async function saveSystemConfig(payload = {}) {
  const requestedSections = payload?.sections;
  if (!requestedSections || typeof requestedSections !== "object" || Array.isArray(requestedSections)) {
    throw new Error("系统设置内容无效");
  }
  const writes = [];
  for (const [sectionName, patch] of Object.entries(requestedSections)) {
    if (!Object.prototype.hasOwnProperty.call(SYSTEM_CONFIG_SECTIONS, sectionName)) {
      throw new Error(`未知的系统配置分区：${sectionName}`);
    }
    const descriptor = SYSTEM_CONFIG_SECTIONS[sectionName];
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error(`${sectionName} 配置无效`);
    const filePath = path.join(userConfigRoot, descriptor.fileName);
    const { exists, value: current } = await readSystemConfigObject(filePath);
    const next = { ...current };
    for (const [fieldName, input] of Object.entries(patch)) {
      if (!Object.prototype.hasOwnProperty.call(descriptor.fields, fieldName)) {
        throw new Error(`${descriptor.fileName} 不支持字段 ${fieldName}`);
      }
      const rule = descriptor.fields[fieldName];
      const normalized = systemConfigValue(fieldName, rule, input);
      if (normalized.remove) delete next[fieldName];
      else next[fieldName] = normalized.value;
    }
    if (sectionName === "bgm"
      && Number.isFinite(next.min_segments)
      && Number.isFinite(next.max_segments)
      && next.min_segments > next.max_segments) {
      throw new Error("BGM 最少片段数不能大于最多片段数");
    }
    if (exists || Object.keys(next).length) writes.push({ filePath, value: next });
  }

  await fs.mkdir(userConfigRoot, { recursive: true });
  for (const write of writes) await writeJsonAtomic(write.filePath, write.value);

  if (Object.prototype.hasOwnProperty.call(requestedSections, "llm") && activeAgent?.child && !activeAgent.child.killed) {
    const child = activeAgent.child;
    activeAgent = null;
    child.kill();
  }
  return readSystemConfig();
}

async function openSystemConfigDirectory(target = "config") {
  const directory = target === "sfx" ? path.join(userConfigRoot, "sfx") : userConfigRoot;
  await fs.mkdir(directory, { recursive: true });
  const error = await shell.openPath(directory);
  if (error) throw new Error(error);
  return { opened: true };
}

function normalizeProjectSession(stored, progress, fallbackName) {
  const hasStoredMessages = Boolean(stored && Array.isArray(stored.messages));
  const sessionId = typeof stored?.session_id === "string" && stored.session_id.trim()
    ? stored.session_id.trim()
    : typeof progress?.agent_session_id === "string" && progress.agent_session_id.trim()
    ? progress.agent_session_id.trim()
    : fallbackName;
  return {
    version: 2,
    session_id: sessionId,
    messages: normalizeConversation(hasStoredMessages ? stored.messages : progress?.conversation),
    progress_cards: normalizeProgressCards(stored?.progress_cards),
    settings_summary: stored?.settings_summary
      ? settingsSummary(stored.settings_summary)
      : settingsFromProgress(progress),
    updated_at: typeof stored?.updated_at === "string" ? stored.updated_at : "",
  };
}

async function readProjectSession(dir, progress, fallbackName, { migrate = false } = {}) {
  const filePath = projectSessionsPath(dir);
  const stored = await readJson(filePath);
  const session = normalizeProjectSession(stored, progress, fallbackName);
  if (migrate && (!stored || stored.version !== 2 || !Array.isArray(stored.messages) || !Array.isArray(stored.progress_cards) || !stored.session_id || !stored.settings_summary)) {
    session.updated_at = new Date().toISOString();
    await writeJsonAtomic(filePath, session);
  }
  return session;
}

function enqueueSessionWrite(novelName, task) {
  const key = resolveProjectName(novelName);
  const previous = sessionWriteQueues.get(key) || Promise.resolve();
  const queued = previous.catch(() => {}).then(task);
  sessionWriteQueues.set(key, queued);
  queued.finally(() => {
    if (sessionWriteQueues.get(key) === queued) sessionWriteQueues.delete(key);
  }).catch(() => {});
  return queued;
}

async function flushProjectSessionWrites(novelName) {
  const requestedName = safeProjectName(novelName);
  const resolvedName = resolveProjectName(requestedName);
  const pending = [...new Set([requestedName, resolvedName])]
    .map((name) => sessionWriteQueues.get(name))
    .filter(Boolean);
  await Promise.allSettled(pending);
}

async function flushAllSessionWrites() {
  await Promise.allSettled([...sessionWriteQueues.values()]);
}

async function probeMediaDuration(filePath) {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return null;
  }

  const signature = `${stat.size}:${stat.mtimeMs}`;
  const cached = mediaDurationCache.get(filePath);
  if (cached?.signature === signature) return cached.duration;

  const duration = await new Promise((resolve) => {
    execFile("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      filePath,
    ], { windowsHide: true }, (error, stdout) => {
      const value = Number.parseFloat(String(stdout || "").trim());
      resolve(!error && Number.isFinite(value) && value > 0 ? value : null);
    });
  });
  mediaDurationCache.set(filePath, { signature, duration });
  return duration;
}

async function sumMediaDurations(filePaths) {
  const durations = [];
  for (let index = 0; index < filePaths.length; index += 4) {
    const batch = await Promise.all(filePaths.slice(index, index + 4).map(probeMediaDuration));
    durations.push(...batch.filter((duration) => Number.isFinite(duration) && duration > 0));
  }
  return durations.length ? durations.reduce((sum, duration) => sum + duration, 0) : null;
}

async function getEpisodeTotalDuration(episodeDir) {
  const episodeStem = path.basename(episodeDir);
  for (const fileName of [`${episodeStem}.mp4`, `${episodeStem}_with_bgm.mp4`]) {
    const duration = await probeMediaDuration(path.join(episodeDir, fileName));
    if (duration) return duration;
  }

  const renderDirs = (await fs.readdir(episodeDir, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("render_"));
  const sceneVideoPaths = [];
  for (const renderDir of renderDirs) {
    const dirPath = path.join(episodeDir, renderDir.name);
    const entries = await fs.readdir(dirPath, { withFileTypes: true }).catch(() => []);
    sceneVideoPaths.push(...entries
      .filter((entry) => entry.isFile() && /^g\d+\.mp4$/i.test(entry.name))
      .map((entry) => path.join(dirPath, entry.name)));
  }
  return sumMediaDurations(sceneVideoPaths);
}

async function listImageFiles(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && /\.(png|jpe?g|webp)$/i.test(entry.name))
      .map((entry) => path.join(dir, entry.name))
      .sort((a, b) => a.localeCompare(b, "zh-CN"));
  } catch {
    return [];
  }
}

async function listProjects() {
  await fs.mkdir(workspaceRoot, { recursive: true });
  const entries = await fs.readdir(workspaceRoot, { withFileTypes: true });
  const projects = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    const dir = path.join(workspaceRoot, name);
    const progressPath = path.join(dir, "改编进度.json");
    const progress = await readJson(progressPath);
    if (!progress || typeof progress !== "object" || !progress.novel_name) continue;
    const session = await readProjectSession(dir, progress, name);
    const adapted = Array.isArray(progress.adapted) ? progress.adapted : [];
    const episodes = progress.episodes && typeof progress.episodes === "object" ? progress.episodes : {};
    const renderedEpisodes = Object.entries(episodes)
      .filter(([, record]) => ["done", "images_only"].includes(record?.stages?.render))
      .map(([episode]) => Number(episode))
      .filter((episode) => Number.isInteger(episode) && episode > 0)
      .sort((a, b) => a - b);
    const reviewEpisodes = Object.entries(episodes)
      .filter(([, record]) => record?.stages?.visualPreset === "review")
      .map(([episode]) => Number(episode))
      .filter((episode) => Number.isInteger(episode) && episode > 0)
      .sort((a, b) => a - b);
    const progressEpisodeNumbers = Object.keys(episodes)
      .map(Number)
      .filter((episode) => Number.isInteger(episode) && episode > 0);
    const episodeDirectoryNumbers = (await fs.readdir(dir, { withFileTypes: true }).catch(() => []))
      .filter((item) => item.isDirectory() && /^ep\d+$/i.test(item.name))
      .map((item) => Number(item.name.slice(2)))
      .filter((episode) => Number.isInteger(episode) && episode > 0);
    const episodeNumbers = [...new Set([
      ...progressEpisodeNumbers,
      ...episodeDirectoryNumbers,
      ...adapted.map((_chapter, index) => index + 1),
    ])].sort((a, b) => a - b);
    const latestEpisode = episodeNumbers.length ? Math.max(...episodeNumbers) : 0;
    const characterImages = await listImageFiles(path.join(dir, "characters"));
    const sceneImages = await listImageFiles(path.join(dir, "scenes"));
    const coverCandidates = [
      path.join(dir, `ep${String(latestEpisode || 1).padStart(2, "0")}`, "covers", "cover_portrait.png"),
      path.join(dir, `ep${String(latestEpisode || 1).padStart(2, "0")}`, "covers", "cover_landscape.png"),
    ];
    let cover = null;
    for (const candidate of coverCandidates) {
      if (fsSync.existsSync(candidate)) {
        cover = await toDataUrl(candidate);
        if (cover) break;
      }
    }
    let updatedAt = null;
    const updatedCandidates = await Promise.all([
      fs.stat(progressPath).then((stat) => stat.mtime.toISOString()).catch(() => null),
      fs.stat(projectSessionsPath(dir)).then((stat) => stat.mtime.toISOString()).catch(() => null),
    ]);
    updatedAt = updatedCandidates.filter(Boolean).sort().at(-1) || null;
    projects.push({
      id: name,
      novelName: String(progress.novel_name),
      sourcePath: typeof progress.source_path === "string" ? progress.source_path : "",
      nextChapter: Number(progress.next_chapter) || 1,
      adaptedCount: adapted.length,
      latestEpisode,
      episodeCount: Math.max(adapted.length, episodeNumbers.length),
      episodeNumbers,
      renderedEpisodes,
      reviewEpisodes,
      ...(progress.article_type === "essay" || progress.article_type === "story" ? { articleType: progress.article_type } : {}),
      ...(progress.aspect_ratio === "16:9" || progress.aspect_ratio === "9:16" ? { aspectRatio: progress.aspect_ratio } : {}),
      ...(progress.render_mode === "full" || progress.render_mode === "images_only" ? { renderMode: progress.render_mode } : {}),
      ...(typeof progress.ethnicity === "string" ? { ethnicity: progress.ethnicity } : {}),
      ...(typeof progress.review_visual_preset === "boolean" ? { reviewVisualPreset: progress.review_visual_preset } : {}),
      ...(typeof progress.require_final_confirmation === "boolean" ? { requireFinalConfirmation: progress.require_final_confirmation } : {}),
      characterCount: characterImages.length,
      sceneCount: sceneImages.length,
      updatedAt,
      cover,
      isDraft: Boolean(progress.draft_project),
      agentSessionId: session.session_id,
      settingsSummary: session.settings_summary,
    });
  }
  return projects.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}

async function getAssets(novelName) {
  const dir = projectDir(novelName);
  const result = { people: [], scenes: [] };
  const characterFiles = await listImageFiles(path.join(dir, "characters"));
  for (const filePath of characterFiles) {
    const fileName = path.basename(filePath);
    result.people.push({
      name: fileName.replace(/\.(png|jpe?g|webp)$/i, ""),
      kind: "人物参考图",
      dataUrl: await toDataUrl(filePath),
    });
  }
  const sceneFiles = await listImageFiles(path.join(dir, "scenes"));
  for (const filePath of sceneFiles) {
    const fileName = path.basename(filePath);
    result.scenes.push({
      name: fileName.replace(/\.(png|jpe?g|webp)$/i, ""),
      kind: "场景参考图",
      dataUrl: await toDataUrl(filePath),
    });
  }
  return result;
}

async function getEpisodePreview(novelName, episode) {
  const dir = projectDir(novelName);
  const episodeDir = path.join(dir, `ep${String(Number(episode) || 1).padStart(2, "0")}`);
  if (!isWithin(dir, episodeDir)) throw new Error("集目录无效");
  const totalDurationPromise = getEpisodeTotalDuration(episodeDir);
  const storyboardsDir = path.join(episodeDir, "storyboards");
  const storyboardFiles = (await fs.readdir(storyboardsDir, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isFile() && entry.name.startsWith("storyboard_") && entry.name.endsWith(".jsonl"))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));

  const groups = [];
  for (let sceneIndex = 0; sceneIndex < storyboardFiles.length; sceneIndex++) {
    const fileName = storyboardFiles[sceneIndex].name;
    const sceneName = fileName.slice("storyboard_".length, -".jsonl".length);
    const storyboardPath = path.join(storyboardsDir, fileName);
    const lines = (await fs.readFile(storyboardPath, "utf8")).split(/\r?\n/).filter((line) => line.trim());

    lines.forEach((line, groupIndex) => {
      try {
        const group = JSON.parse(line);
        const parsedOrder = Number(group?.global_order);
        groups.push({
          sceneIndex,
          sceneName,
          groupIndex,
          globalOrder: Number.isFinite(parsedOrder) ? parsedOrder : Number.MAX_SAFE_INTEGER,
          panels: Array.isArray(group?.panels) ? group.panels : [],
          scriptText: typeof group?.text === "string" ? group.text.trim() : "",
        });
      } catch {
        // Ignore blank or partially written JSONL lines.
      }
    });
  }

  groups.sort((a, b) =>
    a.globalOrder - b.globalOrder
    || a.sceneIndex - b.sceneIndex
    || a.groupIndex - b.groupIndex
  );

  const panels = [];
  for (const group of groups) {
    const renderDir = path.join(episodeDir, `render_${group.sceneName}`);
    for (let panelIndex = 0; panelIndex < group.panels.length; panelIndex++) {
      const stem = `g${String(group.groupIndex).padStart(2, "0")}_p${String(panelIndex).padStart(2, "0")}`;
      const imagePath = path.join(renderDir, `${stem}.png`);
      const videoPath = path.join(renderDir, `${stem}.mp4`);
      const imageReady = fsSync.existsSync(imagePath) && isWithin(episodeDir, imagePath);
      const videoReady = fsSync.existsSync(videoPath) && isWithin(episodeDir, videoPath);

      panels.push({
        name: `${stem}.png`,
        scene: group.sceneName,
        dataUrl: imageReady ? pathToFileURL(imagePath).href : null,
        videoUrl: videoReady ? pathToFileURL(videoPath).href : null,
        scriptText: group.scriptText || null,
        globalOrder: group.globalOrder,
        groupIndex: group.groupIndex,
        panelIndex,
        status: videoReady ? "video_ready" : imageReady ? "image_ready" : "pending",
      });
    }
  }
  return {
    panels,
    totalDuration: await totalDurationPromise,
  };
}

const STORY_PRESET_FIELDS = ["场景", "人物", "景别", "角度", "镜头运动", "光影", "情绪", "语言", "独白"];

async function getVisualPresetReview(novelName, episode) {
  const resolvedName = resolveProjectName(novelName);
  const dir = projectDir(resolvedName);
  const progress = await readJson(path.join(dir, "改编进度.json"));
  if (!progress || typeof progress !== "object") throw new Error("项目进度不存在");
  const episodeNumber = Math.max(1, Math.trunc(Number(episode) || 1));
  const presetPath = path.join(dir, `ep${String(episodeNumber).padStart(2, "0")}`, "画面预设.txt");
  const content = await fs.readFile(presetPath, "utf8");
  const articleType = progress.article_type === "essay" ? "essay" : "story";
  const reviewRecord = progress.episodes?.[String(episodeNumber)]?.visual_preset_review;
  const rows = content.split(/\r?\n/).map((line, index) => {
    const text = line.trim();
    if (!text) return null;
    const annotationStart = text.lastIndexOf("【");
    const annotationEnd = text.endsWith("】") ? text.length - 1 : -1;
    const original = annotationStart > 0 && annotationEnd > annotationStart
      ? text.slice(0, annotationStart).trim()
      : text;
    const annotation = annotationStart > 0 && annotationEnd > annotationStart
      ? text.slice(annotationStart + 1, annotationEnd).trim()
      : "";
    if (articleType === "essay") {
      const intent = annotation.replace(/^画面\s*[：:]/, "").trim();
      return { index: index + 1, original, fields: { "画面意图": intent } };
    }
    const values = annotation.split("|");
    const fields = {};
    STORY_PRESET_FIELDS.forEach((field, fieldIndex) => { fields[field] = String(values[fieldIndex] || "").trim(); });
    return { index: index + 1, original, fields };
  }).filter(Boolean);
  return {
    articleType,
    episode: episodeNumber,
    version: Math.max(1, Math.trunc(Number(reviewRecord?.version) || 1)),
    status: reviewRecord?.status === "approved" ? "approved" : "review",
    rows,
  };
}

async function approveVisualPreset(novelName, episode) {
  const resolvedName = resolveProjectName(novelName);
  const dir = projectDir(resolvedName);
  const progressPath = path.join(dir, "改编进度.json");
  const progress = await readJson(progressPath);
  if (!progress || typeof progress !== "object") throw new Error("项目进度不存在");
  const key = String(Math.max(1, Math.trunc(Number(episode) || 1)));
  progress.episodes ??= {};
  const record = progress.episodes[key] ?? { stages: {} };
  record.stages = { ...(record.stages || {}), visualPreset: "done" };
  record.visual_preset_review = {
    ...(record.visual_preset_review || {}),
    articleType: progress.article_type === "essay" ? "essay" : "story",
    version: Math.max(1, Math.trunc(Number(record.visual_preset_review?.version) || 1)),
    status: "approved",
  };
  record.updated_at = new Date().toISOString();
  progress.episodes[key] = record;
  await writeJsonAtomic(progressPath, progress);
  return { novelName: resolvedName, episode: Number(key) };
}

async function chooseSource(kind) {
  const properties = kind === "directory" ? ["openDirectory"] : ["openFile"];
  const result = await dialog.showOpenDialog(mainWindow, {
    title: kind === "directory" ? "选择章节文件夹" : "选择章节文件",
    properties,
    filters: kind === "file" ? [{ name: "章节文件", extensions: ["txt", "md"] }] : undefined,
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return { kind, path: result.filePaths[0] };
}

async function inspectSource(inputPath) {
  if (typeof inputPath !== "string" || !inputPath.trim()) return null;
  const resolvedPath = path.resolve(inputPath);
  const stat = await fs.stat(resolvedPath);
  if (!stat.isDirectory() && !stat.isFile()) return null;
  return { kind: stat.isDirectory() ? "directory" : "file", path: resolvedPath };
}

function chapterFileName(originalName) {
  if (/^第\d+章/.test(originalName)) return originalName;
  const stem = path.basename(originalName, path.extname(originalName)).replace(/[\\/:*?"<>|]/g, "_");
  return `第1章 ${stem || "未命名章节"}${path.extname(originalName).toLowerCase() === ".md" ? ".md" : ".txt"}`;
}

async function materializeProjectSource(dir, payload = {}, existingSourcePath = "") {
  if (existingSourcePath) return existingSourcePath;
  let sourcePath = typeof payload.inputPath === "string" ? payload.inputPath : "";
  if (sourcePath) {
    sourcePath = path.resolve(sourcePath);
    await fs.access(sourcePath);
  }
  if (payload.text && String(payload.text).trim()) {
    sourcePath = path.join(dir, "source");
    await fs.mkdir(sourcePath, { recursive: true });
    await fs.writeFile(path.join(sourcePath, "第1章 章节.txt"), String(payload.text), "utf8");
  } else if (payload.inputKind === "file" && sourcePath) {
    const sourceFile = sourcePath;
    sourcePath = path.join(dir, "source");
    await fs.mkdir(sourcePath, { recursive: true });
    await fs.copyFile(sourceFile, path.join(sourcePath, chapterFileName(path.basename(sourceFile))));
  }
  return sourcePath;
}

async function createProject(payload = {}) {
  const templateEnabled = payload.templateEnabled === true;
  const storedTemplate = templateEnabled ? await getActiveTemplateSettings() : { templateName: "", templateEnabled: false };
  const requestedSettings = validProjectSettings(payload);
  const settings = templateEnabled
    ? { ...storedTemplate, ...Object.fromEntries(Object.entries(requestedSettings).filter(([, value]) => value !== undefined)) }
    : requestedSettings;
  const persistedSettings = payload.draftProject ? {} : settings;
  if (!payload.draftProject && !hasRequiredProjectSettings(settings)) {
    throw new Error("项目配置不完整，请先选择文章类型、画幅、渲染模式及两个确认选项");
  }
  const novelName = safeProjectName(payload.name || (payload.inputPath ? path.basename(payload.inputPath) : "未命名作品"));
  const dir = projectDir(novelName);
  if (fsSync.existsSync(dir)) throw new Error(`项目“${novelName}”已经存在`);
  await fs.mkdir(dir, { recursive: true });

  const sourcePath = await materializeProjectSource(dir, payload);
  if (!sourcePath && !payload.draftProject) throw new Error("请选择章节文件夹、章节文件或输入文稿");

  const agentSessionId = createAgentSessionId();
  const progress = {
    novel_name: novelName,
    source_path: sourcePath,
    ...(Object.prototype.hasOwnProperty.call(persistedSettings, "ethnicity") ? { ethnicity: persistedSettings.ethnicity } : {}),
    ...(persistedSettings.articleType ? { article_type: persistedSettings.articleType } : {}),
    ...(persistedSettings.aspectRatio ? { aspect_ratio: persistedSettings.aspectRatio } : {}),
    ...(persistedSettings.renderMode ? { render_mode: persistedSettings.renderMode } : {}),
    ...(typeof persistedSettings.reviewVisualPreset === "boolean" ? { review_visual_preset: persistedSettings.reviewVisualPreset } : {}),
    ...(typeof persistedSettings.requireFinalConfirmation === "boolean" ? { require_final_confirmation: persistedSettings.requireFinalConfirmation } : {}),
    adapted: [],
    next_chapter: 1,
    global_summary: "",
    established_characters: [],
    established_locations: [],
    active_hooks: [],
    draft_project: Boolean(payload.draftProject),
    agent_session_id: agentSessionId,
  };
  const session = {
    version: 2,
    session_id: agentSessionId,
    messages: normalizeConversation(payload.conversation),
    progress_cards: [],
    settings_summary: settingsFromProgress(progress),
    updated_at: new Date().toISOString(),
  };
  await Promise.all([
    fs.writeFile(path.join(dir, "改编进度.json"), JSON.stringify(progress, null, 4), "utf8"),
    writeJsonAtomic(projectSessionsPath(dir), session),
    fs.mkdir(path.join(dir, "characters"), { recursive: true }),
    fs.mkdir(path.join(dir, "scenes"), { recursive: true }),
  ]);
  return (await listProjects()).find((project) => project.id === novelName) || { id: novelName, novelName };
}

async function finalizeDraftProject(currentName, payload = {}) {
  const oldName = safeProjectName(currentName);
  const nextName = safeProjectName(payload.name);
  const oldDir = projectDir(oldName);
  const nextDir = projectDir(nextName);
  const oldProgressPath = path.join(oldDir, "改编进度.json");
  const progress = await readJson(oldProgressPath);
  if (!progress || typeof progress !== "object" || !progress.draft_project) {
    throw new Error("当前项目不是待命名项目");
  }
  const templateEnabled = payload.templateEnabled === true;
  const storedTemplate = templateEnabled ? await getActiveTemplateSettings() : {};
  const requestedSettings = validProjectSettings(payload);
  const settings = templateEnabled
    ? { ...storedTemplate, ...Object.fromEntries(Object.entries(requestedSettings).filter(([, value]) => value !== undefined)) }
    : requestedSettings;
  if (!hasRequiredProjectSettings(settings)) {
    throw new Error("项目配置不完整，请先选择文章类型、画幅、渲染模式及两个确认选项");
  }
  if (oldName !== nextName && fsSync.existsSync(nextDir)) {
    throw new Error(`项目“${nextName}”已经存在`);
  }
  await flushProjectSessionWrites(oldName);
  await readProjectSession(oldDir, progress, oldName, { migrate: true });

  let sourcePath = await materializeProjectSource(oldDir, payload, typeof progress.source_path === "string" ? progress.source_path : "");
  if (!sourcePath) throw new Error("请选择章节文件夹、章节文件或输入文稿");

  progress.novel_name = nextName;
  progress.article_type = settings.articleType;
  progress.aspect_ratio = settings.aspectRatio;
  progress.render_mode = settings.renderMode;
  if (typeof settings.ethnicity === "string") progress.ethnicity = settings.ethnicity;
  else delete progress.ethnicity;
  progress.review_visual_preset = settings.reviewVisualPreset;
  progress.require_final_confirmation = settings.requireFinalConfirmation;
  progress.draft_project = false;

  if (oldName !== nextName) {
    await fs.rename(oldDir, nextDir);
    projectNameAliases.set(oldName, nextName);
    if (isWithin(oldDir, sourcePath)) {
      sourcePath = path.join(nextDir, path.relative(oldDir, sourcePath));
    }
  }
  progress.source_path = sourcePath;
  await fs.writeFile(path.join(nextDir, "改编进度.json"), JSON.stringify(progress, null, 4), "utf8");
  const session = await readProjectSession(nextDir, progress, nextName, { migrate: true });
  session.settings_summary = settingsFromProgress(progress);
  session.updated_at = new Date().toISOString();
  await writeJsonAtomic(projectSessionsPath(nextDir), session);
  return (await listProjects()).find((project) => project.id === nextName) || { id: nextName, novelName: nextName };
}

async function getProjectConversation(novelName) {
  const resolvedName = resolveProjectName(novelName);
  await flushProjectSessionWrites(resolvedName);
  const dir = projectDir(resolvedName);
  const progress = await readJson(path.join(dir, "改编进度.json"));
  if (!progress || typeof progress !== "object") throw new Error("项目进度不存在");
  const session = await readProjectSession(dir, progress, resolvedName, { migrate: true });
  return { messages: session.messages, progressCards: session.progress_cards };
}

async function updateProjectConversation(novelName, payload) {
  const snapshot = normalizeConversation(payload?.messages);
  const progressCards = normalizeProgressCards(payload?.progressCards);
  return enqueueSessionWrite(novelName, async () => {
    const resolvedName = resolveProjectName(novelName);
    const dir = projectDir(resolvedName);
    const progress = await readJson(path.join(dir, "改编进度.json"));
    if (!progress || typeof progress !== "object") throw new Error("项目进度不存在");
    const session = await readProjectSession(dir, progress, resolvedName);
    session.messages = snapshot;
    session.progress_cards = progressCards;
    session.updated_at = new Date().toISOString();
    await writeJsonAtomic(projectSessionsPath(dir), session);
    return { messages: session.messages, progressCards: session.progress_cards };
  });
}

function nodeExecutable() {
  if (process.env.STORYCLAW_NODE) return process.env.STORYCLAW_NODE;
  if (process.env.npm_node_execpath) return process.env.npm_node_execpath;
  return process.platform === "win32" ? "node.exe" : "node";
}

function agentSessionPath(selection) {
  const project = String(selection?.agentSessionId || selection?.novelName || "project")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .slice(0, 80);
  const episode = Math.max(1, Number(selection?.episode) || 1);
  return path.join(projectRoot, "agent-data", `supervisor_${project}_ep${String(episode).padStart(2, "0")}.jsonl`);
}

function runContext(run = activeRun) {
  if (!run) return {};
  const selection = run.selection || {};
  return {
    projectName: selection.novelName,
    episode: selection.episode,
    phase: run.phase || "planning",
    phaseLabel: run.phaseLabel || "规划中",
    phaseDetail: run.phaseDetail || "",
    runStatus: run.status,
    visualPresetReview: run.review || null,
    settings: settingsForSelection(selection),
    recentLogs: Array.isArray(run.logs) ? run.logs.slice(-20) : [],
  };
}

function settingsForSelection(selection = {}) {
  const settings = {};
  if (typeof selection.ethnicity === "string") settings.ethnicity = selection.ethnicity;
  if (selection.articleType === "essay" || selection.articleType === "story") settings.articleType = selection.articleType;
  if (selection.aspectRatio === "16:9" || selection.aspectRatio === "9:16") settings.aspectRatio = selection.aspectRatio;
  if (selection.renderMode === "full" || selection.renderMode === "images_only") settings.renderMode = selection.renderMode;
  else if (selection.imagesOnly === true) settings.renderMode = "images_only";
  if (typeof selection.reviewVisualPreset === "boolean") settings.reviewVisualPreset = selection.reviewVisualPreset;
  if (typeof selection.requireFinalConfirmation === "boolean") settings.requireFinalConfirmation = selection.requireFinalConfirmation;
  return settings;
}

function sendAgentEvent(payload) {
  send("agent:event", payload);
}

function sendAgentInput(payload) {
  if (!activeAgent?.child || activeAgent.child.killed || activeAgent.child.stdin.destroyed) return false;
  try {
    activeAgent.child.stdin.write(`${JSON.stringify(payload)}\n`);
    return true;
  } catch {
    return false;
  }
}

function updateAgentContext() {
  if (!activeAgent) return;
  sendAgentInput({ type: "context", context: runContext(activeRun) });
}

function selectionForProject(project) {
  const summary = project.settingsSummary || {};
  return {
    novelName: project.novelName,
    sourcePath: project.sourcePath || "",
    episode: Math.max(1, Number(project.nextChapter) || Number(project.adaptedCount) + 1 || 1),
    nextChapter: Math.max(1, Number(project.nextChapter) || 1),
    ethnicity: typeof project.ethnicity === "string"
      ? project.ethnicity
      : typeof summary.ethnicity === "string" ? summary.ethnicity : "",
    ...(project.aspectRatio === "16:9" || project.aspectRatio === "9:16" ? { aspectRatio: project.aspectRatio } : {}),
    ...(project.renderMode === "full" || project.renderMode === "images_only" ? {
      renderMode: project.renderMode,
      imagesOnly: project.renderMode === "images_only",
    } : {}),
    ...(project.articleType === "essay" || project.articleType === "story" ? { articleType: project.articleType } : {}),
    ...(typeof project.reviewVisualPreset === "boolean" ? { reviewVisualPreset: project.reviewVisualPreset } : {}),
    ...(typeof project.requireFinalConfirmation === "boolean" ? { requireFinalConfirmation: project.requireFinalConfirmation } : {}),
    agentSessionId: project.agentSessionId || project.id || project.novelName,
  };
}

async function requestTemporaryProjectTitle(firstMessage) {
  const normalized = normalizeFirstMessage(firstMessage);
  if (codePoints(normalized).length <= 20) return normalized || "未命名项目";

  ensureAgentWorker(null);
  const requestId = `title_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingTitleRequests.delete(requestId);
      resolve(fallbackProjectTitle(normalized));
    }, 30000);
    pendingTitleRequests.set(requestId, {
      resolve: (title) => {
        clearTimeout(timer);
        const cleaned = normalizeFirstMessage(title).replace(/^[“"'《【]|[”"'》】]$/g, "");
        resolve(clipText(cleaned, 20) || fallbackProjectTitle(normalized));
      },
    });
    if (!sendAgentInput({ type: "title_request", requestId, text: normalized })) {
      clearTimeout(timer);
      pendingTitleRequests.delete(requestId);
      resolve(fallbackProjectTitle(normalized));
    }
  });
}

async function createConversationDraft(payload, firstMessage) {
  const baseName = await requestTemporaryProjectTitle(firstMessage);
  const name = await uniqueProjectName(baseName);
  const context = payload?.context && typeof payload.context === "object" ? payload.context : {};
  return createProject({
    name,
    inputPath: context.inputPath || "",
    inputKind: context.inputKind || "",
    conversation: payload?.conversation,
    draftProject: true,
  });
}

async function handleAgentCreateProject(payload) {
  const requestId = String(payload?.requestId || "");
  const details = payload?.payload && typeof payload.payload === "object" ? payload.payload : {};
  if (!requestId) return;
  try {
    const previousProjectId = activeAgent?.selection?.novelName || "";
    const existingProject = previousProjectId
      ? (await listProjects()).find((project) => project.id === previousProjectId)
      : null;
    const project = existingProject?.isDraft
      ? await finalizeDraftProject(previousProjectId, details)
      : await createProject({
        name: details.name,
        text: details.text,
        inputPath: details.inputPath,
        inputKind: details.inputKind,
        articleType: details.articleType,
        aspectRatio: details.aspectRatio,
        renderMode: details.renderMode,
        ethnicity: details.ethnicity,
        templateName: details.templateName,
        templateEnabled: details.templateEnabled,
        reviewVisualPreset: details.reviewVisualPreset,
        requireFinalConfirmation: details.requireFinalConfirmation,
      });
    const selection = selectionForProject(project);
    if (activeAgent) {
      activeAgent.selection = selection;
      activeAgent.key = `${selection.novelName}:${selection.episode}`;
    }
    sendAgentEvent(existingProject?.isDraft
      ? { type: "project_renamed", previousProjectId, project, selection }
      : { type: "project_created", project, selection });
    sendAgentInput({
      type: "context",
      context: {
        projectName: selection.novelName,
        episode: selection.episode,
        runStatus: "idle",
        draftProject: false,
        settings: settingsForSelection(selection),
      },
    });
    sendAgentInput({
      type: "command_result",
      requestId,
      ok: true,
      result: { project: project.novelName, episode: selection.episode },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendAgentInput({ type: "command_result", requestId, ok: false, error: message });
    sendAgentEvent({ type: "error", message });
  }
}

async function approveAndResumeVisualPreset(novelName, episode, expectedRun = null) {
  const resolvedName = resolveProjectName(novelName);
  const project = (await listProjects()).find((item) => item.id === resolvedName);
  if (!project) throw new Error("审核项目不存在");
  if (expectedRun && expectedRun.selection?.novelName !== resolvedName) {
    throw new Error("审核项目与当前项目不一致");
  }
  const selectedEpisode = Math.max(
    1,
    Math.trunc(Number(episode) || expectedRun?.selection?.episode || project.reviewEpisodes?.[0] || project.nextChapter || 1),
  );
  const progress = await readJson(path.join(projectDir(resolvedName), "改编进度.json"));
  if (progress?.episodes?.[String(selectedEpisode)]?.stages?.visualPreset !== "review") {
    throw new Error("当前项目没有等待确认的画面预设");
  }
  await approveVisualPreset(resolvedName, selectedEpisode);
  const selection = {
    ...(expectedRun?.selection || selectionForProject(project)),
    novelName: project.novelName,
    episode: selectedEpisode,
  };
  if (activeRun === expectedRun || (activeRun && activeRun.status === "review" && !expectedRun)) activeRun = null;
  const result = startRun(selection);
  send("run:review-approved", { runId: expectedRun?.id || null, nextRunId: result.runId, selection });
  updateAgentContext();
  return result;
}

function handleAgentWorkerLine(line) {
  const prefix = "STORYCLAW_AGENT ";
  if (!line.startsWith(prefix)) return;
  let payload;
  try { payload = JSON.parse(line.slice(prefix.length)); } catch { return; }
  if (payload?.type === "title_result" && payload.requestId) {
    const pending = pendingTitleRequests.get(String(payload.requestId));
    if (pending) {
      pendingTitleRequests.delete(String(payload.requestId));
      pending.resolve(String(payload.title || ""));
    }
    return;
  }
  if (payload?.type === "command") {
    if (payload.command === "create_project") {
      handleAgentCreateProject(payload).catch((error) => sendAgentEvent({ type: "error", message: error.message }));
      return;
    }
    if (payload.command === "stop") {
      stopRun().catch((error) => sendAgentEvent({ type: "error", message: error.message }));
    } else if (payload.command === "start") {
      const selection = activeAgent?.selection;
      if (!selection) {
        sendAgentEvent({ type: "error", message: "还没有选中的项目，无法启动流水线。" });
      } else if (activeRun?.status === "review") {
        approveAndResumeVisualPreset(selection.novelName, selection.episode, activeRun)
          .catch((error) => sendAgentEvent({ type: "error", message: error instanceof Error ? error.message : String(error) }));
      } else if (activeRun) {
        sendAgentEvent({ type: "error", message: "当前已经有任务在运行。" });
      } else {
        (async () => {
          const project = (await listProjects()).find((item) => item.id === resolveProjectName(selection.novelName));
          if (project?.reviewEpisodes?.includes(Number(selection.episode))) {
            await approveAndResumeVisualPreset(selection.novelName, selection.episode);
          } else {
            startRun(selection);
          }
        })().catch((error) => sendAgentEvent({ type: "error", message: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }
  }
  sendAgentEvent(payload);
}

function forwardAgentStream(stream, streamName) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    const parts = buffer.split(/\r?\n/);
    buffer = parts.pop() || "";
    parts.forEach((line) => {
      if (line.trim()) handleAgentWorkerLine(line.trim());
    });
  });
  stream.on("end", () => {
    if (buffer.trim()) handleAgentWorkerLine(buffer.trim());
  });
  stream.on("error", (error) => sendAgentEvent({ type: "error", message: `${streamName}: ${error.message}` }));
}

function ensureAgentWorker(selection) {
  const key = `${selection?.novelName || ""}:${selection?.episode || ""}`;
  if (activeAgent?.key === key && activeAgent.child && !activeAgent.child.killed) return activeAgent;
  if (activeAgent?.child && !activeAgent.child.killed) activeAgent.child.kill();

  const agentPath = path.join(__dirname, "agent-worker.ts");
  const loaderPath = path.join(projectRoot, "node_modules", "tsx", "dist", "loader.mjs");
  const child = spawn(nodeExecutable(), ["--import", pathToFileURL(loaderPath).href, agentPath], {
    cwd: projectRoot,
    env: { ...process.env, FORCE_COLOR: "0" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  activeAgent = { key, child, selection };
  forwardAgentStream(child.stdout, "stdout");
  forwardAgentStream(child.stderr, "stderr");
  child.once("error", (error) => sendAgentEvent({ type: "error", message: error.message }));
  child.once("close", () => {
    if (activeAgent?.child === child) activeAgent = null;
  });
  sendAgentInput({ type: "init", context: runContext(activeRun), sessionFile: agentSessionPath(selection) });
  return activeAgent;
}

function forwardStream(stream, streamName, run = activeRun) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    const parts = buffer.split(/\r?\n/);
    buffer = parts.pop() || "";
    for (const line of parts) handleRunOutputLine(line, streamName, run);
  });
  stream.on("end", () => {
    if (buffer) handleRunOutputLine(buffer, streamName, run);
  });
}

function handleRunOutputLine(line, streamName, run = activeRun) {
  const phasePrefix = "STORYCLAW_PHASE ";
  const reviewPrefix = "STORYCLAW_REVIEW ";
  const trimmed = String(line || "").trim();
  if (trimmed.startsWith(phasePrefix)) {
    try {
      const payload = JSON.parse(trimmed.slice(phasePrefix.length));
      if (run && payload && typeof payload === "object") {
        run.phase = payload.phase || run.phase;
        run.phaseLabel = payload.label || run.phaseLabel;
        run.phaseDetail = payload.detail || "";
        send("run:phase", { runId: run.id, ...payload });
        if (activeRun === run) updateAgentContext();
      }
      return;
    } catch {
      // Malformed marker is kept as a normal log line for diagnosis.
    }
  }
  if (trimmed.startsWith(reviewPrefix)) {
    try {
      const marker = JSON.parse(trimmed.slice(reviewPrefix.length));
      if (run) {
        run.reviewPending = true;
        run.status = "review";
        getVisualPresetReview(run.selection.novelName, marker.episode || run.selection.episode)
          .then((review) => {
            run.review = review;
            send("run:review", { runId: run.id, selection: run.selection, review });
            sendAgentInput({
              type: "context",
              context: { ...runContext(run), visualPresetReview: review },
            });
          })
          .catch((error) => sendAgentEvent({ type: "error", message: error instanceof Error ? error.message : String(error) }));
      }
      return;
    } catch {
      // Malformed review marker is kept as a normal log line for diagnosis.
    }
  }
  if (run) {
    run.logs = [...(run.logs || []).slice(-79), String(line)];
  }
  send("run:log", { runId: run?.id, stream: streamName, line });
  if (activeRun === run) updateAgentContext();
}

function shutdownGpuOnce(run) {
  if (!run || run.selection?.imagesOnly) return Promise.resolve();
  if (run.shutdownPromise) return run.shutdownPromise;
  run.shutdownPromise = new Promise((resolve) => {
    execFile(
      "python",
      ["scripts/shutdown_gpu.py"],
      { cwd: projectRoot, windowsHide: true },
      (_error) => resolve(),
    );
  });
  return run.shutdownPromise;
}

function startRun(selection) {
  if (activeRun) throw new Error(activeRun.status === "review" ? "画面预设正在等待审核" : "已有任务正在运行");
  if (!selection || typeof selection.novelName !== "string") throw new Error("运行参数无效");
  if (!selection.sourcePath) throw new Error("项目还没有章节源目录");
  if (selection.articleType !== "essay" && selection.articleType !== "story") throw new Error("项目文章类型尚未确定");
  if (selection.aspectRatio !== "16:9" && selection.aspectRatio !== "9:16") throw new Error("项目画幅尚未确定");
  if (selection.renderMode !== "full" && selection.renderMode !== "images_only") throw new Error("项目渲染模式尚未确定");
  if (typeof selection.reviewVisualPreset !== "boolean" || typeof selection.requireFinalConfirmation !== "boolean") {
    throw new Error("项目审核配置尚未确定");
  }
  const runId = `run_${Date.now().toString(36)}_${nextRunId++}`;
  const workerPath = path.join(__dirname, "worker.ts");
  const loaderPath = path.join(projectRoot, "node_modules", "tsx", "dist", "loader.mjs");
  const child = spawn(nodeExecutable(), ["--import", pathToFileURL(loaderPath).href, workerPath], {
    cwd: projectRoot,
    env: { ...process.env, FORCE_COLOR: "0" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  activeRun = {
    id: runId,
    child,
    selection,
    stopRequested: false,
    status: "running",
    phase: "planning",
    phaseLabel: "规划中",
    phaseDetail: "流水线正在生成规划",
    logs: [],
  };
  const run = activeRun;
  run.closePromise = new Promise((resolve) => { run.resolveClose = resolve; });
  try { ensureAgentWorker(selection); } catch (error) {
    sendAgentEvent({ type: "error", message: `主 Agent 启动失败：${error instanceof Error ? error.message : String(error)}` });
  }
  forwardStream(child.stdout, "stdout", run);
  forwardStream(child.stderr, "stderr", run);
  child.stdin.write(JSON.stringify(selection));
  child.stdin.end();
  send("run:state", { runId, status: "running", selection });
  send("run:phase", {
    runId,
    phase: "planning",
    label: "规划中",
    detail: "流水线正在生成规划",
  });
  updateAgentContext();
  child.once("error", (error) => send("run:state", { runId, status: "failed", error: error.message }));
  child.once("close", async (code, signal) => {
    const stopped = run.stopRequested || signal === "SIGTERM" || code === 143;
    const status = run?.reviewPending ? "review" : stopped ? "stopped" : code === 0 ? "done" : "failed";
    if (["failed", "stopped"].includes(status)) await shutdownGpuOnce(run);
    if (run) run.status = status;
    send("run:state", { runId, status, code, signal, review: run?.review || null, selection: run?.selection });
    if (activeAgent?.selection?.novelName === run?.selection?.novelName) updateAgentContext();
    if (status === "review") {
      if (run) {
        run.child = null;
        run.status = "review";
      }
    } else {
      if (activeRun === run) activeRun = null;
    }
    run.resolveClose?.();
  });
  return { runId };
}

async function stopRun() {
  if (!activeRun || activeRun.status === "review") return { stopped: false };
  const run = activeRun;
  run.stopRequested = true;
  run.status = "stopping";
  send("run:state", { runId: run.id, status: "stopping" });
  send("run:phase", { runId: run.id, phase: "stopped", label: "正在暂停", detail: "正在保存当前进度并关闭 GPU" });
  if (process.platform === "win32") {
    await new Promise((resolve) => execFile("taskkill", ["/pid", String(run.child.pid), "/T", "/F"], () => resolve()));
  } else {
    run.child.kill("SIGTERM");
  }
  await shutdownGpuOnce(run);
  updateAgentContext();
  return { stopped: true };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 960,
    minWidth: 1120,
    minHeight: 720,
    backgroundColor: "#0b0c0e",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadFile(rendererPath);
  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`[renderer] 加载失败 ${errorCode}: ${errorDescription} ${validatedURL}`);
  });
  if (process.env.STORYCLAW_DEVTOOLS === "1") mainWindow.webContents.openDevTools({ mode: "detach" });
  mainWindow.on("closed", () => { mainWindow = null; });
}

ipcMain.handle("projects:list", () => listProjects());
ipcMain.handle("settings:get", () => readDesktopSettings());
ipcMain.handle("settings:save", (_event, payload) => saveDesktopSettings(payload));
ipcMain.handle("settings:activate", (_event, templateName) => activateDesktopTemplate(templateName));
ipcMain.handle("system-config:get", () => readSystemConfig());
ipcMain.handle("system-config:save", (_event, payload) => saveSystemConfig(payload));
ipcMain.handle("system-config:open-directory", (_event, target) => openSystemConfigDirectory(target));
ipcMain.handle("assets:list", (_event, novelName) => getAssets(novelName));
ipcMain.handle("episode:preview", (_event, novelName, episode) => getEpisodePreview(novelName, episode));
ipcMain.handle("source:choose", (_event, kind) => chooseSource(kind === "file" ? "file" : "directory"));
ipcMain.handle("source:inspect", (_event, inputPath) => inspectSource(inputPath));
ipcMain.handle("project:create", (_event, payload) => createProject(payload));
ipcMain.handle("project:conversation:get", (_event, novelName) => getProjectConversation(novelName));
ipcMain.handle("project:conversation", (_event, novelName, messages) => updateProjectConversation(novelName, messages));
ipcMain.handle("run:start", (_event, selection) => startRun(selection));
ipcMain.handle("run:stop", () => stopRun());
ipcMain.handle("run:active", () => activeRun ? {
  runId: activeRun.id,
  status: activeRun.status,
  selection: activeRun.selection,
  phase: activeRun.phase,
  phaseLabel: activeRun.phaseLabel,
  phaseDetail: activeRun.phaseDetail,
  logs: activeRun.logs,
  review: activeRun.review || null,
} : null);
ipcMain.handle("visual-preset:get", (_event, novelName, episode) => getVisualPresetReview(novelName, episode));
ipcMain.handle("visual-preset:approve", async (_event, novelName, episode) => {
  if (activeRun && activeRun.status !== "review") throw new Error("当前已经有任务正在运行");
  const run = activeRun?.status === "review" ? activeRun : null;
  return approveAndResumeVisualPreset(novelName, episode, run);
});
ipcMain.handle("agent:message", async (_event, payload = {}) => {
  const text = String(payload.text || "").trim();
  let selection = payload.selection || null;
  let draftProject = null;
  if (!selection) {
    draftProject = await createConversationDraft(payload, text);
    selection = selectionForProject(draftProject);
    sendAgentEvent({ type: "project_created", provisional: true, project: draftProject, selection });
  }
  ensureAgentWorker(selection);
  const accepted = sendAgentInput({
    type: "message",
    text,
    context: {
      ...runContext(activeRun),
      ...(payload.context || {}),
      projectName: selection.novelName,
      episode: selection.episode,
      draftProject: draftProject ? Boolean(draftProject.isDraft) : Boolean(payload.context?.draftProject),
    },
  });
  return { accepted, project: draftProject, selection };
});
ipcMain.handle("agent:choice", (_event, payload = {}) => {
  const accepted = sendAgentInput({
    type: "choice",
    cardId: String(payload.cardId || ""),
    optionId: String(payload.optionId || ""),
    optionLabel: String(payload.optionLabel || ""),
  });
  return { accepted };
});
ipcMain.handle("agent:stop", () => stopRun());
ipcMain.handle("workspace:open", async (_event, novelName) => {
  const target = novelName ? projectDir(novelName) : workspaceRoot;
  return shell.openPath(target);
});
ipcMain.handle("output:open", async (_event, novelName, episode) => {
  const target = novelName
    ? path.join(projectDir(novelName), `ep${String(Number(episode) || 1).padStart(2, "0")}`)
    : workspaceRoot;
  await fs.mkdir(target, { recursive: true });
  return shell.openPath(target);
});

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  const stopPromise = activeRun ? stopRun() : Promise.resolve();
  Promise.allSettled([stopPromise, flushAllSessionWrites()]).finally(() => {
    if (activeAgent?.child && !activeAgent.child.killed) activeAgent.child.kill();
    app.quit();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
