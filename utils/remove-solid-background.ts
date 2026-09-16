import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const parseColor = (value: string): [number, number, number] => {
  const normalized = value.trim().replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/i.test(normalized)) throw new Error("background color must be #RRGGBB");
  return [0, 2, 4].map((index) => Number.parseInt(normalized.slice(index, index + 2), 16)) as [number, number, number];
};

const distance = (r: number, g: number, b: number, key: [number, number, number]): number =>
  Math.sqrt((r - key[0]) ** 2 + (g - key[1]) ** 2 + (b - key[2]) ** 2);

export const removeSolidBackground = async (
  inputPath: string,
  outputPath: string,
  backgroundColor = "#00ff00",
): Promise<string> => {
  const {data, info} = await sharp(inputPath).ensureAlpha().raw().toBuffer({resolveWithObject: true});
  const {width, height, channels} = info;
  if (width < 2 || height < 2 || channels < 4) throw new Error("image is too small or has no alpha channel");
  const key = parseColor(backgroundColor);
  const count = width * height;
  const flood = new Uint8Array(count);
  const queue = new Uint32Array(count);
  let head = 0;
  let tail = 0;

  const add = (pixel: number): void => {
    if (flood[pixel]) return;
    const offset = pixel * channels;
    if (data[offset + 3] === 0 || distance(data[offset], data[offset + 1], data[offset + 2], key) <= 205) {
      flood[pixel] = 1;
      queue[tail++] = pixel;
    }
  };
  for (let x = 0; x < width; x += 1) { add(x); add((height - 1) * width + x); }
  for (let y = 0; y < height; y += 1) { add(y * width); add(y * width + width - 1); }
  while (head < tail) {
    const pixel = queue[head++];
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    if (x > 0) add(pixel - 1);
    if (x + 1 < width) add(pixel + 1);
    if (y > 0) add(pixel - width);
    if (y + 1 < height) add(pixel + width);
  }

  const hard = 110;
  const feather = 68;
  let visible = 0;
  let transparentBorder = 0;
  let borderCount = 0;
  for (let pixel = 0; pixel < count; pixel += 1) {
    const offset = pixel * channels;
    const [r, g, b] = [data[offset], data[offset + 1], data[offset + 2]];
    const delta = distance(r, g, b, key);
    let alpha = data[offset + 3];
    if (flood[pixel]) {
      if (delta <= hard) alpha = 0;
      else if (delta < hard + feather) alpha = Math.round(alpha * (delta - hard) / feather);
      if (alpha && delta < hard + feather * 1.8) data[offset + 1] = Math.min(g, Math.min(255, Math.round((r + b) / 2 + 30)));
    }
    data[offset + 3] = Math.max(0, Math.min(255, alpha));
    if (alpha >= 16) visible += 1;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    if (x === 0 || x === width - 1 || y === 0 || y === height - 1) {
      borderCount += 1;
      if (alpha < 16) transparentBorder += 1;
    }
  }
  if (visible < Math.max(1, Math.floor(count * 0.01))) throw new Error("cutout is almost fully transparent");
  if (transparentBorder / borderCount < 0.55) {
    throw new Error(`cutout border is not transparent enough (${((transparentBorder / borderCount) * 100).toFixed(2)}%)`);
  }

  await fs.mkdir(path.dirname(outputPath), {recursive: true});
  const temporary = `${outputPath}.${process.pid}.${Date.now().toString(36)}.tmp.png`;
  try {
    await sharp(data, {raw: {width, height, channels}}).png().toFile(temporary);
    await fs.rm(outputPath, {force: true});
    await fs.rename(temporary, outputPath);
    return outputPath;
  } finally {
    await fs.rm(temporary, {force: true});
  }
};
