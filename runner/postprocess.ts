import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import type { NovelSelection } from "../ui/select.js";
import { CONFIG_DIR } from "../utils/run-python.js";
import { novelPaths } from "../utils/paths.js";

interface BgmConfig {
  bgm_dir?: string;
}

const ROOT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TITLE_SCRIPT = path.join(ROOT_DIR, "scripts", "title_watermark_gui.py");
const SPEED_BGM_SCRIPT = path.join(ROOT_DIR, "scripts", "speed_video_with_bgm.py");
const GENERATE_BGM_SCRIPT = path.join(ROOT_DIR, "utils", "generate-bgm.ts");
const BGM_CONFIG_PATH = path.join(CONFIG_DIR, "bgm_config.json");
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg"]);

async function readBgmDirectory(): Promise<string | null> {
  try {
    const config = JSON.parse(await fs.readFile(BGM_CONFIG_PATH, "utf-8")) as BgmConfig;
    if (typeof config.bgm_dir === "string" && config.bgm_dir.trim()) {
      return config.bgm_dir.trim();
    }
  } catch (err) {
    console.warn(`  [视频后处理] 无法读取 BGM 配置 ${BGM_CONFIG_PATH}: ${err}`);
  }
  return null;
}

async function selectRandomBgm(): Promise<string | null> {
  const bgmDir = await readBgmDirectory();
  if (!bgmDir) {
    console.warn("  [视频后处理] bgm_config.json 未配置 bgm_dir，议论文将仅执行倍速");
    return null;
  }

  try {
    const files = (await fs.readdir(bgmDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
      .map((entry) => path.join(bgmDir, entry.name));
    if (files.length === 0) {
      console.warn(`  [视频后处理] BGM 目录没有可用音频，议论文将仅执行倍速: ${bgmDir}`);
      return null;
    }
    return files[Math.floor(Math.random() * files.length)];
  } catch (err) {
    console.warn(`  [视频后处理] 无法读取 BGM 目录，议论文将仅执行倍速: ${err}`);
    return null;
  }
}

async function postprocessStory(sel: NovelSelection, episodeVideo: string): Promise<Record<string, unknown>> {
  const epDir = novelPaths.episodeDir(sel.novelName, sel.episode);
  const cleanTextPath = novelPaths.cleanedText(sel.novelName, sel.episode);

  // 故事继续使用现有 ACE-Step 阶段生成 BGM；失败时仍对原始集视频执行标题与倍速。
  try {
    execFileSync(process.execPath, ["--import", "tsx", GENERATE_BGM_SCRIPT, cleanTextPath], { stdio: "inherit" });
  } catch (err) {
    console.warn(`  [BGM] ACE-Step 生成失败或跳过，将继续处理原始集视频: ${err}`);
  }

  const title = `${sel.novelName} ${String(sel.episode).padStart(2, "0")}`;
  execFileSync("python", [
    TITLE_SCRIPT,
    "--folder", epDir,
    "--videos-folder", epDir,
    "--title", title,
    "--txt", cleanTextPath,
    "--no-intro",
    "--apply",
    "--speed", "1.1",
  ], { stdio: "inherit" });

  if (!fsSync.existsSync(episodeVideo)) throw new Error(`故事后处理后找不到集视频: ${episodeVideo}`);
  return { article_type: "story", speed: 1.1, title };
}

async function postprocessEssay(sel: NovelSelection, episodeVideo: string): Promise<Record<string, unknown>> {
  const tempOutput = novelPaths.postprocessTempVideo(sel.novelName, sel.episode);
  const bgm = await selectRandomBgm();
  await fs.rm(tempOutput, { force: true });

  const args = [SPEED_BGM_SCRIPT, episodeVideo, "--speed", "1.2", "--output", tempOutput];
  if (bgm) args.push("--bgm", bgm);

  try {
    execFileSync("python", args, { stdio: "inherit" });
    await fs.rename(tempOutput, episodeVideo);
  } catch (err) {
    await fs.rm(tempOutput, { force: true });
    throw err;
  }

  return { article_type: "essay", speed: 1.2, bgm };
}

/** 对已合并的集视频执行文章类型对应的最终后处理。 */
export async function postprocessEpisodeVideo(sel: NovelSelection): Promise<void> {
  const episodeVideo = novelPaths.episodeVideo(sel.novelName, sel.episode);
  const markerPath = novelPaths.postprocessMarker(sel.novelName, sel.episode);
  if (fsSync.existsSync(markerPath)) {
    console.log("  [视频后处理] 已完成，跳过");
    return;
  }
  if (!fsSync.existsSync(episodeVideo)) throw new Error(`找不到待处理集视频: ${episodeVideo}`);

  console.log(`\n  正在执行${sel.articleType === "essay" ? "议论文" : "故事"}视频后处理...`);
  const details = sel.articleType === "essay"
    ? await postprocessEssay(sel, episodeVideo)
    : await postprocessStory(sel, episodeVideo);

  await fs.writeFile(markerPath, JSON.stringify({
    ...details,
    completed_at: new Date().toISOString(),
  }, null, 2), "utf-8");
  console.log(`  [视频后处理] 完成: ${episodeVideo}`);
}
