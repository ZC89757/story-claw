import {execFile} from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "remove-solid-background.py");

/**
 * Remove a template-requested chroma background from an image and return the
 * resulting transparent PNG path.  The Python helper performs the pixel work
 * because Pillow is already part of the image-generation runtime.
 */
export const removeSolidBackground = async (
  inputPath: string,
  outputPath: string,
  backgroundColor = "#00ff00",
): Promise<string> => {
  await fs.mkdir(path.dirname(outputPath), {recursive: true});
  const temporaryPath = `${outputPath}.next.png`;
  await fs.rm(temporaryPath, {force: true});
  try {
    await execFileAsync("python", [SCRIPT_PATH, inputPath, temporaryPath, "--color", backgroundColor], {
      timeout: 180_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    await fs.rm(outputPath, {force: true});
    await fs.rename(temporaryPath, outputPath);
    return outputPath;
  } catch (error: any) {
    await fs.rm(temporaryPath, {force: true});
    const detail = [error?.message, error?.stderr].filter(Boolean).join("\n");
    throw new Error(`纯色背景抠图失败: ${detail || String(error)}`);
  }
};
