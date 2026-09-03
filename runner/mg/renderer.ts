import fs from "node:fs/promises";
import {createHash} from "node:crypto";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {bundle} from "@remotion/bundler";
import {renderMedia, selectComposition} from "@remotion/renderer";
import {getMgTemplateProvider} from "@story-claw/mg-templates/provider";
import type {NovelSelection} from "../../ui/select.js";
import {generateImage} from "../../utils/image-gen.js";
import {novelPaths} from "../../utils/paths.js";
import {assertMgVideoFrames} from "./media.js";
import type {MgPlan, MgRenderBundle} from "./types.js";
import type {
  CompositionNode,
  MgRuntimeCompositionNode,
  MgRuntimeEpisodeInput,
  MgRuntimeLayer,
} from "@story-claw/mg-templates/provider";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const mgProvider = getMgTemplateProvider();
const REMOTION_ENTRY = fileURLToPath(mgProvider.runtimeEntryUrl);

const assetKey = (source: string): string => createHash("sha256").update(source).digest("hex").slice(0, 24);
const imageFileExtension = /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/i;

const imageExtension = (source: string, contentType?: string): string => {
  const fromUrl = (() => { try { return path.extname(new URL(source).pathname).toLowerCase(); } catch { return ""; } })();
  if (/^\.(svg|png|jpe?g|webp|gif|avif|bmp)$/i.test(fromUrl)) return fromUrl === ".jpeg" ? ".jpg" : fromUrl;
  const mime = (contentType ?? "").split(";", 1)[0].toLowerCase();
  return ({"image/svg+xml": ".svg", "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif", "image/avif": ".avif", "image/bmp": ".bmp"} as Record<string, string>)[mime] ?? ".png";
};

const localImagePath = async (source: string, baseDir: string, publicDir: string): Promise<string | undefined> => {
  if (/^file:\/\//i.test(source)) {
    try { source = decodeURIComponent(new URL(source).pathname.replace(/^\/+([A-Za-z]:)/, "$1")); } catch { return undefined; }
  }
  // A template may describe an asset as public/foo.png. The Provider copies
  // its runtime public assets into this render's public directory, while a
  // project may also genuinely contain public/foo.png. Check both forms
  // without teaching Story Claw where a template package stores its files.
  const withoutPublicPrefix = source.replace(/^public[\\/]+/i, "");
  const candidates = path.isAbsolute(source) ? [source] : [
    path.resolve(baseDir, source), path.resolve(publicDir, source),
    path.resolve(publicDir, withoutPublicPrefix),
    path.resolve(PROJECT_ROOT, source), path.resolve(PROJECT_ROOT, withoutPublicPrefix),
    path.resolve(process.cwd(), source), path.resolve(process.cwd(), withoutPublicPrefix),
  ];
  for (const candidate of candidates) {
    try { if ((await fs.stat(candidate)).isFile()) return candidate; } catch { /* A prompt is resolved below. */ }
  }
  return undefined;
};

const makeImageResolver = (
  baseDir: string,
  publicDir: string,
  width: number,
  height: number,
): ((source: string) => Promise<string>) => {
  const assetsDir = path.join(publicDir, "assets");
  const cache = new Map<string, Promise<string>>();
  return (source: string) => {
    source = source.trim();
    const existing = cache.get(source);
    if (existing) return existing;
    const pending = (async () => {
      await fs.mkdir(assetsDir, {recursive: true});
      const key = assetKey(source);
      if (/^https?:\/\//i.test(source)) {
        const response = await fetch(source, {signal: AbortSignal.timeout(60_000)});
        if (!response.ok) throw new Error(`图片 URL 请求失败 ${response.status}: ${source}`);
        const contentType = response.headers.get("content-type") ?? "";
        if (contentType && !/^image\//i.test(contentType)) throw new Error(`图片 URL 返回的不是图片（${contentType}）: ${source}`);
        const output = path.join(assetsDir, `${key}${imageExtension(source, contentType)}`);
        await fs.writeFile(output, Buffer.from(await response.arrayBuffer()));
        return `assets/${path.basename(output)}`;
      }
      if (/^data:image\//i.test(source)) {
        const match = source.match(/^data:(image\/[^;]+);base64,(.*)$/is);
        if (!match) throw new Error(`不支持的 data 图片格式: ${source.slice(0, 80)}`);
        const output = path.join(assetsDir, `${key}${imageExtension("", match[1])}`);
        await fs.writeFile(output, Buffer.from(match[2], "base64"));
        return `assets/${path.basename(output)}`;
      }
      if (/^blob:/i.test(source) || (/^data:/i.test(source) && !/^data:image\//i.test(source))) {
        throw new Error(`不支持的图片链接: ${source.slice(0, 120)}`);
      }
      const local = await localImagePath(source, baseDir, publicDir);
      if (local) {
        const ext = path.extname(local).toLowerCase();
        if (ext && !imageFileExtension.test(ext)) throw new Error(`图片素材不是支持的图片文件: ${source}`);
        const output = path.join(assetsDir, `${key}${ext || ".png"}`);
        await fs.copyFile(local, output);
        return `assets/${path.basename(output)}`;
      }
      if (/^(?:[A-Za-z]:[\\/]|file:)/i.test(source)) throw new Error(`找不到本地图片素材: ${source}`);
      const output = path.join(assetsDir, `${key}.png`);
      try { await fs.access(output); } catch {
        await generateImage(source, output, [], width >= height ? "16:9" : "9:16");
      }
      return `assets/${path.basename(output)}`;
    })();
    cache.set(source, pending);
    return pending;
  };
};

const preparePublicAssets = async (
  bundleData: MgRuntimeEpisodeInput,
  baseDir: string,
  publicDir: string,
): Promise<void> => {
  await fs.mkdir(publicDir, {recursive: true});
  await mgProvider.copyRuntimeAssets(publicDir);
  if (bundleData.baseFile) {
    const basePath = path.join(publicDir, bundleData.baseFile);
    await fs.mkdir(path.dirname(basePath), {recursive: true});
    await fs.copyFile(path.resolve(baseDir, bundleData.baseFile), basePath);
  }
  for (const node of bundleData.nodes ?? []) {
    if (!node.videoPath) continue;
    const source = path.resolve(node.videoPath);
    const publicName = `${assetKey(source)}${path.extname(source).toLowerCase()}`;
    const target = path.join(publicDir, "clips", publicName);
    await fs.mkdir(path.dirname(target), {recursive: true});
    await fs.copyFile(source, target);
    node.videoPath = `clips/${publicName}`;
  }
  const runtimeLayers = [
    ...(bundleData.layers ?? []),
    ...(bundleData.nodes ?? [])
      .filter((node) => node.render)
      .map((node) => ({
        id: node.nodeId,
        instance: node.instance ?? node.nodeId,
        htmlTag: node.htmlTag ?? node.render!.kind,
        group: node.group ?? node.render!.group,
        ...(node.order === undefined ? {} : {order: node.order}),
        layerRole: node.layerRole ?? node.render!.layerRole,
        startFrame: node.startFrame,
        endFrame: node.endFrame,
        durationFrames: node.endFrame - node.startFrame,
        timelineOffsetFrames: node.timelineOffsetFrames ?? 0,
        sourceText: node.sourceText ?? "",
        render: node.render!,
      })),
  ];
  await mgProvider.prepareRuntimeAssets({
    layers: runtimeLayers,
    resolveImage: makeImageResolver(baseDir, publicDir, bundleData.width, bundleData.height),
  });
};

export async function renderVisualTagTemplateClip(
  sel: NovelSelection,
  instanceKey: string,
  layer: MgRuntimeLayer,
  width: number,
  height: number,
  durationFrames: number,
  fps: number,
  outputPath: string,
  options: {
    activeWindows?: Array<{startFrame: number; endFrame: number}>;
    forceAlpha?: boolean;
  } = {},
): Promise<void> {
  const node: MgRuntimeCompositionNode = {
    nodeId: instanceKey,
    videoPath: "",
    startFrame: 0,
    endFrame: durationFrames,
    zIndex: 0,
    instance: instanceKey,
    htmlTag: layer.kind,
    group: layer.group,
    layerRole: layer.layerRole,
    timelineOffsetFrames: 0,
    sourceText: "",
    render: layer,
    ...(options.activeWindows?.length ? {activeWindows: options.activeWindows} : {}),
  };
  const isAlpha = options.forceAlpha === true || layer.layerRole === "overlay";
  const input: MgRuntimeEpisodeInput = {
    width,
    height,
    fps,
    durationFrames,
    nodes: [node],
    transparentBackground: isAlpha,
  };
  const publicDir = path.join(novelPaths.mgPublicDir(sel.novelName, sel.episode), assetKey(instanceKey));
  await preparePublicAssets(input, novelPaths.episodeDir(sel.novelName, sel.episode), publicDir);
  const serveUrl = await bundle({entryPoint: REMOTION_ENTRY, publicDir});
  const composition = await selectComposition({serveUrl, id: "StoryClawMgEpisode", inputProps: {episode: input}});
  await fs.mkdir(path.dirname(outputPath), {recursive: true});
  const nextPath = `${outputPath}.next${path.extname(outputPath)}`;
  await fs.rm(nextPath, {force: true});
  await renderMedia({
    composition,
    serveUrl,
    codec: isAlpha ? "prores" : "h264",
    muted: false,
    outputLocation: nextPath,
    inputProps: {episode: input},
    ...(isAlpha
      ? {
        imageFormat: "png" as const,
        pixelFormat: "yuva444p10le" as const,
        proResProfile: "4444" as const,
      }
      : {
        crf: 18,
        x264Preset: "fast" as const,
        pixelFormat: "yuv420p" as const,
      }),
    logLevel: "warn",
  });
  await assertMgVideoFrames(nextPath, durationFrames, fps);
  await fs.rm(outputPath, {force: true});
  await fs.rename(nextPath, outputPath);
}

const persistentNodeKeys = new Set([
  "nodeId",
  "parentNodeId",
  "videoPath",
  "startFrame",
  "endFrame",
  "zIndex",
]);

function assertPersistentNode(value: unknown, label: string): asserts value is CompositionNode {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 不是合成节点对象`);
  const node = value as Record<string, unknown>;
  const extraKeys = Object.keys(node).filter((key) => !persistentNodeKeys.has(key));
  if (extraKeys.length) throw new Error(`${label} 包含禁止持久化的运行时字段: ${extraKeys.join(", ")}`);
  if (typeof node.nodeId !== "string" || !node.nodeId) throw new Error(`${label}.nodeId 无效`);
  if ("parentNodeId" in node && (typeof node.parentNodeId !== "string" || !node.parentNodeId)) {
    throw new Error(`${label}.parentNodeId 无效`);
  }
  if (typeof node.videoPath !== "string" || !node.videoPath) throw new Error(`${label}.videoPath 无效`);
  for (const key of ["startFrame", "endFrame", "zIndex"] as const) {
    if (!Number.isInteger(node[key])) throw new Error(`${label}.${key} 必须为整数`);
  }
  if ((node.startFrame as number) < 0 || (node.endFrame as number) <= (node.startFrame as number)) {
    throw new Error(`${label} 的帧窗口无效`);
  }
}

const assertPlanBundleConsistency = (plan: MgPlan, renderBundle: MgRenderBundle): void => {
  if (plan.version !== 4 || renderBundle.version !== 4) throw new Error("mg_plan 与 render_bundle 必须使用 version=4");
  const sourceShape = {
    width: plan.source.width,
    height: plan.source.height,
    fps: plan.source.fps,
    durationFrames: plan.source.durationFrames,
  };
  const bundleShape = {
    width: renderBundle.width,
    height: renderBundle.height,
    fps: renderBundle.fps,
    durationFrames: renderBundle.durationFrames,
  };
  if (JSON.stringify(sourceShape) !== JSON.stringify(bundleShape)) {
    throw new Error("mg_plan 与 render_bundle 的画布、FPS 或总帧数不一致");
  }
  if (!Array.isArray(plan.nodes) || !Array.isArray(renderBundle.nodes)) {
    throw new Error("mg_plan 或 render_bundle 缺少合成节点数组");
  }
  if (plan.nodes.length !== renderBundle.nodes.length) {
    throw new Error("mg_plan 与 render_bundle 的合成节点数量不一致");
  }
  for (let index = 0; index < plan.nodes.length; index++) {
    assertPersistentNode(plan.nodes[index], `mg_plan.nodes[${index}]`);
    assertPersistentNode(renderBundle.nodes[index], `render_bundle.nodes[${index}]`);
    if (JSON.stringify(plan.nodes[index]) !== JSON.stringify(renderBundle.nodes[index])) {
      throw new Error(`mg_plan 与 render_bundle 的第 ${index + 1} 个合成节点不一致`);
    }
  }
};

const buildRuntimeInput = (plan: MgPlan, renderBundle: MgRenderBundle): MgRuntimeEpisodeInput => {
  assertPlanBundleConsistency(plan, renderBundle);
  if (!Array.isArray(plan.functionCalls)) throw new Error("mg_plan 缺少 Function Call 记录");
  const calls = new Map(plan.functionCalls.map((record) => [record.instanceKey, record]));
  if (calls.size !== plan.functionCalls.length) throw new Error("mg_plan 存在重复的 Function Call 实例");
  const nodes: MgRuntimeCompositionNode[] = renderBundle.nodes.map((node, index) => {
    const record = calls.get(node.nodeId);
    if (!record) throw new Error(`合成节点 ${node.nodeId} 缺少 Function Call 记录`);
    if (plan.functionCalls[index]?.instanceKey !== node.nodeId) {
      throw new Error(`合成节点 ${node.nodeId} 与 Function Call 的持久化顺序不一致`);
    }
    if (record.status !== "completed" || !record.videoPath) {
      throw new Error(`合成节点 ${node.nodeId} 的视频任务尚未完成`);
    }
    if (
      record.videoPath !== node.videoPath
      || record.startFrame !== node.startFrame
      || record.endFrame !== node.endFrame
    ) {
      throw new Error(`合成节点 ${node.nodeId} 与 Function Call 记录不一致`);
    }
    return {
      ...node,
      layerRole: record.layerRole,
      ...(record.activeWindows?.length ? {activeWindows: record.activeWindows} : {}),
    };
  });
  if (nodes.length !== plan.functionCalls.length) {
    throw new Error("Function Call 数量与合成节点数量不一致");
  }
  return {
    width: renderBundle.width,
    height: renderBundle.height,
    fps: renderBundle.fps,
    durationFrames: renderBundle.durationFrames,
    nodes,
  };
};

/** Render every completed visual-tag clip in one full-episode composition. */
export async function renderEssayMgEpisode(sel: NovelSelection): Promise<string> {
  const planPath = novelPaths.mgPlan(sel.novelName, sel.episode);
  const bundlePath = novelPaths.mgRenderBundle(sel.novelName, sel.episode);
  const outputPath = novelPaths.episodeMgRawVideo(sel.novelName, sel.episode);
  const [plan, renderBundle] = await Promise.all([
    fs.readFile(planPath, "utf-8").then((value) => JSON.parse(value) as MgPlan),
    fs.readFile(bundlePath, "utf-8").then((value) => JSON.parse(value) as MgRenderBundle),
  ]);
  const runtimeInput = buildRuntimeInput(plan, renderBundle);
  const nodeCount = runtimeInput.nodes?.length ?? 0;

  const publicDir = novelPaths.mgPublicDir(sel.novelName, sel.episode);
  await preparePublicAssets(runtimeInput, novelPaths.episodeDir(sel.novelName, sel.episode), publicDir);
  console.log("[MG渲染] 正在打包模板 Provider 运行时...");
  const serveUrl = await bundle({
    entryPoint: REMOTION_ENTRY,
    publicDir,
    onProgress: (progress) => {
      if (progress === 1 || Math.round(progress * 100) % 20 === 0) console.log(`[MG渲染] 模板打包 ${Math.round(progress * 100)}%`);
    },
  });
  const composition = await selectComposition({serveUrl, id: "StoryClawMgEpisode", inputProps: {episode: runtimeInput}});
  const nextPath = `${outputPath}.next.mp4`;
  await fs.rm(nextPath, {force: true});
  console.log(
    nodeCount === 0
      ? `[MG渲染] 无视觉标签，输出 ${renderBundle.durationFrames} 帧黑底兜底视频`
      : `[MG渲染] 整集合成 ${nodeCount} 个合成节点 / ${renderBundle.durationFrames} 帧`,
  );
  await renderMedia({
    composition,
    serveUrl,
    codec: "h264",
    muted: false,
    outputLocation: nextPath,
    inputProps: {episode: runtimeInput},
    crf: 18,
    x264Preset: "fast",
    pixelFormat: "yuv420p",
    logLevel: "warn",
  });
  await assertMgVideoFrames(nextPath, renderBundle.durationFrames, renderBundle.fps);
  await fs.rm(outputPath, {force: true});
  await fs.rename(nextPath, outputPath);
  return outputPath;
}

/** @deprecated: retained as a compatibility alias for existing integrations. */
export const renderEssayMgClips = async (sel: NovelSelection): Promise<void> => { await renderEssayMgEpisode(sel); };
