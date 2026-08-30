import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import type {NovelSelection} from "../../ui/select.js";
import {novelPaths} from "../../utils/paths.js";
import {assertMgVideoFrames, hasAudioStream, runMediaCommand, sha256File} from "./media.js";
import type {MgPlan} from "./types.js";

type Segment = {
  kind: "raw" | "mg";
  startFrame: number;
  endFrame: number;
  inputPath: string;
};

export async function assembleEssayMg(sel: NovelSelection): Promise<string> {
  const plan = JSON.parse(
    await fs.readFile(novelPaths.mgPlan(sel.novelName, sel.episode), "utf-8"),
  ) as MgPlan;
  const rawVideoPath = novelPaths.episodeRawVideo(sel.novelName, sel.episode);
  const outputPath = novelPaths.episodeMgRawVideo(sel.novelName, sel.episode);
  const hashBefore = await sha256File(rawVideoPath);
  if (hashBefore !== plan.source.sha256) throw new Error("原画母版与 MG 计划哈希不一致，停止合成");

  if (fsSync.existsSync(outputPath)) {
    try {
      await assertMgVideoFrames(outputPath, plan.source.durationFrames, plan.source.fps);
      // A previous version emitted video-only MG output. Rebuild when this
      // plan contains scenes but the assembled file has no SFX stream.
      if (!plan.scenes.length || await hasAudioStream(outputPath)) {
        console.log(`[MG合成] 已有完整 MG 原片，跳过: ${outputPath}`);
        return outputPath;
      }
      console.warn(`[MG合成] 旧 MG 原片没有音效轨，重新合成: ${outputPath}`);
    } catch {
      const stalePath = `${outputPath}.invalid-${Date.now()}`;
      await fs.rename(outputPath, stalePath);
      console.warn(`[MG合成] 原有文件不完整，已保留为 ${path.basename(stalePath)}`);
    }
  }

  const scenes = [...plan.scenes].sort((left, right) => left.startFrame - right.startFrame);
  let previousEnd = 0;
  for (const scene of scenes) {
    if (scene.startFrame < previousEnd) throw new Error(`MG 场景发生重叠: ${scene.id}`);
    if (scene.endFrame - scene.startFrame !== scene.durationFrames) throw new Error(`MG 场景帧数不一致: ${scene.id}`);
    const clipPath = path.join(novelPaths.mgDir(sel.novelName, sel.episode), scene.clipFile);
    if (!fsSync.existsSync(clipPath)) throw new Error(`找不到 MG 片段: ${clipPath}`);
    await assertMgVideoFrames(clipPath, scene.durationFrames, plan.source.fps);
    previousEnd = scene.endFrame;
  }

  if (!scenes.length) {
    await fs.copyFile(rawVideoPath, outputPath);
    await assertMgVideoFrames(outputPath, plan.source.durationFrames, plan.source.fps);
    if (await sha256File(rawVideoPath) !== hashBefore) throw new Error("MG 合成期间原画母版发生变化");
    return outputPath;
  }

  const sequence: Segment[] = [];
  let cursor = 0;
  for (const scene of scenes) {
    if (scene.startFrame > cursor) {
      sequence.push({kind: "raw", startFrame: cursor, endFrame: scene.startFrame, inputPath: rawVideoPath});
    }
    sequence.push({
      kind: "mg",
      startFrame: 0,
      endFrame: scene.durationFrames,
      inputPath: path.join(novelPaths.mgDir(sel.novelName, sel.episode), scene.clipFile),
    });
    cursor = scene.endFrame;
  }
  if (cursor < plan.source.durationFrames) {
    sequence.push({kind: "raw", startFrame: cursor, endFrame: plan.source.durationFrames, inputPath: rawVideoPath});
  }

  const normalizedDir = novelPaths.mgNormalizedDir(sel.novelName, sel.episode);
  await fs.rm(normalizedDir, {recursive: true, force: true});
  await fs.mkdir(normalizedDir, {recursive: true});
  const normalizedFiles: string[] = [];
  for (let index = 0; index < sequence.length; index++) {
    const segment = sequence[index];
    const frameCount = segment.endFrame - segment.startFrame;
    const normalizedPath = path.join(normalizedDir, `segment_${String(index).padStart(3, "0")}.mp4`);
    const trim = segment.kind === "raw"
      ? `trim=start_frame=${segment.startFrame}:end_frame=${segment.endFrame}`
      : `trim=start_frame=0:end_frame=${frameCount}`;
    const filter = [
      trim,
      "setpts=PTS-STARTPTS",
      `fps=${plan.source.fps}`,
      `scale=${plan.source.width}:${plan.source.height}:in_range=auto:out_range=tv`,
      "setsar=1",
      "format=yuv420p",
    ].join(",");
    const hasSegmentAudio = segment.kind === "mg" && await hasAudioStream(segment.inputPath);
    const audioInput = hasSegmentAudio ? "[0:a]" : "[1:a]";
    const audioFilter = `${audioInput}aresample=44100,apad,atrim=duration=${(frameCount / plan.source.fps).toFixed(6)},asetpts=PTS-STARTPTS[a]`;
    const normalizeArgs = [
      "-hide_banner",
      "-loglevel", "error",
      "-y",
      "-i", segment.inputPath,
      ...(hasSegmentAudio ? [] : ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100"]),
      "-filter_complex", `[0:v]${filter}[v];${audioFilter}`,
      "-map", "[v]",
      "-map", "[a]",
      "-frames:v", String(frameCount),
      "-c:v", "libx264",
      "-preset", "fast",
      "-crf", "18",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "128k",
      "-shortest",
      "-color_range", "tv",
      "-colorspace", "bt709",
      "-color_primaries", "bt709",
      "-color_trc", "bt709",
      normalizedPath,
    ];
    await runMediaCommand("ffmpeg", normalizeArgs);
    await assertMgVideoFrames(normalizedPath, frameCount, plan.source.fps);
    normalizedFiles.push(normalizedPath);
    console.log(`[MG合成] 标准化 ${index + 1}/${sequence.length}: ${frameCount} 帧`);
  }

  const concatList = path.join(normalizedDir, "concat.txt");
  await fs.writeFile(
    concatList,
    normalizedFiles.map((filePath) => `file '${filePath.replace(/\\/g, "/")}'`).join("\n"),
    "utf-8",
  );
  const nextPath = `${outputPath}.next.mp4`;
  await fs.rm(nextPath, {force: true});
  await runMediaCommand("ffmpeg", [
    "-hide_banner",
    "-loglevel", "error",
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", concatList,
    "-map", "0:v:0",
    "-map", "0:a:0",
    "-c:v", "copy",
    "-c:a", "copy",
    nextPath,
  ]);
  await assertMgVideoFrames(nextPath, plan.source.durationFrames, plan.source.fps);
  await fs.rename(nextPath, outputPath);

  const hashAfter = await sha256File(rawVideoPath);
  if (hashAfter !== hashBefore) throw new Error("MG 合成期间原画母版发生变化");
  console.log(`[MG合成] 完成 → ${outputPath}`);
  return outputPath;
}

export async function renderAndAssembleEssayMg(sel: NovelSelection): Promise<string> {
  const {renderEssayMgClips} = await import("./renderer.js");
  await renderEssayMgClips(sel);
  return assembleEssayMg(sel);
}
