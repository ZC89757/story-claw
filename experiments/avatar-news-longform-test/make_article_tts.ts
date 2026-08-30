import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { ttsExecApi, ttsPhase4Concat } from "../../runner/render.ts";

const execFileAsync = promisify(execFile);

const [sourcePath, outputDir] = process.argv.slice(2);
if (!sourcePath || !outputDir) {
  throw new Error("Usage: tsx make_article_tts.ts SOURCE_TEXT OUTPUT_DIR");
}

const MAX_CHARS_PER_REQUEST = 180;
const VOICE = "zh_female_gaolengyujie_moon_bigtts";

function splitForTts(text: string): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  const sentences = normalized.match(/[^。！？；]+[。！？；]?/gu) ?? [normalized];
  const chunks: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    if (current && current.length + sentence.length > MAX_CHARS_PER_REQUEST) {
      chunks.push(current);
      current = "";
    }
    if (sentence.length <= MAX_CHARS_PER_REQUEST) {
      current += sentence;
      continue;
    }
    for (let offset = 0; offset < sentence.length; offset += MAX_CHARS_PER_REQUEST) {
      const part = sentence.slice(offset, offset + MAX_CHARS_PER_REQUEST);
      if (current) {
        chunks.push(current);
        current = "";
      }
      chunks.push(part);
    }
  }
  if (current) chunks.push(current);
  return chunks.filter(Boolean);
}

async function mediaDuration(pathname: string): Promise<number> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", pathname,
  ]);
  const duration = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Could not read audio duration: ${pathname}`);
  }
  return duration;
}

async function main(): Promise<void> {
  const source = await fs.readFile(sourcePath, "utf8");
  const chunks = splitForTts(source);
  if (!chunks.length) throw new Error("The source text has no speakable content.");

  const runDir = path.resolve(outputDir);
  const partsDir = path.join(runDir, "tts_parts");
  await fs.mkdir(partsDir, { recursive: true });
  const started = performance.now();
  const partFiles: string[] = [];

  for (let index = 0; index < chunks.length; index++) {
    const partPath = path.join(partsDir, `part_${String(index).padStart(3, "0")}.mp3`);
    console.log(`[tts] ${index + 1}/${chunks.length}`);
    await ttsExecApi(chunks[index], VOICE, "专业、沉稳的财经新闻播报", partPath);
    partFiles.push(partPath);
  }

  const mp3Path = path.join(runDir, "article.mp3");
  const wavPath = path.join(runDir, "article.wav");
  await ttsPhase4Concat(partFiles, mp3Path);
  await execFileAsync("ffmpeg", ["-y", "-i", mp3Path, "-ar", "16000", "-ac", "1", wavPath]);

  const durationSec = await mediaDuration(wavPath);
  const manifest = {
    source_path: path.resolve(sourcePath),
    source_sha256: createHash("sha256").update(source).digest("hex"),
    voice: VOICE,
    chunk_count: chunks.length,
    tts_duration_sec: durationSec,
    tts_elapsed_sec: (performance.now() - started) / 1000,
  };
  await fs.writeFile(path.join(runDir, "tts_manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify(manifest));
}

await main();
