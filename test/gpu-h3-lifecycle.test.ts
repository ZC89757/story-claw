import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {fileURLToPath, pathToFileURL} from "node:url";
import {resolveMediaCommand} from "../utils/media-binaries.js";
import {bundledH3WorkflowPath} from "../utils/story-video-config.js";

const execute=promisify(execFile);
const root=fileURLToPath(new URL("..",import.meta.url));
test("managed lifecycle starts cloud instance before actual H3 inference and never reports failed warmup ready",async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"h3-lifecycle-"));
  try {
    await fs.writeFile(path.join(dir,"gpu_config.json"),JSON.stringify({provider:"compshare",instance_id:"test-host",public_key:"test-public",private_key:"test-private",start_timeout:1,stop_timeout:1}));
    await fs.writeFile(path.join(dir,"video_config.json"),JSON.stringify({h3_base_url:"http://h3.test",h3_poll_interval_ms:1,h3_timeout_ms:5000}));
    await execute(resolveMediaCommand("ffmpeg"),["-y","-f","lavfi","-i","color=c=blue:s=64x64:r=24","-frames:v","124","-c:v","libx264","-pix_fmt","yuv420p",path.join(dir,"fixture.mp4")]);
    const fixture=path.join(dir,"run.mjs");
    await fs.writeFile(fixture,`
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const graph=JSON.parse(await fs.readFile(${JSON.stringify(bundledH3WorkflowPath())},'utf8'));
const info={LoadImage:{},MiniMaxH3AddGuide:{}};
for(const n of Object.values(graph)) {
  info[n.class_type]??={input:{required:{}}};
  for(const k of ['unet_name','clip_name','vae_name']) if(n.inputs[k]) {
    const names=info[n.class_type].input.required[k]?.[0]??[];
    info[n.class_type].input.required[k]=[[...new Set([...names,n.inputs[k]])]];
  }
}
const bytes=await fs.readFile(${JSON.stringify(path.join(dir,"fixture.mp4"))});
const calls=[];
let state=process.env.TEST_BOOTING?'Initializing':'Stopped';
let descriptions=0;
globalThis.fetch=async(url,init={})=>{
  const s=String(url);
  if(s==='https://api.compshare.cn') {
    const params=new URLSearchParams(init.body);
    const action=params.get('Action'); calls.push(action);
    assert.equal(params.get('PublicKey'),'test-public');
    assert.ok(params.get('Signature'));
    if(action==='StartCompShareInstance')state='Running';
    if(action==='DescribeCompShareInstance'&&process.env.TEST_BOOTING&&state==='Initializing'&&++descriptions>1)state='Running';
    if(action==='StopCompShareInstance')state='Stopped';
    return Response.json({RetCode:0,UHostSet:[{UHostId:'test-host',Region:'test',Zone:'test-1',State:state}]});
  }
  calls.push(s.split('/').slice(-1)[0]);
  if(s.endsWith('/object_info')) {assert.equal(state,'Running');return Response.json(info);}
  if(s.endsWith('/upload/image'))return Response.json({name:'ref.png'});
  if(s.endsWith('/prompt'))return Response.json(process.env.TEST_FAIL_WARMUP?{}:{prompt_id:'warmup'});
  if(s.includes('/history/'))return Response.json({warmup:{status:{status_str:'success'},outputs:{'12':{videos:[{filename:'test.mp4'}]}}}});
  if(s.includes('/view?'))return new Response(bytes);
  throw new Error(s);
};
const {startGpu,stopGpu}=await import(${JSON.stringify(pathToFileURL(path.join(root,"utils/gpu-lifecycle.ts")).href)});
let ready=false;
try {await startGpu();ready=true;}
catch(error){assert.ok(process.env.TEST_FAIL_WARMUP);assert.match(error.message,/不自动重新提交/);}
finally {await stopGpu();}
assert.equal(state,'Stopped');
assert.equal(ready,!process.env.TEST_FAIL_WARMUP);
assert.equal(calls.filter(s=>s==='prompt').length,1);
if(process.env.TEST_BOOTING) assert.equal(calls.filter(s=>s==='StartCompShareInstance').length,0);
else assert.ok(calls.indexOf('StartCompShareInstance')<calls.indexOf('object_info'));
assert.ok(calls.indexOf('prompt')<calls.indexOf('StopCompShareInstance'));
console.log('lifecycle-order-verified');
`);
    for (const scenario of ["success","failed-warmup","already-booting"]) {
      const {stdout}=await execute(process.execPath,["--import","tsx",fixture],{cwd:root,timeout:30_000,
        env:{...process.env,STORY_CLAW_CONFIG_DIR:dir,STORY_CLAW_WORK_DIR:dir,COMPSHARE_PUBLIC_KEY:"",COMPSHARE_PRIVATE_KEY:"",STORY_CLAW_GPU_INSTANCE:"",TEST_FAIL_WARMUP:scenario==="failed-warmup"?"1":"",TEST_BOOTING:scenario==="already-booting"?"1":""}});
      assert.match(String(stdout),/lifecycle-order-verified/);
    }
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});
