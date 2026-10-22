import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import sharp from "sharp";
import {getStoryVideoConfig, bundledH3WorkflowPath, type StoryVideoConfig} from "../utils/story-video-config.js";
import {buildH3Workflow, checkH3RenderService, distributeH3PanelDurations, durationToH3Frames, generateH3Video, normalizeH3Video, validateH3Workflow, type H3ApiWorkflow} from "../utils/h3-video.js";
import {resolveMediaCommand} from "../utils/media-binaries.js";

const execFileAsync = promisify(execFile);
const readTemplate = async (): Promise<H3ApiWorkflow> => JSON.parse(await fs.readFile(bundledH3WorkflowPath(), "utf8"));
const withTemp = async (run: (directory: string) => Promise<void>): Promise<void> => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "story-claw-h3-"));
  try { await run(directory); } finally { await fs.rm(directory, {recursive: true, force: true}); }
};
const configFor = (): StoryVideoConfig => ({baseUrl: "http://comfy.test", workflowPath: bundledH3WorkflowPath(), maxDuration: 15, fps: 24, concurrency: 1, maxRetries: 1, pollIntervalMs: 1, timeoutMs: 10_000});
const workflowInput = () => ({references: ["person.png", "scene.png"], prompt: "<Picture 1> is the only actor. <Picture 2> supplies the scene.", aspectRatio: "9:16", duration: 5, seed: 123, filenamePrefix: "test"});

test("all generation uses H3 config and ignores legacy LTX settings", async () => withTemp(async (directory) => {
  const file = path.join(directory, "video_config.json");
  await fs.writeFile(file, JSON.stringify({base_url: "http://ltx.test:8191", workflow_path: path.join(directory, "ltx.json"), concurrency: 6, max_retries: 50, story_backend: "ltx"}));
  const original = await fs.readFile(file, "utf8");
  const defaults = getStoryVideoConfig(file);
  assert.equal(defaults.baseUrl, "http://127.0.0.1:8188");
  assert.equal(defaults.workflowPath, bundledH3WorkflowPath());
  assert.equal(defaults.concurrency, 1);
  assert.equal(defaults.maxRetries, 2);
  assert.equal((defaults as any).backend, undefined);
  assert.equal(await fs.readFile(file, "utf8"), original);
  await fs.writeFile(file, JSON.stringify({...JSON.parse(original), h3_base_url: "http://h3.test:8188", h3_max_duration: 14}));
  const h3 = getStoryVideoConfig(file);
  assert.equal(h3.baseUrl, "http://h3.test:8188");
  assert.equal(h3.workflowPath, bundledH3WorkflowPath());
  assert.equal(h3.maxDuration, 14);
  assert.equal(h3.fps, 24);
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).workflow_path, path.join(directory, "ltx.json"));
  await fs.writeFile(file, JSON.stringify({h3_max_duration: 18}));
  assert.throws(() => getStoryVideoConfig(file), /上限/);
  await fs.writeFile(file, JSON.stringify({h3_concurrency: 1.5}));
  assert.throws(() => getStoryVideoConfig(file), /整数/);
  await fs.writeFile(file, JSON.stringify({h3_base_url: "http://h3.test:8191"}));
  assert.throws(() => getStoryVideoConfig(file), /8191/);
  await fs.writeFile(file, JSON.stringify({h3_max_duration: 0.05}));
  assert.throws(() => getStoryVideoConfig(file), /上限/);
  await fs.writeFile(file, JSON.stringify({h3_timeout_ms: 1.5}));
  assert.throws(() => getStoryVideoConfig(file), /整数/);
}));

test("H3 native lengths stay on 17k+5 while final panel times share exact integer frames", () => {
  assert.equal(durationToH3Frames(2.88), 124);
  assert.equal(durationToH3Frames(5), 124);
  assert.equal(durationToH3Frames(15), 362);
  assert.equal((durationToH3Frames(8.7) - 5) % 17, 0);
  assert.throws(() => durationToH3Frames(18.6), /拆分/);
  assert.throws(() => durationToH3Frames(5, 4), /拆分/);
  assert.throws(() => durationToH3Frames(NaN), /大于零/);
  const durations = distributeH3PanelDurations(9.528, 2);
  assert.equal(durations.reduce((sum, duration) => sum + Math.round(duration * 24), 0), Math.round(9.528 * 24));
  assert.ok(Math.abs(durations[0] - durations[1]) <= 1 / 24 + 1e-8);
  assert.throws(() => distributeH3PanelDurations(0.01, 3), /不足/);
});

test("API graph preserves Picture order and replaces an old guide with a distinct frame-zero input", async () => {
  const template = await readTemplate();
  const original = structuredClone(template);
  const first = buildH3Workflow(template, {...workflowInput(), firstFrame: "old-tail.png"});
  const next = buildH3Workflow(first, {...workflowInput(), references: ["new-person.png", "new-scene.png"], firstFrame: "new-tail.png", seed: 456});
  assert.deepEqual(template, original);
  const ref = Object.values(next).find((node) => node.class_type === "MiniMaxH3ReferenceToVideo")!;
  const pictureOne = next[ref.inputs["ref_images.ref_image_0"][0]];
  const pictureTwo = next[ref.inputs["ref_images.ref_image_1"][0]];
  assert.equal(pictureOne.inputs.image, "new-person.png");
  assert.equal(pictureTwo.inputs.image, "new-scene.png");
  const guides = Object.values(next).filter((node) => node.class_type === "MiniMaxH3AddGuide");
  assert.equal(guides.length, 1);
  assert.equal(guides[0].inputs.frame_idx, 0);
  assert.equal(next[guides[0].inputs.image[0]].inputs.image, "new-tail.png");
  assert.ok(!JSON.stringify(next).includes("old-tail.png"));
  assert.equal(Object.values(next).find((node) => node.class_type === "RandomNoise")!.inputs.noise_seed, 456);
  const hardCut = buildH3Workflow(next, workflowInput());
  assert.equal(Object.values(hardCut).filter((node) => node.class_type === "MiniMaxH3AddGuide").length, 0);
  assert.throws(() => buildH3Workflow(template, {...workflowInput(), references: Array(10).fill("x.png")}), /1–9/);
  assert.throws(() => buildH3Workflow(template, {...workflowInput(), prompt: "<Picture 3>"}), /不存在/);
  assert.throws(() => validateH3Workflow({nodes: [], links: []}), /UI 工作流/);
});

test("official resolution and joint audio chain survive per-panel injection", async () => {
  const graph = buildH3Workflow(await readTemplate(), workflowInput());
  const ref = graph["4"].inputs;
  assert.deepEqual(ref.width, ["15", 0]);
  assert.deepEqual(ref.height, ["15", 1]);
  assert.equal(graph["15"].inputs.aspect_ratio, "9:16 (Portrait Widescreen)");
  assert.equal(graph["15"].inputs.megapixels, 0.4);
  assert.deepEqual(ref.audio_vae, ["13", 0]);
  assert.deepEqual(graph["14"].inputs.samples, graph["10"].inputs.samples);
  assert.deepEqual(graph["11"].inputs.audio, ["14", 0]);
  assert.equal(graph["12"].inputs.codec, "auto");
  const landscape = buildH3Workflow(graph, {...workflowInput(), aspectRatio: "16:9"});
  assert.equal(landscape["15"].inputs.aspect_ratio, "16:9 (Widescreen)");
});

test("service check catches a new required server input before queueing generation", async () => withTemp(async (directory) => {
  const graph = await readTemplate();
  delete graph["4"].inputs.audio_vae;
  const workflowPath = path.join(directory, "old-api.json");
  await fs.writeFile(workflowPath, JSON.stringify(graph));
  const info: Record<string, any> = {};
  for (const node of Object.values(graph)) info[node.class_type] = {input: {required: {}}};
  info.MiniMaxH3ReferenceToVideo.input.required.audio_vae = ["VAE", {}];
  info.LoadImage = {};
  info.MiniMaxH3AddGuide = {};
  const originalFetch = globalThis.fetch;
  // Supply model lists so the earlier loader nodes pass availability checks.
  for (const node of Object.values(graph)) {
    for (const key of ["unet_name", "clip_name", "vae_name"]) {
      if (node.inputs[key]) info[node.class_type].input.required[key] = [[...new Set([...(info[node.class_type].input.required[key]?.[0] ?? []), node.inputs[key]])]];
    }
  }
  globalThis.fetch = (async () => Response.json(info)) as typeof fetch;
  try {
    await assert.rejects(checkH3RenderService({...configFor(), workflowPath}), /必填输入: audio_vae/);
  } finally { globalThis.fetch = originalFetch; }
}));

test("read-only H3 service check verifies actual node/model options without submitting prompts", async () => {
  const graph = await readTemplate();
  const info: Record<string, any> = {};
  for (const node of Object.values(graph)) {
    info[node.class_type] ??= {input: {required: {}}};
    for (const key of ["unet_name", "clip_name", "vae_name"]) if (node.inputs[key]) info[node.class_type].input.required[key] = [[...new Set([...(info[node.class_type].input.required[key]?.[0] ?? []), node.inputs[key]])]];
  }
  info.LoadImage = {};
  info.MiniMaxH3AddGuide = {};
  const fetchBefore = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: any) => { calls.push(String(url)); return Response.json(info); }) as typeof fetch;
  try {
    await checkH3RenderService(configFor());
    assert.deepEqual(calls, ["http://comfy.test/object_info"]);
    info.UNETLoader.input.required.unet_name = [["another-model.safetensors"]];
    await assert.rejects(checkH3RenderService(configFor()), /模型文件/);
  } finally { globalThis.fetch = fetchBefore; }
});

test("H3 cold-start check retries transient connection and readiness failures without submitting a prompt", async () => {
  const graph = await readTemplate();
  const info: Record<string, any> = {};
  for (const node of Object.values(graph)) {
    info[node.class_type] ??= {input: {required: {}}};
    for (const key of ["unet_name", "clip_name", "vae_name"]) if (node.inputs[key]) info[node.class_type].input.required[key] = [[...new Set([...(info[node.class_type].input.required[key]?.[0] ?? []), node.inputs[key]])]];
  }
  info.LoadImage = {};
  info.MiniMaxH3AddGuide = {};
  const calls: string[] = [];
  const fetchBefore = globalThis.fetch;
  let attempt = 0;
  globalThis.fetch = (async (url: any) => {
    calls.push(String(url));
    attempt += 1;
    if (attempt === 1) throw new Error("connection refused");
    if (attempt === 2) return new Response("warming up", {status: 503});
    return Response.json(info);
  }) as typeof fetch;
  try {
    await checkH3RenderService({...configFor(), timeoutMs: 1_000, pollIntervalMs: 1});
    assert.equal(calls.length, 3);
    assert.ok(calls.every((url) => url.endsWith("/object_info")));
  } finally { globalThis.fetch = fetchBefore; }
});

test("H3 cold-start check fails immediately for a returned missing node or model", async () => {
  const graph = await readTemplate();
  const makeInfo = () => {
    const info: Record<string, any> = {};
    for (const node of Object.values(graph)) {
      info[node.class_type] ??= {input: {required: {}}};
      for (const key of ["unet_name", "clip_name", "vae_name"]) if (node.inputs[key]) info[node.class_type].input.required[key] = [[...new Set([...(info[node.class_type].input.required[key]?.[0] ?? []), node.inputs[key]])]];
    }
    info.LoadImage = {};
    info.MiniMaxH3AddGuide = {};
    return info;
  };
  const fetchBefore = globalThis.fetch;
  try {
    for (const kind of ["node", "model"] as const) {
      const info = makeInfo();
      if (kind === "node") delete info.MiniMaxH3ReferenceToVideo;
      else info.UNETLoader.input.required.unet_name = [["missing-h3-model.safetensors"]];
      let calls = 0;
      globalThis.fetch = (async () => { calls += 1; return Response.json(info); }) as typeof fetch;
      await assert.rejects(checkH3RenderService({...configFor(), timeoutMs: 1_000, pollIntervalMs: 1}), kind === "node" ? /缺少 H3 工作流节点/ : /模型文件/);
      assert.equal(calls, 1);
    }
  } finally { globalThis.fetch = fetchBefore; }
});

test("oversized requests fail before uploads and failed jobs use a bounded number of new seeds", async () => withTemp(async (directory) => {
  const ref = path.join(directory, "ref.png");
  await sharp({create: {width: 16, height: 16, channels: 3, background: "white"}}).png().toFile(ref);
  const input = {references: [ref], prompt: "<Picture 1> is the actor.", aspectRatio: "9:16", duration: 18, outputPath: path.join(directory, "out.mp4"), nativePath: path.join(directory, "native.mp4"), requestPath: path.join(directory, "request.json")};
  const fetchBefore = globalThis.fetch;
  const seeds: number[] = [];
  let calls = 0;
  globalThis.fetch = (async (url: any, init: any = {}) => {
    calls += 1;
    const address = String(url);
    if (address.endsWith("/upload/image")) return Response.json({name: "ref.png", subfolder: "input"});
    if (address.endsWith("/prompt")) {
      seeds.push(JSON.parse(init.body).prompt["8"].inputs.noise_seed);
      return Response.json({prompt_id: String(seeds.length)});
    }
    if (address.includes("/history/")) return Response.json({[String(seeds.length)]: {status: {status_str: "error"}}});
    throw new Error("unexpected fetch");
  }) as typeof fetch;
  try {
    await assert.rejects(generateH3Video(input, configFor()), /拆分/);
    assert.equal(calls, 0);
    await assert.rejects(generateH3Video({...input, duration: 2}, configFor()), /生成失败/);
    assert.equal(seeds.length, 2);
    assert.notEqual(seeds[0], seeds[1]);
    await assert.rejects(fs.access(input.outputPath));
  } finally { globalThis.fetch = fetchBefore; }
}));

test("ambiguous H3 prompt submissions never queue a second GPU job", async () => withTemp(async (directory) => {
  const ref = path.join(directory, "ref.png");
  await sharp({create: {width: 16, height: 16, channels: 3, background: "white"}}).png().toFile(ref);
  const input = {references: [ref], prompt: "<Picture 1> is the actor.", aspectRatio: "9:16", duration: 2, outputPath: path.join(directory, "out.mp4"), nativePath: path.join(directory, "native.mp4"), requestPath: path.join(directory, "request.json")};
  const fetchBefore = globalThis.fetch;
  try {
    for (const scenario of ["disconnect", "timeout", "invalid-json", "missing-id"] as const) {
      let promptCalls = 0;
      let historyCalls = 0;
      globalThis.fetch = (async (url: any) => {
        const address = String(url);
        if (address.endsWith("/upload/image")) return Response.json({name: "ref.png", subfolder: "input"});
        if (address.endsWith("/prompt")) {
          promptCalls += 1;
          if (scenario === "disconnect") throw new TypeError("fetch failed after body sent");
          if (scenario === "timeout") throw new DOMException("request timed out", "TimeoutError");
          if (scenario === "invalid-json") return new Response("{truncated", {status: 200});
          return Response.json({number: 3});
        }
        if (address.includes("/history/")) historyCalls += 1;
        throw new Error(`unexpected ${address}`);
      }) as typeof fetch;
      await assert.rejects(generateH3Video(input, {...configFor(), maxRetries: 3}), /不自动重新提交/);
      assert.equal(promptCalls, 1, scenario);
      assert.equal(historyCalls, 0, scenario);
      await assert.rejects(fs.access(input.outputPath));
    }
  } finally { globalThis.fetch = fetchBefore; }
}));

test("explicit H3 submission rejection permits bounded retries with new seeds", async () => withTemp(async (directory) => {
  const ref = path.join(directory, "ref.png");
  await sharp({create: {width: 16, height: 16, channels: 3, background: "white"}}).png().toFile(ref);
  const input = {references: [ref], prompt: "<Picture 1> is the actor.", aspectRatio: "9:16", duration: 2, outputPath: path.join(directory, "out.mp4"), nativePath: path.join(directory, "native.mp4"), requestPath: path.join(directory, "request.json")};
  const fetchBefore = globalThis.fetch;
  try {
    for (const scenario of ["http-rejection", "node-rejection"] as const) {
      const seeds: number[] = [];
      globalThis.fetch = (async (url: any, init: any = {}) => {
        const address = String(url);
        if (address.endsWith("/upload/image")) return Response.json({name: "ref.png", subfolder: "input"});
        if (address.endsWith("/prompt")) {
          seeds.push(JSON.parse(init.body).prompt["8"].inputs.noise_seed);
          return scenario === "http-rejection"
            ? Response.json({error: "invalid prompt"}, {status: 400})
            : Response.json({node_errors: {"4": {errors: [{type: "invalid_input"}]}}});
        }
        throw new Error(`unexpected ${address}`);
      }) as typeof fetch;
      await assert.rejects(generateH3Video(input, configFor()), scenario === "http-rejection" ? /HTTP 400/ : /提交被拒绝/);
      assert.equal(seeds.length, 2, scenario);
      assert.notEqual(seeds[0], seeds[1]);
      await assert.rejects(fs.access(input.outputPath));
    }
  } finally { globalThis.fetch = fetchBefore; }
}));

test("H3 request uploads ordered refs, retries with a new seed, downloads and trims silent exact-duration media", async () => withTemp(async (directory) => {
  const fixture = path.join(directory, "fixture.mp4");
  await execFileAsync(resolveMediaCommand("ffmpeg"), ["-y", "-f", "lavfi", "-i", "color=c=blue:s=64x64:r=24", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "0.75", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", fixture]);
  const bytes = await fs.readFile(fixture);
  const refs = ["actor.png", "background.png", "tail.png"].map((name) => path.join(directory, name));
  await Promise.all(refs.map((file) => sharp({create: {width: 32, height: 32, channels: 3, background: "white"}}).png().toFile(file)));
  const fetchBefore = globalThis.fetch;
  const uploads: string[] = [];
  const submitted: H3ApiWorkflow[] = [];
  globalThis.fetch = (async (url: any, init: any = {}) => {
    const address = String(url);
    if (address.endsWith("/upload/image")) {
      const image = init.body.get("image");
      uploads.push(image.name);
      return Response.json({name: image.name, subfolder: "uploaded", type: "input"});
    }
    if (address.endsWith("/prompt")) {
      submitted.push(JSON.parse(init.body).prompt);
      return Response.json({prompt_id: `job-${submitted.length}`, node_errors: {}});
    }
    if (address.includes("/history/job-1")) return Response.json({"job-1": {status: {status_str: "error", messages: [["execution_error", {exception_message: "fixture failure"}]]}}});
    if (address.includes("/history/job-2")) return Response.json({"job-2": {status: {status_str: "success", completed: true}, outputs: {"91": {images: [{filename: "generated.mp4", subfolder: "out", type: "output"}]}}}});
    if (address.includes("/view?")) return new Response(bytes);
    throw new Error(`unexpected ${address}`);
  }) as typeof fetch;
  const outputPath = path.join(directory, "final.mp4");
  const nativePath = path.join(directory, "native.mp4");
  const requestPath = path.join(directory, "request.json");
  const customTemplate = path.join(directory, "custom-api.json");
  const graph = await readTemplate();
  graph["91"] = graph["12"];
  delete graph["12"];
  await fs.writeFile(customTemplate, JSON.stringify(graph));
  try {
    await generateH3Video({references: refs.slice(0, 2), firstFrame: refs[2], prompt: workflowInput().prompt, aspectRatio: "9:16", duration: 0.5, outputPath, nativePath, requestPath}, {...configFor(), workflowPath: customTemplate});
    assert.deepEqual(uploads, ["ref_0.png", "ref_1.png", "ref_2.png"]);
    assert.equal(submitted.length, 2);
    assert.notEqual(submitted[0]["8"].inputs.noise_seed, submitted[1]["8"].inputs.noise_seed);
    assert.equal(submitted[1]["4"].inputs.length, 124);
    assert.deepEqual(JSON.parse(await fs.readFile(requestPath, "utf8")).prompt, submitted[1]);
    assert.deepEqual(await fs.readFile(nativePath), bytes);
    const {stdout} = await execFileAsync(resolveMediaCommand("ffprobe"), ["-v", "error", "-count_frames", "-show_entries", "stream=codec_type,nb_read_frames,r_frame_rate,width,height", "-of", "json", outputPath]);
    const streams = JSON.parse(String(stdout)).streams;
    assert.equal(streams.length, 1);
    assert.equal(streams[0].codec_type, "video");
    assert.equal(streams[0].nb_read_frames, "12");
    assert.equal(streams[0].r_frame_rate, "24/1");
    assert.equal(streams[0].width, 720);
    assert.equal(streams[0].height, 1280);
    const frozenPath = path.join(directory, "frozen.mp4");
    await normalizeH3Video(fixture, frozenPath, "16:9", 1);
    const frozen = await execFileAsync(resolveMediaCommand("ffprobe"), ["-v", "error", "-count_frames", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", frozenPath]);
    assert.equal(String(frozen.stdout).trim(), "24");
  } finally { globalThis.fetch = fetchBefore; }
}));
