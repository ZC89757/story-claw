import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {promisify} from "node:util";
import {execFile} from "node:child_process";
import sharp from "sharp";
import {generateH3Clip, splitH3ClipFrames, h3ClipCacheIdentity} from "../utils/h3-clip.js";
import {warmH3RenderService, type H3ApiWorkflow} from "../utils/h3-video.js";
import {bundledH3WorkflowPath, type StoryVideoConfig} from "../utils/story-video-config.js";
import {resolveMediaCommand} from "../utils/media-binaries.js";
import {PATHS} from "../utils/paths.js";

const run = promisify(execFile);
const config = (): StoryVideoConfig => ({baseUrl: "http://h3.test", workflowPath: bundledH3WorkflowPath(), maxDuration: 15, fps: 24, concurrency: 1, maxRetries: 0, pollIntervalMs: 1, timeoutMs: 30_000});
const temp = async (fn: (dir: string) => Promise<void>) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "unified-h3-"));
  try {await fn(dir);} finally {await fs.rm(dir, {recursive: true, force: true});}
};
const registry = (graph: H3ApiWorkflow) => {
  const info: Record<string, any> = {LoadImage: {}, MiniMaxH3AddGuide: {}};
  for (const node of Object.values(graph)) {
    info[node.class_type] ??= {input: {required: {}}};
    for (const key of ["unet_name", "clip_name", "vae_name"]) if (node.inputs[key]) {
      const names = info[node.class_type].input.required[key]?.[0] ?? [];
      info[node.class_type].input.required[key] = [[...new Set([...names, node.inputs[key]])]];
    }
  }
  return info;
};
const videoFixture = async (dir: string) => {
  const file = path.join(dir, "fixture.mp4");
  await run(resolveMediaCommand("ffmpeg"), ["-y", "-f", "lavfi", "-i", "color=c=blue:s=64x64:r=24", "-frames:v", "124", "-c:v", "libx264", "-pix_fmt", "yuv420p", file]);
  return fs.readFile(file);
};

test("long HTML windows split on exact 24fps frames without changing their summed duration", () => {
  assert.deepEqual(splitH3ClipFrames(16.477, 15), [198, 197]);
  assert.deepEqual(splitH3ClipFrames(15, 15), [360]);
  assert.deepEqual(splitH3ClipFrames(2.79, 15), [67]);
  const parts = splitH3ClipFrames(30.1, 15);
  assert.equal(parts.reduce((a,b)=>a+b), Math.round(30.1*24));
  assert.ok(parts.every(n=>n<=360));
  assert.throws(()=>splitH3ClipFrames(0.001,15), /不足/);
  assert.notDeepEqual(h3ClipCacheIdentity(config(), Buffer.from("old")), h3ClipCacheIdentity(config(), Buffer.from("new")));
});

test("H3 clip joins internal jobs, guides from the real tail and reuses only a matching H3 completion", async () => temp(async dir => {
  const bytes = await videoFixture(dir);
  const imagePath = path.join(dir,"scene.png");
  await sharp({create:{width:64,height:64,channels:3,background:"white"}}).png().toFile(imagePath);
  const submitted: H3ApiWorkflow[] = [];
  const previous = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any={}) => {
    const address=String(url);
    if(address.endsWith("/upload/image")) return Response.json({name:`uploaded-${submitted.length}.png`});
    if(address.endsWith("/prompt")) {submitted.push(JSON.parse(init.body).prompt);return Response.json({prompt_id:`job-${submitted.length}`});}
    if(address.includes("/history/")) {const id=address.split("/").pop()!; return Response.json({[id]:{status:{status_str:"success"},outputs:{"12":{videos:[{filename:"fixture.mp4"}]}}}});}
    if(address.includes("/view?")) return new Response(bytes);
    throw new Error(address);
  }) as typeof fetch;
  const input={imagePath,prompt:"Gentle movement.",outputPath:path.join(dir,"output.mp4"),aspectRatio:"16:9",duration:0.54};
  try {
    await generateH3Clip(input,{...config(),maxDuration:0.3});
    assert.equal(submitted.length,2);
    assert.ok(Object.values(submitted[1]).some(n=>n.class_type==="MiniMaxH3AddGuide"));
    await fs.access(`${input.outputPath}.h3/last-0.png`);
    const completion=JSON.parse(await fs.readFile(`${input.outputPath}.h3/completed.json`,"utf8"));
    assert.equal(completion.backend,"h3");
    assert.equal(completion.frames,13);
    const {stdout}=await run(resolveMediaCommand("ffprobe"),["-v","error","-count_frames","-show_entries","stream=nb_read_frames,r_frame_rate","-of","json",input.outputPath]);
    assert.equal(JSON.parse(String(stdout)).streams[0].nb_read_frames,"13");
    await generateH3Clip(input,{...config(),maxDuration:0.3});
    assert.equal(submitted.length,2);
    await fs.writeFile(input.outputPath,"stale LTX or corrupt output");
    await generateH3Clip(input,{...config(),maxDuration:0.3});
    assert.equal(submitted.length,4);
  } finally {globalThis.fetch=previous;}
}));

test("real warmup waits for successful H3 video, preserves production workflow and fails on execution error", async()=>temp(async dir=>{
  const template=JSON.parse(await fs.readFile(bundledH3WorkflowPath(),"utf8"));
  const before=await fs.readFile(bundledH3WorkflowPath(),"utf8");
  const bytes=await videoFixture(dir);
  const previous=globalThis.fetch;
  let reject=false;
  let posts=0;
  let warmDirectory="";
  globalThis.fetch=(async(url:any,init:any={})=>{
    const address=String(url);
    if(address.endsWith("/object_info")) return Response.json(registry(template));
    if(address.endsWith("/upload/image")) return Response.json({name:"ref.png"});
    if(address.endsWith("/prompt")) {
      posts++;
      const graph=JSON.parse(init.body).prompt;
      assert.equal(graph["4"].inputs.length,124);
      assert.equal(graph["7"].inputs.steps,1);
      assert.equal(graph["15"].inputs.megapixels,0.4);
      assert.deepEqual(graph["11"].inputs.audio,["14",0]);
      return Response.json({prompt_id:"warmup"});
    }
    if(address.includes("/history/")) return Response.json({warmup:reject?{status:{status_str:"error"}}:{status:{status_str:"success"},outputs:{"12":{videos:[{filename:"fixture.mp4"}]}}}});
    if(address.includes("/view?")) return new Response(bytes);
    throw new Error(address);
  }) as typeof fetch;
  try {
    const native=await warmH3RenderService(config());
    warmDirectory=path.dirname(native);
    assert.ok(path.resolve(warmDirectory).startsWith(path.resolve(PATHS.h3Warmups)+path.sep));
    const completion=JSON.parse(await fs.readFile(path.join(warmDirectory,"completed.json"),"utf8"));
    assert.equal(completion.nativeFrames,124);
    reject=true;
    await assert.rejects(warmH3RenderService(config()),/生成失败/);
    assert.equal(posts,2);
    assert.equal(await fs.readFile(bundledH3WorkflowPath(),"utf8"),before);
  } finally {
    globalThis.fetch=previous;
    if(warmDirectory) await fs.rm(warmDirectory,{recursive:true,force:true});
  }
}));

test("ambiguous H3 clip submission never publishes a new video or queues a duplicate",async()=>temp(async dir=>{
  const imagePath=path.join(dir,"scene.png");
  await sharp({create:{width:32,height:32,channels:3,background:"white"}}).png().toFile(imagePath);
  const previous=globalThis.fetch;
  let posts=0;
  globalThis.fetch=(async(url:any)=>{
    if(String(url).endsWith("/upload/image")) return Response.json({name:"ref.png"});
    posts++;throw new Error("response lost");
  }) as typeof fetch;
  const outputPath=path.join(dir,"out.mp4");
  try {
    await assert.rejects(generateH3Clip({imagePath,prompt:"move",outputPath:imagePath,aspectRatio:"16:9",duration:1},config()),/不能覆盖/);
    assert.equal(posts,0);
    await assert.rejects(generateH3Clip({imagePath,prompt:"move",outputPath,aspectRatio:"16:9",duration:1},{...config(),maxRetries:2}),/不自动重新提交/);
    assert.equal(posts,1);
    await assert.rejects(fs.access(outputPath));
    await assert.rejects(fs.access(`${outputPath}.h3/completed.json`));
  } finally{globalThis.fetch=previous;}
}));
