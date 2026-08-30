import fs from "node:fs/promises";
import {createHash} from "node:crypto";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {bundle} from "@remotion/bundler";
import {renderMedia, selectComposition} from "@remotion/renderer";
import {classifyImageSource} from "@story-claw/mg-templates";
import type {MgRenderInput} from "@story-claw/mg-templates";
import type {NovelSelection} from "../../ui/select.js";
import {generateImage} from "../../utils/image-gen.js";
import {novelPaths} from "../../utils/paths.js";
import {assertMgVideoFrames, hasAudioStream, runMediaCommand, sha256File} from "./media.js";
import type {MgPlan, MgRenderBundle, MgScenePlan} from "./types.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TEMPLATE_ENTRY = fileURLToPath(import.meta.resolve("@story-claw/mg-templates"));
const TEMPLATE_ROOT = path.resolve(path.dirname(TEMPLATE_ENTRY), "..");
const REMOTION_ENTRY = path.join(TEMPLATE_ROOT, "runtime", "render-entry.tsx");
const BUILTIN_PUBLIC_DIR = path.join(TEMPLATE_ROOT, "public");

type ImageSpec = {image?: unknown};
type MediaSpec = {images?: ImageSpec[]; [key: string]: unknown};

const assetKey = (source: string): string => createHash("sha256").update(source).digest("hex").slice(0, 24);

const imageExtension = (source: string, contentType?: string): string => {
  const fromUrl = (() => {
    try { return path.extname(new URL(source).pathname).toLowerCase(); } catch { return ""; }
  })();
  if (/^\.(svg|png|jpe?g|webp|gif|avif|bmp)$/i.test(fromUrl)) return fromUrl === ".jpeg" ? ".jpg" : fromUrl;
  const mime = (contentType ?? "").split(";", 1)[0].toLowerCase();
  return ({"image/svg+xml": ".svg", "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif", "image/avif": ".avif", "image/bmp": ".bmp"} as Record<string, string>)[mime] ?? ".png";
};

const localImagePath = async (source: string, rawVideoPath: string, publicDir: string): Promise<string | undefined> => {
  if (/^file:\/\//i.test(source)) {
    try { source = decodeURIComponent(new URL(source).pathname.replace(/^\/+([A-Za-z]:)/, "$1")); } catch { return undefined; }
  }
  const candidates = path.isAbsolute(source)
    ? [source]
    : [
      path.resolve(path.dirname(rawVideoPath), source),
      path.resolve(publicDir, source),
      path.resolve(publicDir, source.replace(/^public[\\/]/i, "")),
      path.resolve(BUILTIN_PUBLIC_DIR, source),
      path.resolve(BUILTIN_PUBLIC_DIR, source.replace(/^public[\\/]/i, "")),
      path.resolve(PROJECT_ROOT, source),
      path.resolve(PROJECT_ROOT, source.replace(/^public[\\/]/i, "")),
      path.resolve(process.cwd(), source),
    ];
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // A missing path is treated as an image-generation prompt below.
    }
  }
  return undefined;
};

const imageFileExtension = /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/i;

const prepareImageAssets = async (
  scenes: MgScenePlan[],
  rawVideoPath: string,
  publicDir: string,
  width: number,
  height: number,
): Promise<void> => {
  const assetsDir = path.join(publicDir, "assets");
  await fs.mkdir(assetsDir, {recursive: true});
  const cache = new Map<string, Promise<string>>();
  const resolve = (source: string): Promise<string> => {
    source = source.trim();
    const cached = cache.get(source);
    if (cached) return cached;
    const pending = (async () => {
      const key = assetKey(source);
      const sourceKind = classifyImageSource(source);
      if (/^https?:\/\//i.test(source)) {
        const response = await fetch(source, {signal: AbortSignal.timeout(60_000)});
        if (!response.ok) throw new Error(`图片 URL 请求失败 ${response.status}: ${source}`);
        const contentType = response.headers.get("content-type") ?? "";
        if (contentType && !/^image\//i.test(contentType)) {
          throw new Error(`图片 URL 返回的不是图片（${contentType}）: ${source}`);
        }
        const output = path.join(assetsDir, `${key}${imageExtension(source, contentType)}`);
        await fs.writeFile(output, Buffer.from(await response.arrayBuffer()));
        return `assets/${path.basename(output)}`;
      }

      if (/^data:image\//i.test(source)) {
        const match = source.match(/^data:(image\/[^;]+);base64,(.*)$/is);
        if (!match) throw new Error(`不支持的 data 图片格式: ${source.slice(0, 80)}`);
        const output = path.join(assetsDir, `${key}${imageExtension("", match[1])}`);
        if (!await fs.stat(output).then(() => true).catch(() => false)) await fs.writeFile(output, Buffer.from(match[2], "base64"));
        return `assets/${path.basename(output)}`;
      }

      if (/^blob:/i.test(source)) {
        throw new Error(`不支持 blob 图片链接，请使用可访问的 http(s) URL 或本地路径: ${source.slice(0, 120)}`);
      }

      if (/^data:/i.test(source) && !/^data:image\//i.test(source)) {
        throw new Error(`图片链接必须是 image 类型: ${source.slice(0, 120)}`);
      }

      const local = await localImagePath(source, rawVideoPath, publicDir);
      if (local) {
        const ext = path.extname(local).toLowerCase();
        if (ext && !imageFileExtension.test(ext)) {
          throw new Error(`图片素材不是支持的图片文件: ${source}`);
        }
        const output = path.join(assetsDir, `${key}${ext || ".png"}`);
        await fs.copyFile(local, output);
        return `assets/${path.basename(output)}`;
      }

      if (sourceKind === "local" || /^file:/i.test(source)) {
        throw new Error(`找不到本地图片素材: ${source}`);
      }

      const output = path.join(assetsDir, `${key}.png`);
      if (!await fs.stat(output).then(() => true).catch(() => false)) {
        const aspect = width >= height ? "16:9" : "9:16";
        await generateImage(source, output, [], aspect);
      }
      return `assets/${path.basename(output)}`;
    })();
    cache.set(source, pending);
    return pending;
  };

  const processSpec = async (scene: MgScenePlan, spec: unknown): Promise<void> => {
    if (!spec || typeof spec !== "object" || !["image-stack", "image-grid"].includes(scene.template)) return;
    const media = spec as MediaSpec;
    if (!Array.isArray(media.images)) return;
    for (const item of media.images) {
      if (!item || typeof item.image !== "string" || !item.image.trim()) {
        throw new Error(`${scene.id} 的图片素材 image 必须是非空字符串`);
      }
      item.image = await resolve(item.image);
    }
  };

  for (const scene of scenes) {
    await processSpec(scene, scene.spec);
    for (const overlay of scene.overlays) await processSpec(scene, overlay.spec);
  }
};

const preparePublicAssets = async (
  scenes: MgScenePlan[],
  rawVideoPath: string,
  publicDir: string,
  width: number,
  height: number,
  fps: number,
): Promise<void> => {
  await fs.mkdir(publicDir, {recursive: true});
  const logoSource = path.join(BUILTIN_PUBLIC_DIR, "ai-company-logos");
  const logoTarget = path.join(publicDir, "ai-company-logos");
  await fs.cp(logoSource, logoTarget, {recursive: true, force: true});
  const audioSource = path.join(BUILTIN_PUBLIC_DIR, "audio");
  const audioTarget = path.join(publicDir, "audio");
  await fs.cp(audioSource, audioTarget, {recursive: true, force: true});

  await prepareImageAssets(scenes, rawVideoPath, publicDir, width, height);

  const baseDir = path.join(publicDir, "base");
  await fs.mkdir(baseDir, {recursive: true});
  for (const scene of scenes.filter((candidate) => candidate.renderMode === "overlay")) {
    if (!scene.baseFile) throw new Error(`叠加场景 ${scene.id} 缺少 baseFile`);
    const outputPath = path.join(publicDir, scene.baseFile);
    try {
      await assertMgVideoFrames(outputPath, scene.durationFrames, fps);
      continue;
    } catch {
      // 缺失或不完整的运行时底片重新生成，不影响原画母版。
    }
    await fs.mkdir(path.dirname(outputPath), {recursive: true});
    await runMediaCommand("ffmpeg", [
      "-hide_banner",
      "-loglevel", "error",
      "-y",
      "-i", rawVideoPath,
      "-vf",
      `trim=start_frame=${scene.startFrame}:end_frame=${scene.endFrame},` +
        `setpts=PTS-STARTPTS,fps=${fps},scale=${width}:${height},setsar=1,format=yuv420p`,
      "-frames:v", String(scene.durationFrames),
      "-an",
      "-c:v", "libx264",
      "-preset", "fast",
      "-crf", "18",
      "-pix_fmt", "yuv420p",
      outputPath,
    ]);
    await assertMgVideoFrames(outputPath, scene.durationFrames, fps);
  }
};

export async function renderEssayMgClips(sel: NovelSelection): Promise<void> {
  const planPath = novelPaths.mgPlan(sel.novelName, sel.episode);
  const bundlePath = novelPaths.mgRenderBundle(sel.novelName, sel.episode);
  const rawVideoPath = novelPaths.episodeRawVideo(sel.novelName, sel.episode);
  const [plan, renderBundle] = await Promise.all([
    fs.readFile(planPath, "utf-8").then((value) => JSON.parse(value) as MgPlan),
    fs.readFile(bundlePath, "utf-8").then((value) => JSON.parse(value) as MgRenderBundle),
  ]);
  const hashBefore = await sha256File(rawVideoPath);
  if (hashBefore !== plan.source.sha256) throw new Error("原画母版已在 MG 规划后发生变化，停止渲染");

  const clipsDir = novelPaths.mgClipsDir(sel.novelName, sel.episode);
  const propsDir = novelPaths.mgPropsDir(sel.novelName, sel.episode);
  const publicDir = novelPaths.mgPublicDir(sel.novelName, sel.episode);
  await Promise.all([
    fs.mkdir(clipsDir, {recursive: true}),
    fs.mkdir(propsDir, {recursive: true}),
  ]);
  await preparePublicAssets(
    renderBundle.scenes,
    rawVideoPath,
    publicDir,
    renderBundle.width,
    renderBundle.height,
    renderBundle.fps,
  );

  if (renderBundle.scenes.length > 0) {
    console.log(`[MG渲染] 正在打包模板运行时...`);
    const serveUrl = await bundle({
      entryPoint: REMOTION_ENTRY,
      publicDir,
      onProgress: (progress) => {
        if (progress === 1 || Math.round(progress * 100) % 20 === 0) {
          console.log(`[MG渲染] 模板打包 ${Math.round(progress * 100)}%`);
        }
      },
    });

    for (let index = 0; index < renderBundle.scenes.length; index++) {
      const scene = renderBundle.scenes[index];
      const outputPath = path.join(novelPaths.mgDir(sel.novelName, sel.episode), scene.clipFile);
      // 图片来源可以在同一路径下更新（远程 URL 内容或本地文件内容），不能只凭旧片段帧数复用。
      const hasImageMedia = scene.template === "image-stack" || scene.template === "image-grid";
      if (!hasImageMedia) {
        try {
          await assertMgVideoFrames(outputPath, scene.durationFrames, renderBundle.fps);
          // Fixed-sound templates must be rerendered when an older video-only
          // clip is found. Other templates remain reusable by frame count.
          const audioRequired = ["title", "showcase", "metric", "transition", "rhythm", "effect", "camera"].includes(scene.template);
          if (!audioRequired || await hasAudioStream(outputPath)) {
            console.log(`[MG渲染] ${index + 1}/${renderBundle.scenes.length} ${scene.id} 已完成，跳过`);
            continue;
          }
        } catch {
          // 缺失或不完整的片段重新渲染。
        }
      }

      const inputProps: MgRenderInput = {
        width: renderBundle.width,
        height: renderBundle.height,
        fps: renderBundle.fps,
        scene,
      };
      const propsPath = path.join(propsDir, `${scene.id}.json`);
      await fs.writeFile(propsPath, `${JSON.stringify(inputProps, null, 2)}\n`, "utf-8");
      const composition = await selectComposition({
        serveUrl,
        id: "StoryClawMgScene",
        inputProps,
      });
      console.log(`[MG渲染] ${index + 1}/${renderBundle.scenes.length} ${scene.id} (${scene.durationFrames} 帧)`);
      await renderMedia({
        composition,
        serveUrl,
        codec: "h264",
        // Keep fixed template SFX; the aligned narration is mixed at finalize.
        muted: false,
        outputLocation: outputPath,
        inputProps,
        crf: 18,
        x264Preset: "fast",
        pixelFormat: "yuv420p",
        logLevel: "warn",
      });
      await assertMgVideoFrames(outputPath, scene.durationFrames, renderBundle.fps);
    }
  }

  const hashAfter = await sha256File(rawVideoPath);
  if (hashAfter !== hashBefore) throw new Error("MG 渲染期间原画母版发生变化");
}
