import assert from "node:assert/strict";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import {flattenGpuApiParams, signGpuApiParams} from "../utils/gpu-lifecycle.js";
import {generateImage, validateGeneratedImage} from "../utils/image-gen.js";
import {FFMPEG_PATH, FFPROBE_PATH} from "../utils/media-binaries.js";
import {removeSolidBackground} from "../utils/remove-solid-background.js";
import {cutoutDominantColor, overlayTitleWatermark} from "../utils/title-watermark.js";
import {buildAtempoChain, speedVideoWithBgm} from "../utils/video-speed.js";
import {runMediaCommand} from "../runner/mg/media.js";

test("generated-image validation rejects blank images and accepts real variation", async () => {
  const blank = await sharp({create: {width: 32, height: 32, channels: 4, background: "white"}}).png().toBuffer();
  await assert.rejects(() => validateGeneratedImage(blank), /blank/);

  const pixels = Buffer.alloc(32 * 32 * 4);
  for (let y = 0; y < 32; y += 1) {
    for (let x = 0; x < 32; x += 1) {
      const offset = (y * 32 + x) * 4;
      pixels[offset] = x * 8;
      pixels[offset + 1] = y * 8;
      pixels[offset + 2] = (x + y) * 4;
      pixels[offset + 3] = 255;
    }
  }
  const varied = await sharp(pixels, {raw: {width: 32, height: 32, channels: 4}}).png().toBuffer();
  await validateGeneratedImage(varied);
});

test("TypeScript Vertex adapter sends text and reference-image requests without Python", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "story-claw-image-api-"));
  const originalConfigDirectory = process.env.STORY_CLAW_CONFIG_DIR;
  const requests: Array<{url: string; body: string}> = [];
  const pixels = Buffer.alloc(32 * 32 * 4);
  for (let pixel = 0; pixel < 32 * 32; pixel += 1) {
    pixels[pixel * 4] = pixel % 251;
    pixels[pixel * 4 + 1] = (pixel * 3) % 251;
    pixels[pixel * 4 + 2] = (pixel * 7) % 251;
    pixels[pixel * 4 + 3] = 255;
  }
  const generatedPng = await sharp(pixels, {raw: {width: 32, height: 32, channels: 4}}).png().toBuffer();
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      requests.push({url: request.url || "", body: Buffer.concat(chunks).toString("utf8")});
      response.writeHead(200, {"content-type": "application/json"});
      response.end(JSON.stringify({predictions: [{bytesBase64Encoded: generatedPng.toString("base64"), mimeType: "image/png"}]}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("mock image server did not bind a TCP port");
    process.env.STORY_CLAW_CONFIG_DIR = directory;
    await fs.writeFile(path.join(directory, "image_gen_config.json"), JSON.stringify({
      api_key: "test-key",
      model: "test-image-model",
      base_url: `http://127.0.0.1:${address.port}`,
      api_format: "vertex",
      timeout_ms: 5000,
    }));
    const reference = path.join(directory, "reference.png");
    await fs.writeFile(reference, generatedPng);
    await generateImage("text request", path.join(directory, "text.png"), [], "16:9");
    await generateImage("edit request", path.join(directory, "edit.png"), [reference], "16:9");
    assert.equal(requests.length, 2);
    assert.match(requests[0].url, /test-image-model:predict/);
    assert.match(requests[0].body, /text request/);
    assert.match(requests[1].body, /edit request/);
    assert.match(requests[1].body, /bytesBase64Encoded/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (originalConfigDirectory === undefined) delete process.env.STORY_CLAW_CONFIG_DIR;
    else process.env.STORY_CLAW_CONFIG_DIR = originalConfigDirectory;
    await fs.rm(directory, {recursive: true, force: true});
  }
});

test("OpenAI-compatible image adapter sends provider extensions as top-level fields", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "story-claw-openai-image-"));
  const originalConfigDirectory = process.env.STORY_CLAW_CONFIG_DIR;
  const requests: Array<{url: string; contentType: string; body: string}> = [];
  const pixels = Buffer.alloc(24 * 24 * 4);
  for (let pixel = 0; pixel < 24 * 24; pixel += 1) {
    pixels[pixel * 4] = (pixel * 11) % 251;
    pixels[pixel * 4 + 1] = (pixel * 5) % 251;
    pixels[pixel * 4 + 2] = (pixel * 2) % 251;
    pixels[pixel * 4 + 3] = 255;
  }
  const generatedPng = await sharp(pixels, {raw: {width: 24, height: 24, channels: 4}}).png().toBuffer();
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      requests.push({
        url: request.url || "",
        contentType: String(request.headers["content-type"] || ""),
        body: Buffer.concat(chunks).toString("utf8"),
      });
      response.writeHead(200, {"content-type": "application/json"});
      response.end(JSON.stringify({data: [{b64_json: generatedPng.toString("base64")}]}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("mock OpenAI image server did not bind a TCP port");
    process.env.STORY_CLAW_CONFIG_DIR = directory;
    await fs.writeFile(path.join(directory, "image_gen_config.json"), JSON.stringify({
      api_key: "test-key",
      model: "test-image-model",
      base_url: `http://127.0.0.1:${address.port}/v1`,
      api_format: "openai",
      timeout_ms: 5000,
    }));
    const reference = path.join(directory, "reference.png");
    await fs.writeFile(reference, generatedPng);
    await generateImage("openai text", path.join(directory, "openai-text.png"), [], "9:16");
    await generateImage("openai edit", path.join(directory, "openai-edit.png"), [reference], "9:16");
    assert.equal(requests.length, 2);
    assert.equal(requests[0].url, "/v1/images/generations");
    const generationBody = JSON.parse(requests[0].body) as Record<string, unknown>;
    assert.equal(generationBody.image_size, "1k");
    assert.equal(generationBody.aspect_ratio, "9:16");
    assert.equal(generationBody.extra_body, undefined);
    assert.equal(requests[1].url, "/v1/images/edits");
    assert.match(requests[1].contentType, /multipart\/form-data/);
    assert.match(requests[1].body, /name="image_size"[\s\S]*1k/);
    assert.match(requests[1].body, /name="aspect_ratio"[\s\S]*9:16/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (originalConfigDirectory === undefined) delete process.env.STORY_CLAW_CONFIG_DIR;
    else process.env.STORY_CLAW_CONFIG_DIR = originalConfigDirectory;
    await fs.rm(directory, {recursive: true, force: true});
  }
});

test("sharp background removers preserve foreground and create transparency", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "story-claw-cutout-"));
  try {
    const greenInput = path.join(directory, "green.png");
    const greenOutput = path.join(directory, "green-cutout.png");
    await sharp({create: {width: 64, height: 64, channels: 4, background: "#00ff00"}})
      .composite([{input: Buffer.from(`<svg width="24" height="24"><rect width="24" height="24" fill="#e02020"/></svg>`), left: 20, top: 20}])
      .png().toFile(greenInput);
    await removeSolidBackground(greenInput, greenOutput);
    const green = await sharp(greenOutput).ensureAlpha().raw().toBuffer();
    assert.ok(green[3] < 16, "green border should be transparent");
    assert.ok(green[((32 * 64 + 32) * 4) + 3] > 240, "red foreground should remain opaque");

    const titleInput = path.join(directory, "title.png");
    const titleOutput = path.join(directory, "title-cutout.png");
    await sharp({create: {width: 160, height: 90, channels: 3, background: "#202040"}})
      .composite([{input: Buffer.from(`<svg width="80" height="28"><rect width="80" height="28" fill="#f0d040"/></svg>`), left: 40, top: 31}])
      .png().toFile(titleInput);
    await cutoutDominantColor(titleInput, titleOutput);
    const metadata = await sharp(titleOutput).metadata();
    assert.ok((metadata.width || 0) < 130 && (metadata.height || 0) < 70, "dominant background should be cropped away");
    assert.equal(metadata.hasAlpha, true);
  } finally {
    await fs.rm(directory, {recursive: true, force: true});
  }
});

test("CompShare parameter flattening and SHA1 signing are deterministic", () => {
  const flattened = flattenGpuApiParams({
    Action: "Describe",
    UHostIds: ["a", "b"],
    Flag: true,
    Nested: {Value: 2},
    Ignored: null,
    PublicKey: "pub",
  });
  assert.deepEqual(flattened, {
    Action: "Describe",
    "UHostIds.0": "a",
    "UHostIds.1": "b",
    Flag: "true",
    "Nested.Value": "2",
    PublicKey: "pub",
  });
  assert.equal(signGpuApiParams(flattened, "secret"), "ccde048f6f45b1f62cdd047ccb49caa7a6a89dca");
});

test("bundled media binaries are available and atempo handles wide speed ranges", () => {
  assert.equal(fsSync.existsSync(FFMPEG_PATH), true, FFMPEG_PATH);
  assert.equal(fsSync.existsSync(FFPROBE_PATH), true, FFPROBE_PATH);
  assert.equal(buildAtempoChain(4), "atempo=2.000000000,atempo=2.000000000");
  assert.equal(buildAtempoChain(0.25), "atempo=0.500000000,atempo=0.500000000");
});

test("TypeScript speed/BGM pipeline preserves video packets", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "story-claw-speed-test-"));
  const source = path.join(directory, "source.mp4");
  const bgm = path.join(directory, "bgm.wav");
  const output = path.join(directory, "output.mp4");
  try {
    await runMediaCommand("ffmpeg", [
      "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=c=blue:s=320x180:r=10:d=2",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=2",
      "-map", "0:v:0", "-map", "1:a:0", "-frames:v", "20",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source,
    ]);
    await runMediaCommand("ffmpeg", [
      "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=44100:duration=1",
      "-c:a", "pcm_s16le", bgm,
    ]);
    await speedVideoWithBgm({input: source, output, speed: 2, bgm, fadeOutSeconds: 0.2});
    const probePath = path.join(directory, "probe.json");
    void probePath;
    const {execFile} = await import("node:child_process");
    const probeResult = await new Promise<string>((resolve, reject) => execFile(FFPROBE_PATH, [
      "-v", "error", "-count_packets", "-show_entries", "stream=codec_type,nb_read_packets,duration", "-of", "json", output,
    ], (error, stdout) => error ? reject(error) : resolve(String(stdout))));
    const streams = (JSON.parse(probeResult) as {streams: Array<{codec_type: string; nb_read_packets?: string; duration?: string}>}).streams;
    const video = streams.find((stream) => stream.codec_type === "video");
    const audio = streams.find((stream) => stream.codec_type === "audio");
    assert.equal(Number(video?.nb_read_packets), 20);
    assert.ok(Number(video?.duration) > 0.9 && Number(video?.duration) < 1.2);
    assert.ok(audio, "output should contain mixed audio");

    const overlay = path.join(directory, "overlay.png");
    await sharp({create: {width: 100, height: 40, channels: 4, background: {r: 0, g: 0, b: 0, alpha: 0}}})
      .composite([{input: Buffer.from(`<svg width="80" height="24"><rect width="80" height="24" rx="4" fill="#f0d040"/></svg>`), left: 10, top: 8}])
      .png().toFile(overlay);
    await overlayTitleWatermark(output, overlay, 1.1);
    const stat = await fs.stat(output);
    assert.ok(stat.size > 0, "title/watermark pass should replace the output with a playable file");
  } finally {
    await fs.rm(directory, {recursive: true, force: true});
  }
});
