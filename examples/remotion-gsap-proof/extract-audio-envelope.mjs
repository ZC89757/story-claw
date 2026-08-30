import {spawnSync} from "node:child_process";
import {writeFileSync} from "node:fs";

const [source, destination] = process.argv.slice(2);

if (!source || !destination) {
  throw new Error("Usage: node extract-audio-envelope.mjs <audio> <output-json>");
}

const sampleRate = 24000;
const fps = 60;
const decoded = spawnSync(
  "ffmpeg",
  ["-v", "error", "-i", source, "-f", "s16le", "-ac", "1", "-ar", String(sampleRate), "pipe:1"],
  {encoding: null, maxBuffer: 32 * 1024 * 1024},
);

if (decoded.status !== 0 || !decoded.stdout) {
  throw new Error(decoded.stderr?.toString() || "ffmpeg audio decode failed");
}

const pcm = new Int16Array(
  decoded.stdout.buffer,
  decoded.stdout.byteOffset,
  Math.floor(decoded.stdout.byteLength / 2),
);
const samplesPerFrame = sampleRate / fps;
const raw = [];

for (let offset = 0; offset < pcm.length; offset += samplesPerFrame) {
  const end = Math.min(pcm.length, offset + samplesPerFrame);
  let sumSquares = 0;
  let peak = 0;
  for (let index = offset; index < end; index++) {
    const value = Math.abs(pcm[index] / 32768);
    sumSquares += value * value;
    peak = Math.max(peak, value);
  }
  raw.push({rms: Math.sqrt(sumSquares / Math.max(1, end - offset)), peak});
}

const sortedRms = raw.map(({rms}) => rms).sort((a, b) => a - b);
const normalization = sortedRms[Math.floor(sortedRms.length * 0.94)] || 1;
const frames = raw.map((entry, index) => {
  let weightedRms = 0;
  let weights = 0;
  for (let neighbor = -2; neighbor <= 2; neighbor++) {
    const candidate = raw[index + neighbor];
    if (!candidate) continue;
    const weight = 3 - Math.abs(neighbor);
    weightedRms += candidate.rms * weight;
    weights += weight;
  }
  return {
    rms: Number(Math.min(1, weightedRms / weights / normalization).toFixed(4)),
    peak: Number(Math.min(1, entry.peak / Math.max(normalization * 2.4, 0.001)).toFixed(4)),
  };
});

writeFileSync(
  destination,
  `${JSON.stringify({fps, sampleRate, duration: pcm.length / sampleRate, frames})}\n`,
  "utf8",
);
