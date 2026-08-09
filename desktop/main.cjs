const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawn, execFile } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");
const workspaceRoot = path.join(projectRoot, "workspace");
const rendererPath = path.join(__dirname, "renderer", "index.html");
let mainWindow;
let activeRun = null;
let nextRunId = 1;
let quitting = false;
const mediaDurationCache = new Map();

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
    const adapted = Array.isArray(progress.adapted) ? progress.adapted : [];
    const episodes = progress.episodes && typeof progress.episodes === "object" ? progress.episodes : {};
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
    try { updatedAt = (await fs.stat(progressPath)).mtime.toISOString(); } catch { /* optional */ }
    projects.push({
      id: name,
      novelName: String(progress.novel_name),
      sourcePath: typeof progress.source_path === "string" ? progress.source_path : "",
      nextChapter: Number(progress.next_chapter) || 1,
      adaptedCount: adapted.length,
      latestEpisode,
      episodeCount: Math.max(adapted.length, episodeNumbers.length),
      episodeNumbers,
      articleType: progress.article_type === "essay" ? "essay" : "story",
      aspectRatio: progress.aspect_ratio === "16:9" ? "16:9" : "9:16",
      renderMode: progress.render_mode === "full" ? "full" : "images_only",
      characterCount: characterImages.length,
      sceneCount: sceneImages.length,
      updatedAt,
      cover,
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

async function createProject(payload = {}) {
  const novelName = safeProjectName(payload.name || (payload.inputPath ? path.basename(payload.inputPath) : "未命名作品"));
  const dir = projectDir(novelName);
  if (fsSync.existsSync(dir)) throw new Error(`项目“${novelName}”已经存在`);
  await fs.mkdir(dir, { recursive: true });

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
  if (!sourcePath) throw new Error("请选择章节文件夹、章节文件或输入文稿");

  const renderMode = payload.renderMode === "full" ? "full" : "images_only";
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
  };
  await fs.writeFile(path.join(dir, "改编进度.json"), JSON.stringify(progress, null, 4), "utf8");
  await Promise.all([
    fs.mkdir(path.join(dir, "characters"), { recursive: true }),
    fs.mkdir(path.join(dir, "scenes"), { recursive: true }),
  ]);
  return (await listProjects()).find((project) => project.id === novelName) || { id: novelName, novelName };
}

function nodeExecutable() {
  if (process.env.STORYCLAW_NODE) return process.env.STORYCLAW_NODE;
  if (process.env.npm_node_execpath) return process.env.npm_node_execpath;
  return process.platform === "win32" ? "node.exe" : "node";
}

function forwardStream(stream, streamName) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    const parts = buffer.split(/\r?\n/);
    buffer = parts.pop() || "";
    for (const line of parts) send("run:log", { runId: activeRun?.id, stream: streamName, line });
  });
  stream.on("end", () => {
    if (buffer) send("run:log", { runId: activeRun?.id, stream: streamName, line: buffer });
  });
}

function startRun(selection) {
  if (activeRun) throw new Error("已有任务正在运行");
  if (!selection || typeof selection.novelName !== "string") throw new Error("运行参数无效");
  const runId = nextRunId++;
  const workerPath = path.join(__dirname, "worker.ts");
  const loaderPath = path.join(projectRoot, "node_modules", "tsx", "dist", "loader.mjs");
  const child = spawn(nodeExecutable(), ["--import", loaderPath, workerPath], {
    cwd: projectRoot,
    env: { ...process.env, FORCE_COLOR: "0" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  activeRun = { id: runId, child, selection, stopRequested: false, status: "running" };
  forwardStream(child.stdout, "stdout");
  forwardStream(child.stderr, "stderr");
  child.stdin.write(JSON.stringify(selection));
  child.stdin.end();
  send("run:state", { runId, status: "running", selection });
  child.once("error", (error) => send("run:state", { runId, status: "failed", error: error.message }));
  child.once("close", (code, signal) => {
    const stopped = activeRun?.stopRequested || signal === "SIGTERM" || code === 143;
    const status = stopped ? "stopped" : code === 0 ? "done" : "failed";
    send("run:state", { runId, status, code, signal });
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
  if (process.platform === "win32") {
    await new Promise((resolve) => execFile("taskkill", ["/pid", String(run.child.pid), "/T", "/F"], () => resolve()));
  } else {
    run.child.kill("SIGTERM");
  }
  if (!run.selection?.imagesOnly) {
    await new Promise((resolve) => execFile(
      "python",
      ["scripts/shutdown_gpu.py"],
      { cwd: projectRoot, windowsHide: true },
      () => resolve(),
    ));
  }
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
ipcMain.handle("run:start", (_event, selection) => startRun(selection));
ipcMain.handle("run:stop", () => stopRun());
ipcMain.handle("run:active", () => activeRun ? { runId: activeRun.id, status: activeRun.status } : null);
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
  if (quitting || !activeRun) return;
  event.preventDefault();
  quitting = true;
  stopRun().finally(() => app.quit());
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
