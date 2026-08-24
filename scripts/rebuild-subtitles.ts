import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR } from "../utils/run-python.js";
import { novelPaths } from "../utils/paths.js";
import {
  concatPanels,
  getMediaDuration,
  globalAlignAndMerge,
  ttsExecApi,
  ttsPhase4Concat,
  type SceneRenderResult,
  type SubtitleEvent,
} from "../runner/render.js";
import {
  findSubtitleBoundaryWords,
  splitSubtitleText,
  stripTrailingPunct,
  wrapSubtitleLines,
  type SubtitleWord,
} from "../runner/subtitles.js";

const execFileAsync = promisify(execFile);
const ROOT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SPEED_SCRIPT = path.join(ROOT_DIR, "scripts", "speed_video_with_bgm.py");

interface TtsConfig {
  narrator_voice: string;
  concurrency?: number;
  subtitles_max_chars_portrait?: number;
  subtitles_max_chars_landscape?: number;
}

interface RebuildTask {
  sceneName: string;
  groupIndex: number;
  globalOrder: number;
  sourceRenderDir: string;
  targetRenderDir: string;
  panelVideos: string[];
  segmentTexts: Array<{ path: string; text: string }>;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function loadTasks(novelName: string, episode: number, rebuildDir: string): Promise<RebuildTask[]> {
  const epDir = novelPaths.episodeDir(novelName, episode);
  const storyboardsDir = novelPaths.storyboardsDir(novelName, episode);
  const storyboardFiles = (await fs.readdir(storyboardsDir))
    .filter((name) => name.startsWith("storyboard_") && name.endsWith(".jsonl"))
    .sort();
  const tasks: RebuildTask[] = [];

  for (const storyboardFile of storyboardFiles) {
    const sceneName = storyboardFile.slice("storyboard_".length, -".jsonl".length);
    const sourceRenderDir = path.join(epDir, `render_${sceneName}`);
    const targetRenderDir = path.join(rebuildDir, `render_${sceneName}`);
    const lines = (await fs.readFile(path.join(storyboardsDir, storyboardFile), "utf-8"))
      .split(/\r?\n/)
      .filter((line) => line.trim());

    for (let gi = 0; gi < lines.length; gi++) {
      const group = JSON.parse(lines[gi]);
      const gtag = `g${String(gi).padStart(2, "0")}`;
      const panelVideos = (group.panels ?? []).map((_: unknown, pi: number) =>
        path.join(sourceRenderDir, `${gtag}_p${String(pi).padStart(2, "0")}.mp4`),
      );
      const missingPanels = panelVideos.filter((file: string) => !fsSync.existsSync(file));
      if (missingPanels.length > 0) {
        throw new Error(`${sceneName}/${gtag} 缺少 panel 视频: ${missingPanels.join(", ")}`);
      }

      const segmentDir = path.join(sourceRenderDir, "tts_segments");
      const segmentNames = (await fs.readdir(segmentDir))
        .filter((name) => new RegExp(`^${gtag}_s\\d+\\.txt$`).test(name))
        .sort();
      if (segmentNames.length === 0) throw new Error(`${sceneName}/${gtag} 没有 TTS 文本片段`);

      const segmentTexts = await Promise.all(segmentNames.map(async (name) => ({
        path: path.join(segmentDir, name),
        text: await fs.readFile(path.join(segmentDir, name), "utf-8"),
      })));
      tasks.push({
        sceneName,
        groupIndex: gi,
        globalOrder: Number(group.global_order ?? 999),
        sourceRenderDir,
        targetRenderDir,
        panelVideos,
        segmentTexts,
      });
    }
  }

  return tasks;
}

async function synthesizeGroup(
  task: RebuildTask,
  narratorVoice: string,
  aspectRatio: string,
  maxChars: number,
): Promise<{ task: RebuildTask; groupAudio: string; subtitleEvents: SubtitleEvent[] }> {
  await fs.mkdir(task.targetRenderDir, { recursive: true });
  const gtag = `g${String(task.groupIndex).padStart(2, "0")}`;
  const segmentDir = path.join(task.targetRenderDir, "tts_segments");
  await fs.mkdir(segmentDir, { recursive: true });

  const segmentResults: Array<{ path: string; words: SubtitleWord[]; text: string }> = [];
  for (let si = 0; si < task.segmentTexts.length; si++) {
    const source = task.segmentTexts[si];
    const output = path.join(segmentDir, `${gtag}_s${String(si).padStart(2, "0")}.mp3`);
    const result = await ttsExecApi(source.text, narratorVoice, "", output, { timestamp: true });
    segmentResults.push({ path: output, words: result.words, text: source.text });
  }

  const events: SubtitleEvent[] = [];
  let groupOffset = 0;
  for (const segment of segmentResults) {
    const duration = await getMediaDuration(segment.path);
    const sourceText = segment.text.replace(/【[^】]*】/g, "").replace(/\s/g, "");
    const chunks = splitSubtitleText(sourceText, maxChars);
    const timedWords = segment.words.filter((word) => word.word.replace(/\s/g, ""));
    const boundaries = findSubtitleBoundaryWords(timedWords, chunks);
    let startWord = 0;
    for (let ci = 0; ci < chunks.length; ci++) {
      const endWord = boundaries[ci];
      events.push({
        start: groupOffset + (timedWords[startWord]?.startTime ?? 0),
        end: groupOffset + (timedWords[endWord]?.endTime ?? duration),
        text: wrapSubtitleLines(stripTrailingPunct(chunks[ci].text), maxChars),
      });
      startWord = endWord + 1;
    }
    groupOffset += duration;
  }

  const subtitlePath = path.join(task.targetRenderDir, `${gtag}_subtitles.json`);
  await fs.writeFile(subtitlePath, JSON.stringify(events), "utf-8");
  const groupAudio = path.join(task.targetRenderDir, `${gtag}_tts.mp3`);
  await ttsPhase4Concat(segmentResults.map((segment) => segment.path), groupAudio);
  console.log(`[字幕重建] ${task.sceneName}/${gtag}: ${events.length} 条字幕`);
  return { task, groupAudio, subtitleEvents: events };
}

async function main(): Promise<void> {
  const novelName = process.argv[2] ?? "20260803";
  const episode = Number(process.argv[3] ?? "1");
  const rebuildDir = novelPaths.subtitleRebuildDir(novelName, episode);
  const finalVideo = novelPaths.subtitleRebuildVideo(novelName, episode);
  const globalSubtitlesJsonPath = novelPaths.subtitleRebuildGlobalSubtitlesJson(novelName, episode);
  const globalSubtitlesAssPath = novelPaths.subtitleRebuildGlobalSubtitlesAss(novelName, episode);
  if (!Number.isInteger(episode) || episode < 1) throw new Error(`非法集数: ${process.argv[3]}`);
  if (fsSync.existsSync(rebuildDir) || fsSync.existsSync(finalVideo)) {
    throw new Error(`字幕测试产物已存在，请先确认后再清理: ${rebuildDir}`);
  }

  const progress = JSON.parse(await fs.readFile(novelPaths.progress(novelName), "utf-8"));
  const aspectRatio = String(progress.aspect_ratio ?? "9:16");
  const ttsConfig = JSON.parse(
    await fs.readFile(path.join(CONFIG_DIR, "tts_config.json"), "utf-8"),
  ) as TtsConfig;
  const maxChars = aspectRatio === "9:16"
    ? (ttsConfig.subtitles_max_chars_portrait ?? 12)
    : (ttsConfig.subtitles_max_chars_landscape ?? 18);
  const tasks = await loadTasks(novelName, episode, rebuildDir);
  console.log(`[字幕重建] ${novelName}/ep${String(episode).padStart(2, "0")}: ${tasks.length} groups`);

  await fs.mkdir(rebuildDir, { recursive: true });
  const synthesized = await mapLimit(
    tasks,
    Math.max(1, Number(ttsConfig.concurrency ?? 4)),
    (task) => synthesizeGroup(task, ttsConfig.narrator_voice, aspectRatio, maxChars),
  );

  const sceneResults = new Map<string, SceneRenderResult>();
  for (const { task, groupAudio, subtitleEvents } of synthesized) {
    const gtag = `g${String(task.groupIndex).padStart(2, "0")}`;
    const groupVideo = path.join(task.targetRenderDir, `${gtag}.mp4`);
    await concatPanels(
      task.panelVideos,
      task.targetRenderDir,
      task.groupIndex,
      groupVideo,
      aspectRatio,
    );
    const result = sceneResults.get(task.sceneName) ?? {
      groups: [],
      globalSubtitlesJsonPath,
      globalSubtitlesAssPath,
    };
    result.groups.push({
      globalOrder: task.globalOrder,
      videoPath: groupVideo,
      ttsPath: groupAudio,
      subtitleEvents,
    });
    sceneResults.set(task.sceneName, result);
  }

  const alignedVideo = path.join(rebuildDir, "_aligned_no_bgm.mp4");
  await globalAlignAndMerge([...sceneResults.values()], alignedVideo, rebuildDir);
  await execFileAsync("python", [
    SPEED_SCRIPT,
    alignedVideo,
    "--speed", "1.2",
    "--output", finalVideo,
  ]);
  console.log(`[字幕重建] 完成: ${finalVideo}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
