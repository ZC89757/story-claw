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
import {assertMgVideoFrames, sha256File} from "./media.js";
import type {MgPlan, MgRenderBundle} from "./types.js";

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

const localImagePath = async (source: string, rawVideoPath: string, publicDir: string): Promise<string | undefined> => {
  if (/^file:\/\//i.test(source)) {
    try { source = decodeURIComponent(new URL(source).pathname.replace(/^\/+([A-Za-z]:)/, "$1")); } catch { return undefined; }
  }
  // A template may describe an asset as public/foo.png. The Provider copies
  // its runtime public assets into this render's public directory, while a
  // project may also genuinely contain public/foo.png. Check both forms
  // without teaching Story Claw where a template package stores its files.
  const withoutPublicPrefix = source.replace(/^public[\\/]+/i, "");
  const candidates = path.isAbsolute(source) ? [source] : [
    path.resolve(path.dirname(rawVideoPath), source), path.resolve(publicDir, source),
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
  rawVideoPath: string,
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
      const local = await localImagePath(source, rawVideoPath, publicDir);
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
  bundleData: MgRenderBundle,
  rawVideoPath: string,
  publicDir: string,
): Promise<void> => {
  await fs.mkdir(publicDir, {recursive: true});
  await mgProvider.copyRuntimeAssets(publicDir);
  const basePath = path.join(publicDir, bundleData.baseFile);
  await fs.mkdir(path.dirname(basePath), {recursive: true});
  await fs.copyFile(rawVideoPath, basePath);
  await mgProvider.prepareRuntimeAssets({
    layers: bundleData.layers,
    resolveImage: makeImageResolver(rawVideoPath, publicDir, bundleData.width, bundleData.height),
  });
};

/** Render the raw master plus all MG layers in one Remotion composition. */
export async function renderEssayMgEpisode(sel: NovelSelection): Promise<string> {
  const planPath = novelPaths.mgPlan(sel.novelName, sel.episode);
  const bundlePath = novelPaths.mgRenderBundle(sel.novelName, sel.episode);
  const rawVideoPath = novelPaths.episodeRawVideo(sel.novelName, sel.episode);
  const outputPath = novelPaths.episodeMgRawVideo(sel.novelName, sel.episode);
  const [plan, renderBundle] = await Promise.all([
    fs.readFile(planPath, "utf-8").then((value) => JSON.parse(value) as MgPlan),
    fs.readFile(bundlePath, "utf-8").then((value) => JSON.parse(value) as MgRenderBundle),
  ]);
  const hashBefore = await sha256File(rawVideoPath);
  if (hashBefore !== plan.source.sha256) throw new Error("原画母版已在 MG 规划后发生变化，停止渲染");

  if (!renderBundle.layers.length) {
    await fs.copyFile(rawVideoPath, outputPath);
    await assertMgVideoFrames(outputPath, renderBundle.durationFrames, renderBundle.fps);
    return outputPath;
  }

  const publicDir = novelPaths.mgPublicDir(sel.novelName, sel.episode);
  await preparePublicAssets(renderBundle, rawVideoPath, publicDir);
  console.log("[MG渲染] 正在打包模板 Provider 运行时...");
  const serveUrl = await bundle({
    entryPoint: REMOTION_ENTRY,
    publicDir,
    onProgress: (progress) => {
      if (progress === 1 || Math.round(progress * 100) % 20 === 0) console.log(`[MG渲染] 模板打包 ${Math.round(progress * 100)}%`);
    },
  });
  const composition = await selectComposition({serveUrl, id: "StoryClawMgEpisode", inputProps: {episode: renderBundle}});
  const nextPath = `${outputPath}.next.mp4`;
  await fs.rm(nextPath, {force: true});
  console.log(`[MG渲染] 整集合成 ${renderBundle.layers.length} 个 MG 图层 / ${renderBundle.durationFrames} 帧`);
  await renderMedia({
    composition,
    serveUrl,
    codec: "h264",
    muted: false,
    outputLocation: nextPath,
    inputProps: {episode: renderBundle},
    crf: 18,
    x264Preset: "fast",
    pixelFormat: "yuv420p",
    logLevel: "warn",
  });
  await assertMgVideoFrames(nextPath, renderBundle.durationFrames, renderBundle.fps);
  await fs.rm(outputPath, {force: true});
  await fs.rename(nextPath, outputPath);
  if (await sha256File(rawVideoPath) !== hashBefore) throw new Error("MG 渲染期间原画母版发生变化");
  return outputPath;
}

/** @deprecated: retained as a compatibility alias for existing integrations. */
export const renderEssayMgClips = async (sel: NovelSelection): Promise<void> => { await renderEssayMgEpisode(sel); };
