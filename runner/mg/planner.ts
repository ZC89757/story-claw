import fs from "node:fs/promises";
import path from "node:path";
import type {ToolDefinition} from "@mariozechner/pi-coding-agent";
import {runSubAgent} from "../../agent.js";
import type {NovelSelection} from "../../ui/select.js";
import {novelPaths} from "../../utils/paths.js";
import type {ArticleTimelineEntry} from "../render.js";
import {locateMgInstances, validateMgAnnotationHtml} from "./html.js";
import {probeMgVideo, sha256File} from "./media.js";
import {mgProvider, resolveMgFunctionCall} from "./registry.js";
import type {
  MgInstanceInfo,
  MgPlan,
  MgRenderBundle,
  MgScenePlan,
  MgVideoInfo,
  RawMgFunctionCall,
  ResolvedMgFunctionCall,
} from "./types.js";

const AT_TOLERANCE_SECONDS = 0.35;
const MIN_VISIBLE_SECONDS = 0.8;
const TRAILING_VISIBLE_SECONDS = 0.4;

export const selectMgFunctionDefinitions = (tags: Iterable<string>) =>
  mgProvider.getPlanningTools([...new Set(tags)]);

const requestFunctionCalls = async (
  html: string,
  timelineRaw: string,
  feedback: string,
  htmlTags: readonly string[],
): Promise<RawMgFunctionCall[]> => {
  const calls: RawMgFunctionCall[] = [];
  const tools: ToolDefinition[] = mgProvider.getPlanningTools(htmlTags).map((definition) => ({
    name: definition.name,
    label: definition.label,
    description: definition.description,
    parameters: definition.parameters as any,
    execute: async (toolCallId: string, params: Record<string, unknown>) => {
      const call = {id: toolCallId, name: definition.name, arguments: params};
      // Validate immediately so the model receives the template-owned error.
      resolveMgFunctionCall(call);
      calls.push(call);
      return {
        content: [{type: "text" as const, text: `已记录 ${definition.label} order=${String(params.order ?? "null")}`}],
        details: {},
      };
    },
  }));

  await runSubAgent(
    tools,
    mgProvider.getPlanningInstructions(),
    [
      feedback ? `校验错误：\n${feedback}\n请重新完成所有动画实例。` : "",
      "== MG HTML ==",
      html,
      "== 字级时间轴 JSON ==",
      timelineRaw,
    ].filter(Boolean).join("\n\n"),
    "[MG Function Calling]",
    [],
  );
  return calls;
};

const validateAndResolveCalls = (
  rawCalls: RawMgFunctionCall[],
  instances: Map<string, MgInstanceInfo>,
  videoDuration: number,
): ResolvedMgFunctionCall[] => {
  const errors: string[] = [];
  const callsByInstance = new Map<string, ResolvedMgFunctionCall>();
  for (const call of rawCalls) {
    try {
      const callResolved = resolveMgFunctionCall(call);
      if (callsByInstance.has(callResolved.instanceKey)) errors.push(`${callResolved.instanceKey} 被调用了多次`);
      else callsByInstance.set(callResolved.instanceKey, callResolved);
    } catch (error) {
      errors.push(`${call.name} 参数校验失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const instanceKey of instances.keys()) {
    if (!callsByInstance.has(instanceKey)) errors.push(`缺少 ${instanceKey} 的 Function Call`);
  }
  for (const instanceKey of callsByInstance.keys()) {
    if (!instances.has(instanceKey)) errors.push(`多出了 HTML 不存在的实例 ${instanceKey}`);
  }

  const resolved: ResolvedMgFunctionCall[] = [];
  for (const [instanceKey, instance] of instances) {
    const call = callsByInstance.get(instanceKey);
    if (!call) continue;
    if (!mgProvider.isToolAllowed({htmlTag: instance.tag, group: instance.group, name: call.name})) {
      errors.push(`${instanceKey} 的 <${instance.tag}> group=${instance.group} 错用了 ${call.name}`);
      continue;
    }
    if (call.htmlTag !== instance.tag) errors.push(`${instanceKey} 的 HTML 标签应为 ${instance.tag}，实际为 ${call.htmlTag}`);
    if (call.group !== instance.group) errors.push(`${instanceKey} 的 group 应为 ${instance.group}，实际为 ${call.group}`);
    if (call.order !== instance.order) {
      errors.push(`${instanceKey} 的 order 应为 ${instance.order ?? "null"}，实际为 ${call.order ?? "null"}`);
    }
    const expectedRootAt = instance.tags[0].start;
    if (!Number.isFinite(call.at) || Math.abs(call.at - expectedRootAt) > AT_TOLERANCE_SECONDS) {
      errors.push(`${instanceKey} 根 at=${call.at}，应接近 ${expectedRootAt}`);
    }
    for (const tag of instance.tags) {
      if (!call.elementAts.some((at) => Math.abs(at - tag.start) <= AT_TOLERANCE_SECONDS)) {
        errors.push(`${instanceKey} 没有元素 at 对应“${tag.text.slice(0, 24)}”的 ${tag.start}`);
      }
    }
    if (call.elementAts.some((at) => at < expectedRootAt - AT_TOLERANCE_SECONDS || at > instance.paragraphEnd + AT_TOLERANCE_SECONDS)) {
      errors.push(`${instanceKey} 存在超出所属正文范围的元素 at`);
    }
    if (call.elementAts.some((at) => at > videoDuration + AT_TOLERANCE_SECONDS)) {
      errors.push(`${instanceKey} 存在超出原画时长的元素 at`);
    }
    resolved.push(call);
  }
  if (errors.length) throw new Error(errors.join("\n"));
  return resolved.sort((left, right) => left.at - right.at);
};

type WindowCandidate = {
  key: string;
  instance: MgInstanceInfo;
  call: ResolvedMgFunctionCall;
  rootFrame: number;
  startFrame: number;
  endFrame: number;
  sourceText: string;
  order: number;
};

const instanceWindows = (
  call: ResolvedMgFunctionCall,
  instance: MgInstanceInfo,
  video: MgVideoInfo,
): WindowCandidate[] => {
  const frame = (seconds: number) => Math.max(0, Math.min(video.durationFrames, Math.round(seconds * video.fps)));
  const startFrameAt = (seconds: number) => Math.min(video.durationFrames - 1, frame(seconds));
  const rootFrame = startFrameAt(call.at);
  if (instance.mode === "together") {
    const lastTag = instance.tags.at(-1)!;
    const endSeconds = Math.max(lastTag.end + TRAILING_VISIBLE_SECONDS, call.at + MIN_VISIBLE_SECONDS);
    return [{
      key: `${instance.instanceKey}-together`, instance, call, rootFrame,
      startFrame: rootFrame,
      endFrame: Math.min(video.durationFrames, Math.max(rootFrame + 1, frame(endSeconds))),
      sourceText: instance.tags.map((tag) => tag.text).join("｜"),
      order: instance.tags[0].documentOrder,
    }];
  }
  return instance.tags.map((tag, index) => {
    const startFrame = startFrameAt(tag.start);
    const nextStartFrame = instance.tags[index + 1] ? startFrameAt(instance.tags[index + 1].start) : video.durationFrames;
    const desiredEnd = frame(Math.max(tag.end + TRAILING_VISIBLE_SECONDS, tag.start + MIN_VISIBLE_SECONDS));
    return {
      key: `${instance.instanceKey}-split-${index + 1}`,
      instance, call, rootFrame, startFrame,
      endFrame: Math.min(video.durationFrames, Math.max(startFrame + 1, Math.min(desiredEnd, Math.max(startFrame + 1, nextStartFrame - 1)))),
      sourceText: tag.text,
      order: tag.documentOrder,
    };
  });
};

/**
 * Scene templates retain the former nested/overlap winner logic. Overlay
 * templates deliberately do not compete: every active overlay becomes a
 * separate placement in one full-episode composition.
 */
const resolveSceneIntervals = (candidates: WindowCandidate[]): WindowCandidate[] => {
  if (!candidates.length) return [];
  const boundaries = [...new Set(candidates.flatMap((candidate) => [candidate.startFrame, candidate.endFrame]))].sort((a, b) => a - b);
  const intervals: WindowCandidate[] = [];
  for (let index = 0; index < boundaries.length - 1; index++) {
    const startFrame = boundaries[index];
    const endFrame = boundaries[index + 1];
    if (endFrame <= startFrame) continue;
    const winner = candidates
      .filter((candidate) => candidate.startFrame <= startFrame && candidate.endFrame >= endFrame)
      .sort((left, right) => right.instance.depth - left.instance.depth || right.startFrame - left.startFrame || right.order - left.order)[0];
    if (!winner) continue;
    const previous = intervals.at(-1);
    if (previous && previous.key === winner.key && previous.endFrame === startFrame) {
      previous.endFrame = endFrame;
    } else {
      intervals.push({...winner, startFrame, endFrame});
    }
  }
  return intervals;
};

const placementFor = (candidate: WindowCandidate, index: number, video: MgVideoInfo): MgScenePlan => ({
  id: `${candidate.instance.instanceKey}-${String(index).padStart(3, "0")}`,
  instance: candidate.instance.instanceKey,
  htmlTag: candidate.instance.tag,
  group: candidate.instance.group,
  ...(candidate.instance.order === undefined ? {} : {order: candidate.instance.order}),
  layerRole: candidate.call.layerRole,
  start: candidate.startFrame / video.fps,
  end: candidate.endFrame / video.fps,
  startFrame: candidate.startFrame,
  endFrame: candidate.endFrame,
  durationFrames: candidate.endFrame - candidate.startFrame,
  timelineOffsetFrames: candidate.startFrame - candidate.rootFrame,
  sourceText: candidate.sourceText,
  render: candidate.call.render,
});

const buildScenes = (
  calls: ResolvedMgFunctionCall[],
  instances: Map<string, MgInstanceInfo>,
  video: MgVideoInfo,
): MgScenePlan[] => {
  const allWindows = calls.flatMap((call) => instanceWindows(call, instances.get(call.instanceKey)!, video));
  const sceneWindows = resolveSceneIntervals(allWindows.filter((candidate) => candidate.call.layerRole === "scene"));
  const overlayWindows = allWindows.filter((candidate) => candidate.call.layerRole === "overlay");
  // Scene placements are painted first. All overlay placements therefore stay
  // above every scene even when their windows began before a later scene.
  const ordered = [
    ...sceneWindows.sort((left, right) => left.startFrame - right.startFrame || left.order - right.order),
    ...overlayWindows.sort((left, right) => left.startFrame - right.startFrame || left.instance.depth - right.instance.depth || left.order - right.order),
  ];
  return ordered.map((candidate, index) => placementFor(candidate, index + 1, video));
};

/** Pure entry for orchestration tests. */
export const compileMgScenes = buildScenes;

export async function planEssayMg(sel: NovelSelection): Promise<string> {
  const htmlPath = novelPaths.mgAnnotation(sel.novelName, sel.episode);
  const timelinePath = novelPaths.articleTimeline(sel.novelName, sel.episode);
  const articlePath = novelPaths.cleanedText(sel.novelName, sel.episode);
  const rawVideoPath = novelPaths.episodeRawVideo(sel.novelName, sel.episode);
  const [html, timelineRaw, article, video, rawHash] = await Promise.all([
    fs.readFile(htmlPath, "utf-8"), fs.readFile(timelinePath, "utf-8"), fs.readFile(articlePath, "utf-8"),
    probeMgVideo(rawVideoPath), sha256File(rawVideoPath),
  ]);
  const annotation = validateMgAnnotationHtml(html, article);
  const timeline = JSON.parse(timelineRaw) as ArticleTimelineEntry[];
  const instances = locateMgInstances(html, timeline, article);
  const htmlTags = [...new Set([...instances.values()].map((instance) => instance.tag))];

  let resolvedCalls: ResolvedMgFunctionCall[] = [];
  if (annotation.instanceCount > 0) {
    let feedback = "";
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      console.log(`[MG Function Calling] 第 ${attempt}/3 次`);
      try {
        const rawCalls = await requestFunctionCalls(html, timelineRaw, feedback, htmlTags);
        resolvedCalls = validateAndResolveCalls(rawCalls, instances, video.duration);
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        feedback = error instanceof Error ? error.message : String(error);
        console.warn(`[MG Function Calling] 第 ${attempt}/3 次未通过:\n${feedback}`);
      }
    }
    if (lastError) throw lastError;
  }

  const scenes = buildScenes(resolvedCalls, instances, video);
  const mgDir = novelPaths.mgDir(sel.novelName, sel.episode);
  const specsDir = novelPaths.mgSpecsDir(sel.novelName, sel.episode);
  await Promise.all([fs.mkdir(mgDir, {recursive: true}), fs.mkdir(specsDir, {recursive: true})]);
  await Promise.all(resolvedCalls.map((call) =>
    fs.writeFile(path.join(specsDir, `${call.instanceKey}.json`), `${JSON.stringify(call.render.spec, null, 2)}\n`, "utf-8"),
  ));

  const bundle: MgRenderBundle = {
    version: 3,
    width: video.width,
    height: video.height,
    fps: video.fps,
    durationFrames: video.durationFrames,
    baseFile: "base/raw-master.mp4",
    layers: scenes,
  };
  const plan: MgPlan = {
    version: 3,
    source: {rawVideo: rawVideoPath, sha256: rawHash, ...video, html: htmlPath, timeline: timelinePath},
    instances: [...instances.values()].map((instance) => ({
      instanceKey: instance.instanceKey, group: instance.group, tag: instance.tag,
      ...(instance.order === undefined ? {} : {order: instance.order}),
      mode: instance.mode, tagCount: instance.tags.length, starts: instance.tags.map((tag) => tag.start),
    })),
    functionCalls: resolvedCalls.map((call) => ({
      id: call.id, name: call.name, instanceKey: call.instanceKey, htmlTag: call.htmlTag,
      group: call.group, ...(call.order === undefined ? {} : {order: call.order}), at: call.at,
      arguments: call.arguments, specFile: `specs/${call.instanceKey}.json`,
    })),
    scenes: scenes.map(({render, ...scene}) => ({
      ...scene,
      render: {...render, specFile: `specs/${scene.instance}.json`},
    })),
  };
  await Promise.all([
    fs.writeFile(novelPaths.mgFunctionCalls(sel.novelName, sel.episode), `${JSON.stringify(plan.functionCalls, null, 2)}\n`, "utf-8"),
    fs.writeFile(novelPaths.mgPlan(sel.novelName, sel.episode), `${JSON.stringify(plan, null, 2)}\n`, "utf-8"),
    fs.writeFile(novelPaths.mgRenderBundle(sel.novelName, sel.episode), `${JSON.stringify(bundle, null, 2)}\n`, "utf-8"),
  ]);
  console.log(`[MG规划] ${resolvedCalls.length} 个 Function Call / ${scenes.length} 个图层片段`);
  return novelPaths.mgPlan(sel.novelName, sel.episode);
}
