import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {NovelSelection} from "../../ui/select.js";
import {PATHS, novelPaths} from "../../utils/paths.js";
import {assembleEssayMg} from "./assembler.js";
import {probeMgVideo, runMediaCommand, sha256File} from "./media.js";
import type {MgPlan} from "./types.js";

test("MG assembly changes the output without modifying the raw master", async () => {
  const originalWorkspace = PATHS.workspace;
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "story-claw-mg-"));
  PATHS.workspace = tempRoot;
  const novelName = "assembly-smoke";
  const episode = 1;

  try {
    const rawVideo = novelPaths.episodeRawVideo(novelName, episode);
    const outputPath = novelPaths.episodeMgRawVideo(novelName, episode);
    await Promise.all([
      fs.mkdir(path.dirname(rawVideo), {recursive: true}),
      fs.mkdir(path.dirname(outputPath), {recursive: true}),
    ]);
    await runMediaCommand("ffmpeg", [
      "-loglevel", "error",
      "-y",
      "-f", "lavfi",
      "-i", "color=c=red:s=320x180:r=10:d=3",
      "-frames:v", "30",
      "-an",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      rawVideo,
    ]);
    // The renderer now owns the full-episode composition. The assembler is a
    // validation gate, so provide a conforming rendered output directly here
    // instead of manufacturing an obsolete middle clip for concat.
    await runMediaCommand("ffmpeg", [
      "-loglevel", "error",
      "-y",
      "-f", "lavfi",
      "-i", "color=c=blue:s=320x180:r=10:d=3",
      "-frames:v", "30",
      "-an",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      outputPath,
    ]);

    const source = await probeMgVideo(rawVideo);
    const rawHash = await sha256File(rawVideo);
    const plan: MgPlan = {
      version: 3,
      source: {
        rawVideo,
        sha256: rawHash,
        ...source,
        html: "mg_annotation.html",
        timeline: "article_timeline.json",
      },
      instances: [],
      functionCalls: [],
      scenes: [],
    };
    await fs.mkdir(novelPaths.mgDir(novelName, episode), {recursive: true});
    await fs.writeFile(
      novelPaths.mgPlan(novelName, episode),
      `${JSON.stringify(plan, null, 2)}\n`,
      "utf-8",
    );

    const output = await assembleEssayMg({novelName, episode} as NovelSelection);
    const assembled = await probeMgVideo(output);
    assert.equal(assembled.durationFrames, 30);
    assert.equal(await sha256File(rawVideo), rawHash);
    assert.notEqual(await sha256File(output), rawHash);
  } finally {
    PATHS.workspace = originalWorkspace;
    await fs.rm(tempRoot, {recursive: true, force: true});
  }
});
