import fs from "node:fs/promises";
import path from "node:path";
import {createHash} from "node:crypto";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {getStoryVideoConfig, H3_FPS, type StoryVideoConfig} from "./story-video-config.js";
import {generateH3Video} from "./h3-video.js";
import {h3ClipPaths} from "./paths.js";
import {resolveMediaCommand} from "./media-binaries.js";

const execute = promisify(execFile);
const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
export function splitH3ClipFrames(duration: number, maxDuration: number): number[] {
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(maxDuration) || maxDuration < 1 / H3_FPS || maxDuration > 15) throw new Error("H3 片段时长无效");
  const frames = Math.round(duration * H3_FPS);
  if (frames < 1) throw new Error("H3 目标不足一帧");
  const count = Math.ceil(frames / Math.floor(maxDuration * H3_FPS));
  const base = Math.floor(frames / count);
  return Array.from({length: count}, (_, index) => base + (index < frames % count ? 1 : 0));
}

async function verify(file: string, frames: number): Promise<void> {
  const {stdout} = await execute(resolveMediaCommand("ffprobe"), ["-v", "error", "-count_frames", "-show_entries", "stream=codec_type,nb_read_frames,r_frame_rate", "-of", "json", file], {timeout: 120_000});
  const streams = JSON.parse(String(stdout)).streams ?? [];
  const video = streams.find((stream: any) => stream.codec_type === "video");
  if (Number(video?.nb_read_frames) !== frames || video?.r_frame_rate !== "24/1" || streams.some((stream: any) => stream.codec_type === "audio")) throw new Error("H3 片段帧数/帧率/音轨校验失败");
}

/** One HTML window, one output; long windows use bounded H3 jobs and real preceding tail frames. */
export async function generateH3Clip(input: {imagePath: string; prompt: string; outputPath: string; aspectRatio: string; duration: number}, config = getStoryVideoConfig()): Promise<void> {
  const canonical = (file: string) => process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file);
  if (canonical(input.imagePath) === canonical(input.outputPath)) throw new Error("H3 视频输出不能覆盖输入参考图");
  const parts = splitH3ClipFrames(input.duration, config.maxDuration);
  const frames = parts.reduce((a, b) => a + b, 0);
  const files = h3ClipPaths(input.outputPath);
  const fingerprint = hash(JSON.stringify({version: 1, backend: "h3", image: hash(await fs.readFile(input.imagePath)),
    workflow: hash(await fs.readFile(config.workflowPath)), prompt: input.prompt, aspectRatio: input.aspectRatio, parts}));
  const saved = await fs.readFile(files.completion, "utf8").then(JSON.parse).catch(() => null);
  if (saved?.fingerprint === fingerprint && saved?.videoHash === await fs.readFile(input.outputPath).then(hash).catch(() => "")) {
    await verify(input.outputPath, frames);
    return;
  }
  await fs.mkdir(files.directory, {recursive: true});
  let guide = input.imagePath;
  for (const [index, partFrames] of parts.entries()) {
    console.log(`[H3] ${path.basename(input.outputPath)} 分段 ${index + 1}/${parts.length}，目标 ${partFrames} 帧`);
    const prompt = `<Picture 1> supplies the visual identity and scene. ${input.prompt}${index ? " Continue the motion from the supplied frame-zero guide; preserve the same camera, subjects and setting." : ""}`;
    await generateH3Video({references: [input.imagePath], firstFrame: guide, prompt,
      outputPath: files.part(index), nativePath: files.native(index), requestPath: files.request(index),
      aspectRatio: input.aspectRatio, duration: partFrames / H3_FPS}, config);
    if (index + 1 < parts.length) {
      await execute(resolveMediaCommand("ffmpeg"), ["-y", "-i", files.part(index), "-vf", `select=eq(n\\,${partFrames - 1})`, "-frames:v", "1", files.lastFrame(index)], {timeout: 120_000});
      guide = files.lastFrame(index);
    }
  }
  try {
    if (parts.length === 1) await fs.copyFile(files.part(0), files.pending);
    else {
      await fs.writeFile(files.concat, parts.map((count, index) => `file 'part-${index}.mp4'\nduration ${(count / H3_FPS).toFixed(9)}`).join("\n") + "\n");
      await execute(resolveMediaCommand("ffmpeg"), ["-y", "-f", "concat", "-safe", "0", "-i", files.concat, "-map", "0:v:0",
        "-vf", `fps=${H3_FPS},trim=end_frame=${frames},setpts=PTS-STARTPTS`, "-frames:v", String(frames), "-r", String(H3_FPS),
        "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p", "-an", "-movflags", "+faststart", files.pending], {timeout: 300_000, maxBuffer: 1024 * 1024});
    }
    await verify(files.pending, frames);
    await fs.rename(files.pending, input.outputPath);
    await fs.writeFile(files.completion, JSON.stringify({backend: "h3", fingerprint, frames, parts, videoHash: hash(await fs.readFile(input.outputPath))}, null, 2));
  } finally { await fs.unlink(files.pending).catch(() => {}); }
}

/** Include actual workflow bytes in MG cache keys, including configurations using a custom API workflow. */
export function h3ClipCacheIdentity(config: StoryVideoConfig, workflow: Buffer): unknown {
  return {backend: "h3", adapterVersion: 1, fps: H3_FPS, maxDuration: config.maxDuration, workflow: hash(workflow)};
}
