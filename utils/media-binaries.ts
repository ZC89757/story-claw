import fs from "node:fs";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffprobeInstaller from "@ffprobe-installer/ffprobe";

const executablePath = (configured: string | undefined, installed: string, fallback: string): string => {
  if (configured?.trim()) return configured.trim();
  const unpacked = installed.replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
  // Electron can report files inside app.asar as existing, but native binaries
  // must execute from the unpacked path.
  if (unpacked !== installed && fs.existsSync(unpacked)) return unpacked;
  if (fs.existsSync(installed)) return installed;
  return fallback;
};

export const FFMPEG_PATH = executablePath(
  process.env.STORY_CLAW_FFMPEG_PATH,
  ffmpegInstaller.path,
  process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
);

export const FFPROBE_PATH = executablePath(
  process.env.STORY_CLAW_FFPROBE_PATH,
  ffprobeInstaller.path,
  process.platform === "win32" ? "ffprobe.exe" : "ffprobe",
);

export const resolveMediaCommand = (command: string): string => {
  if (command === "ffmpeg" || command === "ffmpeg.exe") return FFMPEG_PATH;
  if (command === "ffprobe" || command === "ffprobe.exe") return FFPROBE_PATH;
  return command;
};
