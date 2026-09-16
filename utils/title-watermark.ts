import {execFile} from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import {promisify} from "node:util";
import OpenAI from "openai";
import sharp from "sharp";
import {CONFIG_DIR} from "./runtime-paths.js";
import {generateImage} from "./image-gen.js";
import {FFMPEG_PATH, FFPROBE_PATH} from "./media-binaries.js";
import {fetchWithEnvironmentProxy} from "./proxy-fetch.js";
import {buildAtempoChain} from "./video-speed.js";

const execFileAsync = promisify(execFile);
const DESIGN_MODEL = "anthropic/claude-sonnet-5";
const DESIGN_RETRIES = 3;
const DESIGN_RETRY_DELAY_MS = 5000;
const BG_QUANTIZE_STEP = 8;
const CUTOUT_T1 = 30;
const CUTOUT_T2 = 70;
const CROP_ALPHA_THRESHOLD = 150;
const CROP_PADDING = 8;
const OVERLAY_WIDTH_RATIO = 0.32;
const MARGIN_RATIO = 0.03;
const ID_WATERMARK_SLOT_SECONDS = 10;
const CREDIT_TEXT = "所有内容由story-claw一键生成。";
const CREDIT_FONT_RATIO = 0.03;
const CREDIT_MARGIN_RATIO = 0.02;

const DESIGN_PROMPT_TEMPLATE = `以下是一篇小说原文全文。请根据其题材和氛围，为短剧标题卡设计一套具体的文字视觉方案，用一段中文描述（不超过100字）说明：字体风格（如手写体/黑体/衬线体/书法体等）、文字颜色（必须与背景色不同，不能选跟背景相近或相同的颜色）、文字边缘或描边效果（如是否有描边、光晕、破损、金属质感、阴影等）、整体氛围基调。只输出这段描述本身，不要解释、不要分点、不要输出与设计无关的内容：`;

const imagePrompt = (title: string, design: string): string =>
  `电影感短剧标题卡设计。${design ? `文字设计要求：${design} ` : ""}` +
  `纯色背景（整张画布背景为单一纯色，无渐变、无纹理、无阴影、无装饰图案），` +
  `画面正中是标题文字："${title}"，文字颜色必须与背景颜色不同，不允许文字颜色与背景颜色相近或相同，` +
  "除标题文字外画面中不得出现任何其他文字、图案、logo、水印、边框或装饰元素，横版构图";

const sleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

const readText = async (filePath: string): Promise<string> => {
  const bytes = await fs.readFile(filePath);
  for (const encoding of ["utf-8", "gbk"] as const) {
    try {
      return new TextDecoder(encoding, {fatal: true}).decode(bytes).trim();
    } catch { /* Try the next common source encoding. */ }
  }
  return bytes.toString("utf8").trim();
};

const inferTitleDesign = async (textPath: string): Promise<string> => {
  const content = await readText(textPath);
  if (!content) return "";
  const config = JSON.parse(await fs.readFile(path.join(CONFIG_DIR, "config.json"), "utf8")) as Record<string, any>;
  const client = new OpenAI({
    apiKey: config.api_key,
    baseURL: config.base_url || "https://api.openai.com/v1",
    timeout: 240_000,
    maxRetries: 0,
    fetch: fetchWithEnvironmentProxy,
  });
  let lastError: unknown;
  for (let attempt = 1; attempt <= DESIGN_RETRIES; attempt += 1) {
    try {
      const response = await client.chat.completions.create({
        model: config.title_design_model || DESIGN_MODEL,
        messages: [{role: "user", content: `${DESIGN_PROMPT_TEMPLATE}\n\n${content}`}],
      });
      return response.choices[0]?.message?.content?.trim() || "";
    } catch (error) {
      lastError = error;
      console.warn(`  [标题] 风格推测失败 ${attempt}/${DESIGN_RETRIES}: ${error instanceof Error ? error.message : String(error)}`);
      if (attempt < DESIGN_RETRIES) await sleep(DESIGN_RETRY_DELAY_MS);
    }
  }
  console.warn(`  [标题] 风格推测重试后仍失败，将使用基础提示词: ${String(lastError)}`);
  return "";
};

/** Remove the dominant flat background and crop to the visible title artwork. */
export const cutoutDominantColor = async (inputPath: string, outputPath: string): Promise<string> => {
  const {data, info} = await sharp(inputPath).removeAlpha().raw().toBuffer({resolveWithObject: true});
  const {width, height, channels} = info;
  if (channels < 3 || width < 1 || height < 1) throw new Error("标题图无有效 RGB 像素");
  const histogram = new Uint32Array(32 * 32 * 32);
  for (let offset = 0; offset < data.length; offset += channels) {
    histogram[(data[offset] >> 3) * 1024 + (data[offset + 1] >> 3) * 32 + (data[offset + 2] >> 3)] += 1;
  }
  let dominant = 0;
  for (let index = 1; index < histogram.length; index += 1) {
    if (histogram[index] > histogram[dominant]) dominant = index;
  }
  const background = [
    ((dominant >> 10) & 31) * BG_QUANTIZE_STEP,
    ((dominant >> 5) & 31) * BG_QUANTIZE_STEP,
    (dominant & 31) * BG_QUANTIZE_STEP,
  ];
  const alpha = Buffer.alloc(width * height);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const offset = pixel * channels;
    const distance = Math.sqrt(
      (data[offset] - background[0]) ** 2 +
      (data[offset + 1] - background[1]) ** 2 +
      (data[offset + 2] - background[2]) ** 2,
    );
    alpha[pixel] = distance >= CUTOUT_T2
      ? 255
      : distance > CUTOUT_T1
        ? Math.round((distance - CUTOUT_T1) / (CUTOUT_T2 - CUTOUT_T1) * 255)
        : 0;
  }
  const blurred = await sharp(alpha, {raw: {width, height, channels: 1}})
    .blur(1)
    .raw()
    .toBuffer({resolveWithObject: true});
  const rgba = Buffer.alloc(width * height * 4);
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const source = pixel * channels;
    const target = pixel * 4;
    rgba[target] = data[source];
    rgba[target + 1] = data[source + 1];
    rgba[target + 2] = data[source + 2];
    const alphaValue = blurred.data[pixel * blurred.info.channels];
    rgba[target + 3] = alphaValue;
    if (alphaValue > CROP_ALPHA_THRESHOLD) {
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  const image = sharp(rgba, {raw: {width, height, channels: 4}});
  if (maxX >= minX && maxY >= minY) {
    const left = Math.max(0, minX - CROP_PADDING);
    const top = Math.max(0, minY - CROP_PADDING);
    image.extract({
      left,
      top,
      width: Math.min(width, maxX + CROP_PADDING + 1) - left,
      height: Math.min(height, maxY + CROP_PADDING + 1) - top,
    });
  } else {
    console.warn("  [标题] 抠图后未检测到前景，保留整张图");
  }
  await fs.mkdir(path.dirname(outputPath), {recursive: true});
  await image.png().toFile(outputPath);
  return outputPath;
};

const summarizeMediaError = (error: any): string => {
  const detail = String(error?.stderr || error?.message || error);
  const lines = detail.trim().split(/\r?\n/);
  const relevant = lines.filter((line) => /error|failed|no space|permission denied/i.test(line));
  return (relevant.length ? relevant.slice(-10) : lines.slice(-20)).join("\n");
};

const probeVideo = async (videoPath: string): Promise<{width: number; height: number; hasAudio: boolean}> => {
  const {stdout} = await execFileAsync(FFPROBE_PATH, [
    "-v", "error", "-show_entries", "stream=codec_type,width,height", "-of", "json", videoPath,
  ], {maxBuffer: 4 * 1024 * 1024});
  const streams = (JSON.parse(stdout) as {streams?: Array<Record<string, unknown>>}).streams || [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const width = Number(video?.width);
  const height = Number(video?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height)) throw new Error(`无法读取视频尺寸: ${videoPath}`);
  return {width, height, hasAudio: streams.some((stream) => stream.codec_type === "audio")};
};

const fontCandidates = process.platform === "win32"
  ? ["C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/simhei.ttf", "C:/Windows/Fonts/simsun.ttc"]
  : [
      "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
      "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ];

const findFont = async (): Promise<string> => {
  for (const candidate of fontCandidates) {
    try { await fs.access(candidate); return candidate; } catch { /* Continue. */ }
  }
  throw new Error("未找到可用于视频水印的字体文件");
};

const escapeFilterPath = (value: string): string => value.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
const escapeFilterText = (value: string): string => value.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");

const creditReserveHeight = (width: number): number => {
  const margin = Math.max(6, Math.round(width * CREDIT_MARGIN_RATIO));
  return Math.max(10, Math.round(width * CREDIT_FONT_RATIO)) + margin * 2;
};

const idWatermarkFilters = (
  idText: string,
  width: number,
  inputLabel: string,
  outputLabel: string,
  font: string,
  titleBottom?: number,
): string[] => {
  const margin = Math.max(10, Math.round(width * 0.03));
  const size = Math.max(14, Math.round(width * 0.035));
  const positions = [
    [`${margin}`, `${titleBottom === undefined ? margin : titleBottom + margin}`],
    [`w-text_w-${margin}`, `${margin}`],
    [`${margin}`, `h-text_h-${margin}`],
    [`w-text_w-${margin}`, `h-text_h-${margin}-${creditReserveHeight(width)}`],
    ["(w-text_w)/2", "(h-text_h)/2"],
  ];
  return positions.map(([x, y], index) => {
    const source = index === 0 ? inputLabel : `idwm${index - 1}`;
    const target = index === positions.length - 1 ? outputLabel : `idwm${index}`;
    const start = index * ID_WATERMARK_SLOT_SECONDS;
    const end = (index + 1) * ID_WATERMARK_SLOT_SECONDS;
    return `[${source}]drawtext=fontfile='${escapeFilterPath(font)}':text='${escapeFilterText(idText)}':` +
      `expansion=none:fontsize=${size}:fontcolor=white@0.55:x=${x}:y=${y}:` +
      `enable='between(mod(t\\,${ID_WATERMARK_SLOT_SECONDS * positions.length})\\,${start}\\,${end})'[${target}]`;
  });
};

const replaceFile = async (source: string, destination: string): Promise<void> => {
  const backup = `${destination}.${process.pid}.${Date.now().toString(36)}.backup`;
  await fs.rename(destination, backup);
  try {
    await fs.rename(source, destination);
  } catch (error) {
    await fs.rename(backup, destination).catch(() => undefined);
    throw error;
  }
  await fs.rm(backup, {force: true}).catch((error) => {
    console.warn(`  [视频后处理] 已替换成片，但清理备份失败: ${error instanceof Error ? error.message : String(error)}`);
  });
};

export const overlayTitleWatermark = async (
  videoPath: string,
  cutoutPath: string | null,
  speed = 1.1,
  idText = "",
): Promise<void> => {
  if (!Number.isFinite(speed) || speed <= 0) throw new Error("视频倍速必须大于 0");
  const {width, height, hasAudio} = await probeVideo(videoPath);
  const temporaryDirectory = await fs.mkdtemp(path.join(path.dirname(videoPath), ".story-claw-title-"));
  const output = path.join(temporaryDirectory, "output.mp4");
  const inputs = ["-i", videoPath];
  const filters: string[] = [];
  let current = "0:v";
  let titleBottom: number | undefined;
  try {
    if (cutoutPath) {
      const metadata = await sharp(cutoutPath).metadata();
      if (!metadata.width || !metadata.height) throw new Error("标题抠图尺寸无效");
      const targetWidth = Math.max(1, Math.round(width * OVERLAY_WIDTH_RATIO));
      const targetHeight = Math.max(1, Math.round(metadata.height * targetWidth / metadata.width));
      const overlay = path.join(temporaryDirectory, "overlay.png");
      await sharp(cutoutPath).resize(targetWidth, targetHeight, {fit: "fill"}).png().toFile(overlay);
      inputs.push("-loop", "1", "-i", overlay);
      const marginX = Math.round(width * MARGIN_RATIO);
      const marginY = Math.round(height * MARGIN_RATIO);
      titleBottom = marginY + targetHeight;
      filters.push(`[0:v][1:v]overlay=x=${marginX}:y=${marginY}:shortest=1[titled]`);
      current = "titled";
    }

    const font = await findFont();
    if (idText) {
      filters.push(...idWatermarkFilters(idText, width, current, "idwm", font, titleBottom));
      current = "idwm";
    }
    const creditMargin = Math.max(6, Math.round(width * CREDIT_MARGIN_RATIO));
    const creditSize = Math.max(10, Math.round(width * CREDIT_FONT_RATIO));
    filters.push(
      `[${current}]drawtext=fontfile='${escapeFilterPath(font)}':text='${escapeFilterText(CREDIT_TEXT)}':` +
      `expansion=none:fontsize=${creditSize}:fontcolor=white:borderw=2:bordercolor=black:` +
      `x=w-text_w-${creditMargin}:y=h-text_h-${creditMargin}[credited]`,
    );
    current = "credited";
    if (speed !== 1) {
      filters.push(`[${current}]setpts=PTS/${speed.toFixed(6)}[sped]`);
      current = "sped";
    }

    const args = [
      "-y", ...inputs,
      "-filter_complex", filters.join(";"),
      "-map", `[${current}]`,
      ...(hasAudio ? ["-map", "0:a:0"] : []),
      "-c:v", "libx264", "-preset", "medium", "-crf", "14",
      ...(hasAudio
        ? speed === 1
          ? ["-c:a", "copy"]
          : ["-filter:a", buildAtempoChain(speed), "-c:a", "aac", "-b:a", "192k"]
        : ["-an"]),
      "-movflags", "+faststart",
      output,
    ];
    await execFileAsync(FFMPEG_PATH, args, {maxBuffer: 16 * 1024 * 1024});
    await replaceFile(output, videoPath);
  } catch (error) {
    throw new Error(`故事标题/水印处理失败: ${summarizeMediaError(error)}`);
  } finally {
    await fs.rm(temporaryDirectory, {recursive: true, force: true});
  }
};

export const createAndApplyStoryTitle = async (options: {
  episodeDirectory: string;
  videoPath: string;
  cleanTextPath: string;
  title: string;
  speed?: number;
  idText?: string;
}): Promise<{rawTitlePath: string; cutoutPath: string | null}> => {
  const rawTitlePath = path.join(options.episodeDirectory, "_title_raw.png");
  const cutoutPath = path.join(options.episodeDirectory, "_title_cutout.png");
  let usableCutout: string | null = null;
  try {
    console.log("  [标题] 正在推测标题视觉并生成标题图...");
    const design = await inferTitleDesign(options.cleanTextPath);
    await generateImage(imagePrompt(options.title, design), rawTitlePath, [], "16:9");
    await cutoutDominantColor(rawTitlePath, cutoutPath);
    usableCutout = cutoutPath;
  } catch (error) {
    console.warn(`  [标题] 标题图生成失败，将继续添加署名与倍速: ${error instanceof Error ? error.message : String(error)}`);
  }
  await overlayTitleWatermark(options.videoPath, usableCutout, options.speed ?? 1.1, options.idText || "");
  return {rawTitlePath, cutoutPath: usableCutout};
};
