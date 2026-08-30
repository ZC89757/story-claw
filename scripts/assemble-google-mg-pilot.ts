import {createHash} from "node:crypto";
import {execFile, spawn} from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import {promisify} from "node:util";
import {fileURLToPath} from "node:url";

const execFileAsync = promisify(execFile);
const ROOT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const EP_DIR = path.join(
  ROOT_DIR,
  "workspace",
  "谷歌的第二次创业_横屏测试_20260822",
  "ep01",
);
const PILOT_DIR = path.join(EP_DIR, "mg_optimized");
const PLAN_PATH = path.join(PILOT_DIR, "mg_plan.json");
const RAW_VIDEO = path.join(EP_DIR, "ep01_raw.mp4");
const STORYBOARDS_DIR = path.join(EP_DIR, "storyboards");
const SUBTITLES_ASS = path.join(EP_DIR, "global_subtitles.ass");
const OPTIMIZED_SUBTITLES_ASS = path.join(PILOT_DIR, "subtitles_optimized.ass");
const RAW_MG_VIDEO = path.join(PILOT_DIR, "ep01_raw_mg_optimized.mp4");
const CONCAT_AUDIO = path.join(PILOT_DIR, "narration_concat.wav");
const ALIGNED_AUDIO = path.join(PILOT_DIR, "narration_aligned.wav");
const COMPLETE_VIDEO = path.join(PILOT_DIR, "ep01_mg_optimized_with_audio_subtitles.mp4");
const FINAL_VIDEO = path.join(PILOT_DIR, "ep01_mg_optimized_final.mp4");
const NEXT_FINAL_VIDEO = path.join(PILOT_DIR, "ep01_mg_optimized_final.next.mp4");
const VALIDATION_PATH = path.join(PILOT_DIR, "validation.json");
const SPEED_SCRIPT = path.join(ROOT_DIR, "scripts", "speed_video_with_bgm.py");
const BGM_PATH = path.join(ROOT_DIR, "bgm", "_bgm_src.mp3");

type Scene = {
  id: string;
  clipFile: string;
  startFrame: number;
  endFrame: number;
  durationFrames: number;
};

type Plan = {
  source: {
    sha256: string;
    fps: number;
    width: number;
    height: number;
    durationFrames: number;
    duration: number;
  };
  functionCalls?: unknown[];
  scenes: Scene[];
};

type AudioGroup = {
  globalOrder: number;
  sourceOrder: number;
  audioPath: string;
};

const run = (command: string, args: string[], cwd = ROOT_DIR): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {cwd, stdio: "inherit"});
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} 退出码 ${code}`));
    });
  });

const sha256 = async (filePath: string): Promise<string> => {
  const data = await fs.readFile(filePath);
  return createHash("sha256").update(data).digest("hex");
};

const probeDuration = async (filePath: string): Promise<number> => {
  const {stdout} = await execFileAsync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "csv=p=0",
    filePath,
  ]);
  const duration = Number(stdout.trim());
  if (!Number.isFinite(duration)) throw new Error(`无法读取媒体时长: ${filePath}`);
  return duration;
};

const probeMedia = async (filePath: string): Promise<unknown> => {
  const {stdout} = await execFileAsync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration,size:stream=index,codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels,nb_frames",
    "-of", "json",
    filePath,
  ]);
  return JSON.parse(stdout);
};

const assertVideoFrameCount = async (filePath: string, expectedFrames: number, expectedDuration: number) => {
  const {stdout} = await execFileAsync("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=nb_frames,duration,r_frame_rate",
    "-of", "json",
    filePath,
  ]);
  const stream = JSON.parse(stdout).streams?.[0];
  const frames = Number(stream?.nb_frames);
  const duration = Number(stream?.duration);
  if (frames !== expectedFrames || Math.abs(duration - expectedDuration) > 0.001) {
    throw new Error(
      `MG 合成时长校验失败: frames=${frames}/${expectedFrames}, ` +
      `duration=${duration}/${expectedDuration}`,
    );
  }
};

const subtitleSegmenter = new Intl.Segmenter("zh-CN", {granularity: "word"});
const protectedSubtitlePattern =
  /云端模型生态|AI基础设施公司|第二次创业|资本开支|搜索广告|搜索结果|现金来源|第二引擎|数据中心|基础设施|广告展示|核心业务|大模型|基本盘|主线|云端/gu;

const subtitleVisualWidth = (text: string): number =>
  [...text].reduce((total, character) => total + (/^[\x00-\x7f]$/.test(character) ? 0.56 : 1), 0);

const subtitleTokens = (text: string): string[] => {
  const segmented: string[] = [];
  let cursor = 0;
  for (const match of text.matchAll(protectedSubtitlePattern)) {
    const index = match.index ?? cursor;
    if (index > cursor) {
      segmented.push(...[...subtitleSegmenter.segment(text.slice(cursor, index))].map(({segment}) => segment));
    }
    segmented.push(match[0]);
    cursor = index + match[0].length;
  }
  if (cursor < text.length) {
    segmented.push(...[...subtitleSegmenter.segment(text.slice(cursor))].map(({segment}) => segment));
  }
  const tokens: string[] = [];
  for (const segment of segmented) {
    const previous = tokens.at(-1);
    const joinsNumericUnit = previous &&
      /[0-9亿万]$/u.test(previous) && /^(?:年|月|日|亿|万|美元|元|%)$/u.test(segment);
    const joinsAcronymTerm = previous &&
      /^[A-Z]{2,6}$/u.test(previous) && /^(?:产品|模型|技术|公司|时代|系统|芯片|平台|能力|基础设施)$/u.test(segment);
    if (previous && (joinsNumericUnit || joinsAcronymTerm)) {
      tokens[tokens.length - 1] = previous + segment;
    } else {
      tokens.push(segment);
    }
  }
  return tokens;
};

const wrapSubtitleText = (source: string, maxLineWidth = 18): string => {
  const originalBreak = source.indexOf("\\N");
  const targetWidth = originalBreak >= 0
    ? subtitleVisualWidth(source.slice(0, originalBreak))
    : subtitleVisualWidth(source.replace(/\\N/g, "")) / 2;
  const text = source.replace(/\\N/g, "").trim();
  if (subtitleVisualWidth(text) <= maxLineWidth) return text;

  const tokens = subtitleTokens(text);
  if (tokens.length < 2) return text;

  let bestIndex = 1;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let index = 1; index < tokens.length; index++) {
    const left = tokens.slice(0, index).join("");
    const right = tokens.slice(index).join("");
    const leftWidth = subtitleVisualWidth(left);
    const rightWidth = subtitleVisualWidth(right);
    const overflow = Math.max(0, leftWidth - maxLineWidth) + Math.max(0, rightWidth - maxLineWidth);
    let score = overflow * 100 + Math.abs(leftWidth - targetWidth) * 2 + Math.abs(leftWidth - rightWidth) * 0.1;
    if (/^[，。；：！？、,.!?;:）)】》]/u.test(right)) score += 100;
    if (/[（(【《]$/u.test(left)) score += 100;
    if (/[，；：、,;:]$/u.test(left)) score -= 1.5;
    if (score < bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }

  return `${tokens.slice(0, bestIndex).join("")}\\N${tokens.slice(bestIndex).join("")}`;
};

const createOptimizedSubtitles = async (): Promise<void> => {
  const source = await fs.readFile(SUBTITLES_ASS, "utf-8");
  const lines = source.split(/\r?\n/).map((line) => {
    if (!line.startsWith("Dialogue:")) return line;
    let commaCount = 0;
    let textStart = -1;
    for (let index = 0; index < line.length; index++) {
      if (line[index] !== ",") continue;
      commaCount++;
      if (commaCount === 9) {
        textStart = index + 1;
        break;
      }
    }
    if (textStart < 0) return line;
    return `${line.slice(0, textStart)}${wrapSubtitleText(line.slice(textStart))}`;
  });
  await fs.writeFile(OPTIMIZED_SUBTITLES_ASS, `${lines.join("\n")}\n`, "utf-8");
};

const loadAudioGroups = async (): Promise<AudioGroup[]> => {
  const storyboardFiles = (await fs.readdir(STORYBOARDS_DIR))
    .filter((name) => name.startsWith("storyboard_") && name.endsWith(".jsonl"))
    .sort();
  const groups: AudioGroup[] = [];
  let sourceOrder = 0;

  for (const fileName of storyboardFiles) {
    const sceneName = fileName.slice("storyboard_".length, -".jsonl".length);
    const lines = (await fs.readFile(path.join(STORYBOARDS_DIR, fileName), "utf-8"))
      .split(/\r?\n/)
      .filter((line) => line.trim());
    for (let index = 0; index < lines.length; index++) {
      const group = JSON.parse(lines[index]) as {global_order?: number};
      const audioPath = path.join(
        EP_DIR,
        `render_${sceneName}`,
        `g${String(index).padStart(2, "0")}_tts.mp3`,
      );
      if (!fsSync.existsSync(audioPath)) throw new Error(`找不到旁白片段: ${audioPath}`);
      groups.push({
        globalOrder: Number(group.global_order ?? 999),
        sourceOrder: sourceOrder++,
        audioPath,
      });
    }
  }

  return groups.sort((left, right) =>
    left.globalOrder - right.globalOrder || left.sourceOrder - right.sourceOrder,
  );
};

const createMgVideo = async (plan: Plan): Promise<void> => {
  const scenes = [...plan.scenes].sort((left, right) => left.startFrame - right.startFrame);
  let previousEnd = 0;
  for (const scene of scenes) {
    if (scene.startFrame < previousEnd) throw new Error(`MG 场景发生重叠: ${scene.id}`);
    if (scene.endFrame - scene.startFrame !== scene.durationFrames) {
      throw new Error(`MG 场景帧数不一致: ${scene.id}`);
    }
    const clipPath = path.join(PILOT_DIR, scene.clipFile);
    if (!fsSync.existsSync(clipPath)) throw new Error(`找不到 MG 片段: ${scene.id}`);
    previousEnd = scene.endFrame;
  }

  const sequence: Array<{
    kind: "raw" | "mg";
    startFrame: number;
    endFrame: number;
    inputPath: string;
  }> = [];
  let cursor = 0;
  for (const scene of scenes) {
    if (scene.startFrame > cursor) {
      sequence.push({kind: "raw", startFrame: cursor, endFrame: scene.startFrame, inputPath: RAW_VIDEO});
    }
    sequence.push({
      kind: "mg",
      startFrame: 0,
      endFrame: scene.durationFrames,
      inputPath: path.join(PILOT_DIR, scene.clipFile),
    });
    cursor = scene.endFrame;
  }
  if (cursor < plan.source.durationFrames) {
    sequence.push({kind: "raw", startFrame: cursor, endFrame: plan.source.durationFrames, inputPath: RAW_VIDEO});
  }

  const normalizedDir = path.join(PILOT_DIR, "normalized");
  await fs.mkdir(normalizedDir, {recursive: true});
  const normalizedFiles: string[] = [];
  for (let index = 0; index < sequence.length; index++) {
    const segment = sequence[index];
    const outputPath = path.join(normalizedDir, `segment_${String(index).padStart(2, "0")}.mp4`);
    const frameCount = segment.endFrame - segment.startFrame;
    const commonFilter =
      `scale=${plan.source.width}:${plan.source.height}:in_range=auto:out_range=tv,` +
      "setsar=1,format=yuv420p";
    const filter = segment.kind === "raw"
      ? `trim=start=${(segment.startFrame / plan.source.fps).toFixed(6)}:` +
        `end=${(segment.endFrame / plan.source.fps).toFixed(6)},` +
        `setpts=PTS-${(segment.startFrame / plan.source.fps).toFixed(6)}/TB,${commonFilter}`
      : `trim=start_frame=0:end_frame=${frameCount},setpts=PTS-STARTPTS,${commonFilter}`;

    await run("ffmpeg", [
      "-y",
      "-i", segment.inputPath,
      "-vf", filter,
      "-frames:v", String(frameCount),
      "-r", String(plan.source.fps),
      "-an",
      "-c:v", "libx264",
      "-preset", "fast",
      "-crf", "18",
      "-pix_fmt", "yuv420p",
      "-color_range", "tv",
      "-colorspace", "bt709",
      "-color_primaries", "bt709",
      "-color_trc", "bt709",
      outputPath,
    ]);
    await assertVideoFrameCount(outputPath, frameCount, frameCount / plan.source.fps);
    normalizedFiles.push(outputPath);
    console.log(`[MG 合成] 标准化 ${index + 1}/${sequence.length}: ${frameCount} 帧`);
  }

  const concatList = path.join(normalizedDir, "concat.txt");
  await fs.writeFile(
    concatList,
    normalizedFiles.map((filePath) => `file '${filePath.replace(/\\/g, "/")}'`).join("\n"),
    "utf-8",
  );
  await run("ffmpeg", [
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", concatList,
    "-map", "0:v:0",
    "-an",
    "-c:v", "copy",
    RAW_MG_VIDEO,
  ]);
  await assertVideoFrameCount(RAW_MG_VIDEO, plan.source.durationFrames, plan.source.duration);
};

const createNarration = async (plan: Plan): Promise<{groupCount: number; concatDuration: number; speed: number}> => {
  const groups = await loadAudioGroups();
  const inputs: string[] = [];
  groups.forEach((group) => inputs.push("-i", group.audioPath));
  const concatInputs = groups.map((_, index) => `[${index}:a]`).join("");
  await run("ffmpeg", [
    "-y",
    ...inputs,
    "-filter_complex", `${concatInputs}concat=n=${groups.length}:v=0:a=1[outa]`,
    "-map", "[outa]",
    "-ac", "2",
    "-ar", "44100",
    "-c:a", "pcm_s16le",
    CONCAT_AUDIO,
  ]);

  const concatDuration = await probeDuration(CONCAT_AUDIO);
  const speed = concatDuration / plan.source.duration;
  if (speed < 0.7 || speed > 1.6) throw new Error(`旁白对齐倍速异常: ${speed}`);
  await run("ffmpeg", [
    "-y",
    "-i", CONCAT_AUDIO,
    "-af", `atempo=${speed.toFixed(8)},apad,atrim=0:${plan.source.duration.toFixed(3)}`,
    "-ac", "2",
    "-ar", "44100",
    "-c:a", "pcm_s16le",
    ALIGNED_AUDIO,
  ]);
  return {groupCount: groups.length, concatDuration, speed};
};

const createCompleteVideos = async (plan: Plan): Promise<void> => {
  await createOptimizedSubtitles();
  await run("ffmpeg", [
    "-y",
    "-i", RAW_MG_VIDEO,
    "-i", ALIGNED_AUDIO,
    "-vf", `subtitles=${path.basename(OPTIMIZED_SUBTITLES_ASS)}`,
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-t", plan.source.duration.toFixed(3),
    "-c:v", "libx264",
    "-preset", "fast",
    "-crf", "18",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "192k",
    COMPLETE_VIDEO,
  ], PILOT_DIR);

  const speedArgs = [
    SPEED_SCRIPT,
    COMPLETE_VIDEO,
    "--speed", "1.2",
    "--output", NEXT_FINAL_VIDEO,
  ];
  if (fsSync.existsSync(BGM_PATH)) speedArgs.push("--bgm", BGM_PATH);
  if (fsSync.existsSync(NEXT_FINAL_VIDEO)) await fs.unlink(NEXT_FINAL_VIDEO);
  await run("python", speedArgs);
  await fs.copyFile(NEXT_FINAL_VIDEO, FINAL_VIDEO);
  await fs.unlink(NEXT_FINAL_VIDEO);
};

const main = async () => {
  if (process.argv.includes("--subtitles-only")) {
    await fs.mkdir(PILOT_DIR, {recursive: true});
    await createOptimizedSubtitles();
    console.log(`[完成] ${OPTIMIZED_SUBTITLES_ASS}`);
    return;
  }
  const plan = JSON.parse(await fs.readFile(PLAN_PATH, "utf-8")) as Plan;
  const finalizeOnly = process.argv.includes("--finalize-only");
  const hashBefore = await sha256(RAW_VIDEO);
  if (hashBefore !== plan.source.sha256) {
    throw new Error("ep01_raw.mp4 的哈希与生成 MG 计划时不一致，已停止合成");
  }

  if (finalizeOnly) {
    if (!fsSync.existsSync(RAW_MG_VIDEO)) throw new Error(`找不到已合成的 MG 视频: ${RAW_MG_VIDEO}`);
    await assertVideoFrameCount(RAW_MG_VIDEO, plan.source.durationFrames, plan.source.duration);
    console.log(`[MG 合成] 复用已校验的 ${plan.source.durationFrames} 帧 MG 视频...`);
  } else {
    console.log(`[MG 合成] 按帧插入 ${plan.scenes.length} 个 MG 片段...`);
    await createMgVideo(plan);
  }
  console.log("[音轨] 按 global_order 重建并对齐旁白...");
  const narration = await createNarration(plan);
  console.log("[字幕/音轨] 烧录字幕并生成完整观看版...");
  await createCompleteVideos(plan);

  const hashAfter = await sha256(RAW_VIDEO);
  if (hashAfter !== hashBefore) throw new Error("ep01_raw.mp4 在合成期间发生变化");

  const validation = {
    rawVideoUntouched: true,
    rawVideoSha256Before: hashBefore,
    rawVideoSha256After: hashAfter,
    functionCallCount: plan.functionCalls?.length ?? 0,
    sceneCount: plan.scenes.length,
    narration,
    outputs: {
      rawMg: await probeMedia(RAW_MG_VIDEO),
      complete: await probeMedia(COMPLETE_VIDEO),
      final: await probeMedia(FINAL_VIDEO),
    },
  };
  await fs.writeFile(VALIDATION_PATH, `${JSON.stringify(validation, null, 2)}\n`, "utf-8");
  console.log(`[完成] ${COMPLETE_VIDEO}`);
  console.log(`[完成] ${FINAL_VIDEO}`);
  console.log(`[校验] 原片 SHA-256 保持不变: ${hashAfter}`);
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
