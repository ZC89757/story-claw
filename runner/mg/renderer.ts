import fs from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {bundle} from "@remotion/bundler";
import {renderMedia, selectComposition} from "@remotion/renderer";
import type {MgRenderInput} from "@story-claw/mg-templates";
import type {NovelSelection} from "../../ui/select.js";
import {novelPaths} from "../../utils/paths.js";
import {assertMgVideoFrames, runMediaCommand, sha256File} from "./media.js";
import type {MgPlan, MgRenderBundle, MgScenePlan} from "./types.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TEMPLATE_ROOT = path.join(PROJECT_ROOT, "packages", "mg-templates");
const REMOTION_ENTRY = path.join(TEMPLATE_ROOT, "runtime", "render-entry.tsx");
const BUILTIN_PUBLIC_DIR = path.join(TEMPLATE_ROOT, "public");

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
      try {
        await assertMgVideoFrames(outputPath, scene.durationFrames, renderBundle.fps);
        console.log(`[MG渲染] ${index + 1}/${renderBundle.scenes.length} ${scene.id} 已完成，跳过`);
        continue;
      } catch {
        // 缺失或不完整的片段重新渲染。
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
