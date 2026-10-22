import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {adoptPreparedMgClips} from "./planner.js";
import {runMediaCommand} from "./media.js";
import type {VisualFunctionRecord} from "./types.js";

test("adopting verified local clips preserves native signatures and rejects changed parameters or timing atomically",async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"mg-prepared-"));
  try {
    const file=path.join(dir,"clip.mp4");
    await runMediaCommand("ffmpeg",["-y","-f","lavfi","-i","color=c=blue:s=64x64:r=24","-frames:v","6","-c:v","libx264","-pix_fmt","yuv420p",file]);
    const record={instanceKey:"mg-title::slide::one",name:"create_title_cue",arguments:{group:"slide",order:null,text:"甲"},startFrame:0,endFrame:6,status:"queued",taskSignature:"native-signature"} as VisualFunctionRecord;
    const clip={instanceKey:record.instanceKey,name:record.name,arguments:{text:"甲",order:null,group:"slide"},startFrame:0,endFrame:6,videoPath:file};
    await adoptPreparedMgClips([record],[clip],24);
    assert.equal(record.status,"completed");
    assert.equal(record.videoPath,file);
    assert.equal(record.taskSignature,"native-signature");
    const fresh={...record,status:"queued" as const,videoPath:undefined};
    const second={...fresh,instanceKey:"second"};
    await assert.rejects(adoptPreparedMgClips([fresh,second],[clip,{...clip,instanceKey:"second",endFrame:7}],24),/时间不一致/);
    assert.equal(fresh.status,"queued");
    await assert.rejects(adoptPreparedMgClips([fresh],[{...clip,arguments:{...clip.arguments,text:"乙"}}],24),/参数或时间不一致/);
    await assert.rejects(adoptPreparedMgClips([fresh],[{...clip,videoPath:path.join(dir,"missing.mp4")}],24));
    assert.equal(fresh.status,"queued");
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});
