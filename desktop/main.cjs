const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawn, execFile } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");
const workspaceRoot = path.join(projectRoot, "workspace");
const rendererPath = path.join(__dirname, "renderer", "index.html");
const sessionsFileName = "sessions.json";
const obsoleteSystemMessages = new Set([
  "项目已建立。你可以继续补充要求，确认配置后再开始渲染。",
]);
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
    .filter((item) => item.text && !(item.role === "system" && obsoleteSystemMessages.has(item.text)));
}

function normalizeProgressCards(value) {
  if (!Array.isArray(value)) return [];
  const validStatuses = new Set(["active", "stopping", "paused", "completed", "failed"]);
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
    }));
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
    updated_at: typeof stored?.updated_at === "string" ? stored.updated_at : "",
  };
}

async function readProjectSession(dir, progress, fallbackName, { migrate = false } = {}) {
  const filePath = projectSessionsPath(dir);
  const stored = await readJson(filePath);
  const session = normalizeProjectSession(stored, progress, fallbackName);
  if (migrate && (!stored || stored.version !== 2 || !Array.isArray(stored.messages) || !Array.isArray(stored.progress_cards) || !stored.session_id)) {
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
    const combined = entries.find((entry) => entry.isFile() && entry.name === "_video_only.mp4")
      || entries.find((entry) => entry.isFile() && entry.name === "final.mp4");
    if (combined) {
      sceneVideoPaths.push(path.join(dirPath, combined.name));
      continue;
    }
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
      articleType: progress.article_type === "essay" ? "essay" : "story",
      aspectRatio: progress.aspect_ratio === "16:9" ? "16:9" : "9:16",
      renderMode: progress.render_mode === "full" ? "full" : "images_only",
      characterCount: characterImages.length,
      sceneCount: sceneImages.length,
      updatedAt,
      cover,
      conversation: session.messages,
      isDraft: Boolean(progress.draft_project),
      agentSessionId: session.session_id,
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
  const novelName = safeProjectName(payload.name || (payload.inputPath ? path.basename(payload.inputPath) : "未命名作品"));
  const dir = projectDir(novelName);
  if (fsSync.existsSync(dir)) throw new Error(`项目“${novelName}”已经存在`);
  await fs.mkdir(dir, { recursive: true });

  const sourcePath = await materializeProjectSource(dir, payload);
  if (!sourcePath && !payload.draftProject) throw new Error("请选择章节文件夹、章节文件或输入文稿");

  const renderMode = payload.renderMode === "full" ? "full" : "images_only";
  const agentSessionId = createAgentSessionId();
  const progress = {
    novel_name: novelName,
    source_path: sourcePath,
    ethnicity: typeof payload.ethnicity === "string" ? payload.ethnicity : "",
    article_type: payload.articleType === "essay" ? "essay" : "story",
    aspect_ratio: payload.aspectRatio === "16:9" ? "16:9" : "9:16",
    render_mode: renderMode,
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
  if (oldName !== nextName && fsSync.existsSync(nextDir)) {
    throw new Error(`项目“${nextName}”已经存在`);
  }
  await flushProjectSessionWrites(oldName);
  await readProjectSession(oldDir, progress, oldName, { migrate: true });

  let sourcePath = await materializeProjectSource(oldDir, payload, typeof progress.source_path === "string" ? progress.source_path : "");
  if (!sourcePath) throw new Error("请选择章节文件夹、章节文件或输入文稿");

  progress.novel_name = nextName;
  progress.article_type = payload.articleType === "essay" ? "essay" : "story";
  progress.aspect_ratio = payload.aspectRatio === "16:9" ? "16:9" : "9:16";
  progress.render_mode = payload.renderMode === "images_only" ? "images_only" : "full";
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
  const snapshot = normalizeConversation(Array.isArray(payload) ? payload : payload?.messages);
  const progressCards = Array.isArray(payload) ? null : normalizeProgressCards(payload?.progressCards);
  return enqueueSessionWrite(novelName, async () => {
    const resolvedName = resolveProjectName(novelName);
    const dir = projectDir(resolvedName);
    const progress = await readJson(path.join(dir, "改编进度.json"));
    if (!progress || typeof progress !== "object") throw new Error("项目进度不存在");
    const session = await readProjectSession(dir, progress, resolvedName);
    session.messages = snapshot;
    if (progressCards) session.progress_cards = progressCards;
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
  return {
    projectName: run.selection?.novelName,
    episode: run.selection?.episode,
    phase: run.phase || "planning",
    phaseLabel: run.phaseLabel || "规划中",
    phaseDetail: run.phaseDetail || "",
    runStatus: run.status,
    recentLogs: Array.isArray(run.logs) ? run.logs.slice(-20) : [],
  };
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
  return {
    novelName: project.novelName,
    sourcePath: project.sourcePath || "",
    episode: Math.max(1, Number(project.nextChapter) || Number(project.adaptedCount) + 1 || 1),
    nextChapter: Math.max(1, Number(project.nextChapter) || 1),
    ethnicity: "",
    aspectRatio: project.aspectRatio === "16:9" ? "16:9" : "9:16",
    imagesOnly: project.renderMode !== "full",
    articleType: project.articleType === "essay" ? "essay" : "story",
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
      } else if (activeRun) {
        sendAgentEvent({ type: "error", message: "当前已经有任务在运行。" });
      } else {
        try { startRun(selection); } catch (error) {
          sendAgentEvent({ type: "error", message: error instanceof Error ? error.message : String(error) });
        }
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

function forwardStream(stream, streamName) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    const parts = buffer.split(/\r?\n/);
    buffer = parts.pop() || "";
    for (const line of parts) handleRunOutputLine(line, streamName);
  });
  stream.on("end", () => {
    if (buffer) handleRunOutputLine(buffer, streamName);
  });
}

function handleRunOutputLine(line, streamName) {
  const phasePrefix = "STORYCLAW_PHASE ";
  const trimmed = String(line || "").trim();
  if (trimmed.startsWith(phasePrefix)) {
    try {
      const payload = JSON.parse(trimmed.slice(phasePrefix.length));
      if (activeRun && payload && typeof payload === "object") {
        activeRun.phase = payload.phase || activeRun.phase;
        activeRun.phaseLabel = payload.label || activeRun.phaseLabel;
        activeRun.phaseDetail = payload.detail || "";
        send("run:phase", { runId: activeRun.id, ...payload });
        updateAgentContext();
      }
      return;
    } catch {
      // Malformed marker is kept as a normal log line for diagnosis.
    }
  }
  const run = activeRun;
  if (run) {
    run.logs = [...(run.logs || []).slice(-79), String(line)];
  }
  send("run:log", { runId: run?.id, stream: streamName, line });
  updateAgentContext();
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
  if (activeRun) throw new Error("已有任务正在运行");
  if (!selection || typeof selection.novelName !== "string") throw new Error("运行参数无效");
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
  try { ensureAgentWorker(selection); } catch (error) {
    sendAgentEvent({ type: "error", message: `主 Agent 启动失败：${error instanceof Error ? error.message : String(error)}` });
  }
  forwardStream(child.stdout, "stdout");
  forwardStream(child.stderr, "stderr");
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
    const run = activeRun;
    const stopped = activeRun?.stopRequested || signal === "SIGTERM" || code === 143;
    const status = stopped ? "stopped" : code === 0 ? "done" : "failed";
    if (["failed", "stopped"].includes(status)) await shutdownGpuOnce(run);
    if (run) run.status = status;
    send("run:state", { runId, status, code, signal });
    if (activeAgent?.selection?.novelName === run?.selection?.novelName) updateAgentContext();
    activeRun = null;
  });
  return { runId };
}

async function stopRun() {
  if (!activeRun) return { stopped: false };
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
} : null);
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
      draftProject: Boolean(draftProject?.isDraft),
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
