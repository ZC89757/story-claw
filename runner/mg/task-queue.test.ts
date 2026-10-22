import assert from "node:assert/strict";
import test from "node:test";
import {runVisualTaskQueue} from "./task-queue.js";

test("local clips finish first while indices and the persisted document order remain stable", async () => {
  const records=[{htmlTag:"sc-video",id:0},{htmlTag:"web-page-focus",id:1},{htmlTag:"sc-longtake",id:2},{htmlTag:"dual-axis-chart",id:3}];
  const original=structuredClone(records);
  const events:string[]=[];
  await runVisualTaskQueue(records,async(record,index,prepare)=>{
    assert.equal(index,record.id);
    if(record.htmlTag.startsWith("sc-"))await prepare();
    events.push(`render-${record.id}`);
  },async()=>{events.push("gpu-ready");});
  assert.deepEqual(events,["render-1","render-3","gpu-ready","render-0","render-2"]);
  assert.deepEqual(records,original);
});

test("cached generated clips require no GPU startup",async()=>{
  let starts=0;
  await runVisualTaskQueue([{htmlTag:"sc-video",cached:true},{htmlTag:"sc-longtake",cached:true}],async(record,_index,prepare)=>{
    if(record.cached)return;
    await prepare();
  },async()=>{starts++;});
  assert.equal(starts,0);
});

test("a failed GPU startup preserves all prior local render checkpoints and never begins H3",async()=>{
  const completed:string[]=[];
  await assert.rejects(runVisualTaskQueue([{htmlTag:"sc-video"},{htmlTag:"video-footage"},{htmlTag:"progress-timeline"}],async(record,_index,prepare)=>{
    if(record.htmlTag==="sc-video")await prepare();
    completed.push(record.htmlTag);
  },async()=>{throw new Error("GPU unavailable");}),/GPU unavailable/);
  assert.deepEqual(completed,["video-footage","progress-timeline"]);
});

test("local-only episodes never prepare GPU",async()=>{
  let starts=0;
  await runVisualTaskQueue([{htmlTag:"subject-expansion"}],async()=>{},async()=>{starts++;});
  assert.equal(starts,0);
});
