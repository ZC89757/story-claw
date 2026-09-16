import {execFile} from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import {promisify} from "node:util";
import {FFMPEG_PATH, FFPROBE_PATH} from "./media-binaries.js";

const execFileAsync = promisify(execFile);

type ProbeStream = {
  codec_type?: string;
  nb_read_packets?: string;
  duration?: string;
  start_time?: string;
  avg_frame_rate?: string;
};

type ProbeResult = {
  streams?: ProbeStream[];
  format?: {duration?: string};
};

export type SpeedVideoOptions = {
  input: string;
  output: string;
  speed: number;
  bgm?: string | null;
  bgmVolumeDb?: number;
  fadeOutSeconds?: number;
};

const run = async (command: string, args: string[]): Promise<string> => {
  try {
    const {stdout} = await execFileAsync(command, args, {maxBuffer: 16 * 1024 * 1024});
    return stdout.trim();
  } catch (error: any) {
    const detail = String(error?.stderr || error?.message || error).trim();
    throw new Error(`${path.basename(command)} 执行失败: ${detail.slice(-3000)}`);
  }
};

const probe = async (filePath: string, countPackets = false): Promise<ProbeResult> => {
  const args = ["-v", "error"];
  if (countPackets) args.push("-count_packets");
  args.push("-show_streams", "-show_format", "-of", "json", filePath);
  return JSON.parse(await run(FFPROBE_PATH, args)) as ProbeResult;
};

const parseRate = (value = "0/1"): number => {
  const [numerator = 0, denominator = 1] = value.split("/").map(Number);
  return numerator && denominator ? numerator / denominator : 25;
};

const videoInfo = async (filePath: string): Promise<{packets: number; duration: number; fps: number}> => {
  const data = await probe(filePath, true);
  const stream = data.streams?.find((item) => item.codec_type === "video");
  if (!stream) throw new Error(`视频缺少画面流: ${filePath}`);
  const packets = Number(stream.nb_read_packets);
  const duration = Number(stream.duration || data.format?.duration);
  const fps = parseRate(stream.avg_frame_rate);
  if (!Number.isInteger(packets) || packets < 1 || !Number.isFinite(duration) || duration <= 0) {
    throw new Error(`无法读取视频帧包或时长: ${filePath}`);
  }
  return {packets, duration, fps};
};

const streamTimings = async (filePath: string): Promise<Map<string, {start: number; duration: number}>> => {
  const data = await probe(filePath);
  const result = new Map<string, {start: number; duration: number}>();
  for (const stream of data.streams || []) {
    const kind = stream.codec_type;
    if (kind !== "video" && kind !== "audio") continue;
    result.set(kind, {
      start: Number(stream.start_time || 0),
      duration: Number(stream.duration || data.format?.duration),
    });
  }
  for (const [kind, timing] of result) {
    if (!Number.isFinite(timing.start) || !Number.isFinite(timing.duration) || timing.duration <= 0) {
      throw new Error(`无法读取${kind === "video" ? "视频" : "音频"}流时间信息: ${filePath}`);
    }
  }
  return result;
};

/** Build an FFmpeg atempo chain for speeds outside a single filter's 0.5-2.0 range. */
export const buildAtempoChain = (speed: number): string => {
  if (!Number.isFinite(speed) || speed <= 0) throw new Error("speed 必须是大于 0 的有限数值");
  const factors: number[] = [];
  let remaining = speed;
  while (remaining > 2) {
    factors.push(2);
    remaining /= 2;
  }
  while (remaining < 0.5) {
    factors.push(0.5);
    remaining /= 0.5;
  }
  factors.push(remaining);
  return factors.map((factor) => `atempo=${factor.toFixed(9)}`).join(",");
};

/**
 * Change playback speed without dropping video packets and optionally mix a looping BGM.
 * The output must differ from the input and is never overwritten.
 */
export const speedVideoWithBgm = async ({
  input,
  output,
  speed,
  bgm = null,
  bgmVolumeDb = -18,
  fadeOutSeconds = 3,
}: SpeedVideoOptions): Promise<void> => {
  if (!Number.isFinite(speed) || speed <= 0) throw new Error("speed 必须是大于 0 的有限数值");
  if (!Number.isFinite(fadeOutSeconds) || fadeOutSeconds < 0) throw new Error("fadeOutSeconds 必须是 >= 0 的有限数值");
  const source = path.resolve(input);
  const destination = path.resolve(output);
  const bgmPath = bgm ? path.resolve(bgm) : null;
  if (source === destination) throw new Error("输出路径不能与输入视频相同");
  await fs.access(source);
  if (bgmPath) await fs.access(bgmPath);
  try {
    await fs.access(destination);
    throw new Error(`输出文件已存在，拒绝覆盖: ${destination}`);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }

  await fs.mkdir(path.dirname(destination), {recursive: true});
  const inputInfo = await videoInfo(source);
  const temporaryDirectory = await fs.mkdtemp(path.join(path.dirname(destination), ".story-claw-speed-"));
  const videoTemporary = path.join(temporaryDirectory, "video.mp4");
  const audioTemporary = path.join(temporaryDirectory, "audio.m4a");
  const outputTemporary = path.join(temporaryDirectory, "output.mp4");

  try {
    await run(FFMPEG_PATH, [
      "-y", "-v", "warning",
      "-itsscale", (1 / speed).toFixed(15), "-i", source,
      "-map", "0:v:0", "-an", "-c:v", "copy",
      "-avoid_negative_ts", "make_zero", videoTemporary,
    ]);
    const adjusted = await videoInfo(videoTemporary);
    if (adjusted.packets !== inputInfo.packets) {
      throw new Error(`视频帧包丢失：输入 ${inputInfo.packets}，变速后 ${adjusted.packets}`);
    }

    const voice = `[0:a:0]${buildAtempoChain(speed)},aresample=44100:first_pts=0[voice]`;
    let filter: string;
    const audioInputs = ["-i", source];
    if (bgmPath) {
      audioInputs.push("-i", bgmPath);
      const fade = Math.min(fadeOutSeconds, adjusted.duration);
      const fadeStart = Math.max(0, adjusted.duration - fade);
      let bgmFilter = `[1:a:0]aloop=loop=-1:size=2e+09,volume=${bgmVolumeDb}dB,` +
        `aresample=44100:first_pts=0,atrim=0:${adjusted.duration.toFixed(9)}`;
      if (fade > 0) bgmFilter += `,afade=t=out:st=${fadeStart.toFixed(9)}:d=${fade.toFixed(9)}`;
      filter = `${voice};${bgmFilter}[bgm];[voice][bgm]amix=inputs=2:duration=longest:` +
        `dropout_transition=0,atrim=0:${adjusted.duration.toFixed(9)},asetpts=N/SR/TB[mix]`;
    } else {
      filter = `${voice};[voice]atrim=0:${adjusted.duration.toFixed(9)},asetpts=N/SR/TB[mix]`;
    }
    await run(FFMPEG_PATH, [
      "-y", "-v", "warning", ...audioInputs,
      "-filter_complex", filter, "-map", "[mix]",
      "-c:a", "aac", "-b:a", "192k", audioTemporary,
    ]);
    await run(FFMPEG_PATH, [
      "-y", "-v", "warning",
      "-i", videoTemporary, "-i", audioTemporary,
      "-map", "0:v:0", "-map", "1:a:0", "-c", "copy",
      "-t", adjusted.duration.toFixed(9), "-movflags", "+faststart", outputTemporary,
    ]);

    const outputInfo = await videoInfo(outputTemporary);
    const timings = await streamTimings(outputTemporary);
    if (outputInfo.packets !== inputInfo.packets) {
      throw new Error(`最终视频帧包不一致：输入 ${inputInfo.packets}，输出 ${outputInfo.packets}`);
    }
    const videoTiming = timings.get("video");
    const audioTiming = timings.get("audio");
    if (!videoTiming || !audioTiming) throw new Error("最终文件缺少视频流或音频流");
    const tolerance = Math.max(1 / adjusted.fps, 0.05);
    if (Math.abs(videoTiming.start - audioTiming.start) > tolerance) {
      throw new Error(`音视频起始时间不一致：视频 ${videoTiming.start.toFixed(6)}s，音频 ${audioTiming.start.toFixed(6)}s`);
    }
    if (Math.abs(videoTiming.duration - audioTiming.duration) > tolerance) {
      throw new Error(
        `音视频时长差超限：视频 ${videoTiming.duration.toFixed(6)}s，` +
        `音频 ${audioTiming.duration.toFixed(6)}s，容差 ${tolerance.toFixed(6)}s`,
      );
    }
    await fs.rename(outputTemporary, destination);
    console.log(`  [视频后处理] 无丢帧变速完成：${inputInfo.packets} 帧包，${videoTiming.duration.toFixed(3)}s`);
  } catch (error) {
    await fs.rm(destination, {force: true});
    throw error;
  } finally {
    await fs.rm(temporaryDirectory, {recursive: true, force: true});
  }
};
