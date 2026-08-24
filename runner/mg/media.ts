import {createHash} from "node:crypto";
import {execFile, spawn} from "node:child_process";
import fs from "node:fs/promises";
import {promisify} from "node:util";
import type {MgVideoInfo} from "./types.js";

const execFileAsync = promisify(execFile);

const parseRate = (rate: string): number => {
  const [numerator, denominator = "1"] = rate.split("/");
  return Number(numerator) / Number(denominator);
};

export const sha256File = async (filePath: string): Promise<string> => {
  const data = await fs.readFile(filePath);
  return createHash("sha256").update(data).digest("hex");
};

export const probeMgVideo = async (filePath: string): Promise<MgVideoInfo> => {
  const {stdout} = await execFileAsync("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-count_frames",
    "-show_entries", "stream=width,height,avg_frame_rate,r_frame_rate,nb_frames,nb_read_frames:format=duration",
    "-of", "json",
    filePath,
  ]);
  const probe = JSON.parse(stdout) as {streams?: Array<Record<string, string | number>>; format?: Record<string, string>};
  const stream = probe.streams?.[0];
  if (!stream) throw new Error(`视频缺少画面流: ${filePath}`);
  const fps = parseRate(String(stream.avg_frame_rate || stream.r_frame_rate));
  const duration = Number(probe.format?.duration);
  const durationFrames = Number(stream.nb_frames || stream.nb_read_frames) || Math.round(duration * fps);
  const width = Number(stream.width);
  const height = Number(stream.height);
  if (![fps, duration, durationFrames, width, height].every(Number.isFinite)) {
    throw new Error(`无法读取视频信息: ${filePath}`);
  }
  return {fps, duration, durationFrames, width, height};
};

export const assertMgVideoFrames = async (
  filePath: string,
  expectedFrames: number,
  fps: number,
): Promise<void> => {
  const actual = await probeMgVideo(filePath);
  const expectedDuration = expectedFrames / fps;
  if (actual.durationFrames !== expectedFrames || Math.abs(actual.duration - expectedDuration) > 1 / fps + 0.001) {
    throw new Error(
      `MG 片段帧数校验失败: ${actual.durationFrames}/${expectedFrames}，` +
      `时长 ${actual.duration.toFixed(3)}/${expectedDuration.toFixed(3)}s (${filePath})`,
    );
  }
};

export const runMediaCommand = (
  command: string,
  args: string[],
  cwd?: string,
): Promise<void> => new Promise((resolve, reject) => {
  const child = spawn(command, args, {cwd, stdio: "inherit"});
  child.on("error", reject);
  child.on("close", (code) => {
    if (code === 0) resolve();
    else reject(new Error(`${command} 退出码 ${code}`));
  });
});
