import fs from "node:fs/promises";
import fsSync from "node:fs";
import {createHash} from "node:crypto";
import path from "node:path";
import type {ToolDefinition} from "@mariozechner/pi-coding-agent";
import {runSubAgent} from "../../agent.js";
import {searchWebTool} from "../../tools/search-web.js";
import type {NovelSelection} from "../../ui/select.js";
import {novelPaths} from "../../utils/paths.js";
import {
  generateVisualTagImage,
  generateVisualTagVideo,
  getMediaDuration,
  getVisualTagVideoSettings,
  normalizeVisualTagVideo,
  extractLastFrame,
  type ArticleTimelineEntry,
} from "../render.js";
import {locateMgInstances, validateMgAnnotationHtml} from "./html.js";
import {assertMgVideoFrames, runMediaCommand} from "./media.js";
import {mgProvider, resolveMgFunctionCall} from "./registry.js";
import type {
  DirectedGraphAnnotation,
  MgCompositionNode,
  MgInstanceInfo,
  MgPlan,
  MgRenderBundle,
  MgScenePlan,
  MgVideoInfo,
  RawMgFunctionCall,
  ResolvedMgFunctionCall,
  VisualFunctionRecord,
  VisualFunctionStatus,
} from "./types.js";

const AT_TOLERANCE_SECONDS = 0.35;
const MIN_VISIBLE_SECONDS = 0.8;
const TRAILING_VISIBLE_SECONDS = 0.4;
const SCOPE_CONCURRENCY = 4;
const SCOPE_MAX_ATTEMPTS = 3;
const MEDIA_MAX_ATTEMPTS = 3;
const VISUAL_RENDER_CACHE_VERSION = 2;

const isGeneratedVideoTag = (tag: string | undefined): boolean =>
  tag === "sc-video" || tag === "sc-longtake";

const directedGraphNodeId = (index: number): string => `n${index}`;

const formatDirectedGraphTopology = (graph: DirectedGraphAnnotation): string => JSON.stringify({
  nodes: graph.nodes.map((label, index) => ({id: directedGraphNodeId(index), label})),
  edges: graph.edges.map(([from, to]) => ({from: directedGraphNodeId(from), to: directedGraphNodeId(to)})),
}, null, 2);

export const selectMgFunctionDefinitions = (tags: Iterable<string>) =>
  mgProvider.getPlanningTools([...new Set(tags)]);

const hashId = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 20);

const sanitizeFileStem = (value: string): string =>
  value.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 90) || "visual";

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]),
  );
};

const taskSignature = (input: {
  cacheVersion: number;
  instanceKey: string;
  scopeKey: string;
  parentInstance?: string;
  depth: number;
  mode: MgInstanceInfo["mode"];
  name: string;
  arguments: Record<string, unknown>;
  sourceTags: Array<{text: string; value?: number; start: number; end: number}>;
  render: unknown;
  startFrame: number;
  endFrame: number;
  layerRole: string;
  width: number;
  height: number;
  fps: number;
  existingReferenceImageHash?: string;
  activeWindows?: Array<{startFrame: number; endFrame: number}>;
}): string => hashId(JSON.stringify(stableValue(input)));

const clipFileStem = (instanceKey: string, signature: string): string =>
  `${sanitizeFileStem(instanceKey)}_${signature}`;

const writeFunctionRecords = async (sel: NovelSelection, records: VisualFunctionRecord[]): Promise<void> => {
  await fs.mkdir(novelPaths.mgDir(sel.novelName, sel.episode), {recursive: true});
  const outputPath = novelPaths.mgFunctionCalls(sel.novelName, sel.episode);
  const nextPath = `${outputPath}.next`;
  await fs.writeFile(nextPath, `${JSON.stringify(records, null, 2)}\n`, "utf-8");
  await fs.rm(outputPath, {force: true});
  await fs.rename(nextPath, outputPath);
};

const readFunctionRecords = async (sel: NovelSelection): Promise<VisualFunctionRecord[]> => {
  try {
    const value = JSON.parse(await fs.readFile(novelPaths.mgFunctionCalls(sel.novelName, sel.episode), "utf-8"));
    return Array.isArray(value) ? value as VisualFunctionRecord[] : [];
  } catch {
    return [];
  }
};

const createRecordWriter = (sel: NovelSelection, records: VisualFunctionRecord[]) => {
  let pending = Promise.resolve();
  return (): Promise<void> => {
    pending = pending.then(() => writeFunctionRecords(sel, records));
    return pending;
  };
};

const runWithConcurrency = async <T, R>(
  values: readonly T[],
  limit: number,
  task: (value: T, index: number) => Promise<R>,
): Promise<R[]> => {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from({length: Math.min(Math.max(1, limit), values.length)}, async () => {
    while (true) {
      const index = cursor++;
      if (index >= values.length) return;
      results[index] = await task(values[index], index);
    }
  });
  await Promise.all(workers);
  return results;
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
    const nextStartFrame = instance.tags[index + 1]
      ? startFrameAt(instance.tags[index + 1].start)
      : video.durationFrames;
    const desiredEnd = frame(Math.max(tag.end + TRAILING_VISIBLE_SECONDS, tag.start + MIN_VISIBLE_SECONDS));
    return {
      key: `${instance.instanceKey}-split-${index + 1}`,
      instance, call, rootFrame, startFrame,
      endFrame: Math.min(
        video.durationFrames,
        Math.max(startFrame + 1, Math.min(desiredEnd, Math.max(startFrame + 1, nextStartFrame - 1))),
      ),
      sourceText: tag.text,
      order: tag.documentOrder,
    };
  });
};

const resolveSceneIntervals = (candidates: WindowCandidate[]): WindowCandidate[] => {
  if (!candidates.length) return [];
  const boundaries = [...new Set(candidates.flatMap((candidate) => [candidate.startFrame, candidate.endFrame]))]
    .sort((a, b) => a - b);
  const intervals: WindowCandidate[] = [];
  for (let index = 0; index < boundaries.length - 1; index++) {
    const startFrame = boundaries[index];
    const endFrame = boundaries[index + 1];
    if (endFrame <= startFrame) continue;
    const winner = candidates
      .filter((candidate) => candidate.startFrame <= startFrame && candidate.endFrame >= endFrame)
      .sort((left, right) =>
        right.instance.depth - left.instance.depth
        || right.startFrame - left.startFrame
        || right.order - left.order,
      )[0];
    if (!winner) continue;
    const previous = intervals.at(-1);
    if (previous && previous.key === winner.key && previous.endFrame === startFrame) previous.endFrame = endFrame;
    else intervals.push({...winner, startFrame, endFrame});
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

const directedGraphTopologyErrors = (
  call: ResolvedMgFunctionCall,
  instance: MgInstanceInfo,
): string[] => {
  if (instance.tag !== "directed-graph") return [];
  const graph = instance.graph;
  if (!graph) return ["HTML directed-graph 缺少已审核的 nodes/edges 拓扑"];
  const errors: string[] = [];
  const rawNodes = call.arguments.nodes;
  const rawEdges = call.arguments.edges;
  if (!Array.isArray(rawNodes) || rawNodes.length !== graph.nodes.length) {
    errors.push(`Function Call 的 nodes 数量必须为 ${graph.nodes.length}`);
  } else {
    rawNodes.forEach((raw, index) => {
      const node = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
      const expectedId = directedGraphNodeId(index);
      if (node.id !== expectedId) errors.push(`nodes[${index}].id 必须保持为 ${expectedId}`);
      if (node.label !== graph.nodes[index]) errors.push(`nodes[${index}].label 不得修改 HTML 拓扑文字`);
    });
  }
  if (!Array.isArray(rawEdges) || rawEdges.length !== graph.edges.length) {
    errors.push(`Function Call 的 edges 数量必须为 ${graph.edges.length}`);
  } else {
    rawEdges.forEach((raw, index) => {
      const edge = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
      const [from, to] = graph.edges[index];
      if (edge.from !== directedGraphNodeId(from) || edge.to !== directedGraphNodeId(to)) {
        errors.push(`edges[${index}] 必须保持 HTML 中的 ${directedGraphNodeId(from)} -> ${directedGraphNodeId(to)}`);
      }
    });
  }
  return errors;
};

const buildScenes = (
  calls: ResolvedMgFunctionCall[],
  instances: Map<string, MgInstanceInfo>,
  video: MgVideoInfo,
): MgScenePlan[] => {
  const allWindows = calls.flatMap((call) => instanceWindows(call, instances.get(call.instanceKey)!, video));
  const sceneWindows = resolveSceneIntervals(allWindows.filter((candidate) => candidate.call.layerRole === "scene"));
  const overlayWindows = allWindows.filter((candidate) => candidate.call.layerRole === "overlay");
  const ordered = [
    ...sceneWindows.sort((left, right) => left.startFrame - right.startFrame || left.order - right.order),
    ...overlayWindows.sort((left, right) =>
      left.startFrame - right.startFrame
      || left.instance.depth - right.instance.depth
      || left.order - right.order,
    ),
  ];
  return ordered.map((candidate, index) => placementFor(candidate, index + 1, video));
};

/** Pure compatibility entry retained for existing callers. */
export const compileMgScenes = buildScenes;

const validateResolvedCall = (
  call: ResolvedMgFunctionCall,
  instance: MgInstanceInfo,
  videoDuration: number,
): void => {
  const errors: string[] = [];
  if (!mgProvider.isToolAllowed({htmlTag: instance.tag, group: instance.group, name: call.name})) {
    errors.push(`${instance.instanceKey} 的 <${instance.tag}> group=${instance.group} 错用了 ${call.name}`);
  }
  if (call.htmlTag !== instance.tag) errors.push(`HTML 标签应为 ${instance.tag}，实际为 ${call.htmlTag}`);
  if (call.group !== instance.group) errors.push(`group 应为 ${instance.group}，实际为 ${call.group}`);
  if (call.order !== instance.order) {
    errors.push(`order 应为 ${instance.order ?? "null"}，实际为 ${call.order ?? "null"}`);
  }
  errors.push(...directedGraphTopologyErrors(call, instance));
  const rootAt = instance.tags[0].start;
  if (!Number.isFinite(call.at) || Math.abs(call.at - rootAt) > AT_TOLERANCE_SECONDS) {
    errors.push(`根 at=${call.at}，应接近 ${rootAt}`);
  }
  for (const tag of instance.tags) {
    if (!call.elementAts.some((at) => Math.abs(at - tag.start) <= AT_TOLERANCE_SECONDS)) {
      errors.push(`没有元素 at 对应“${tag.text.slice(0, 24)}”的 ${tag.start}`);
    }
  }
  if (call.elementAts.some((at) => at > videoDuration + AT_TOLERANCE_SECONDS)) {
    errors.push("存在超出整集时长的元素 at");
  }
  if (call.htmlTag === "sc-longtake") {
    const segments = Array.isArray(call.arguments.segments) ? call.arguments.segments : [];
    const segmentAts = segments.map((segment: any) => Number(segment?.at));
    const endAt = instance.tags.at(-1)!.end;
    if (segmentAts.length < 2 || segmentAts.length > 8 || segmentAts.some((at) => !Number.isFinite(at))) {
      errors.push("接力一镜到底必须包含 2-8 个有效 segments");
    } else {
      if (Math.abs(segmentAts[0] - rootAt) > AT_TOLERANCE_SECONDS) {
        errors.push(`第一段 at=${segmentAts[0]}，应接近实例起点 ${rootAt}`);
      }
      if (segmentAts.some((at, index) => index > 0 && at >= endAt)) {
        errors.push(`后续分段 at 必须早于实例结束 ${endAt}`);
      }
    }
  }
  if (errors.length) throw new Error(errors.join("\n"));
};

const bindHostTimeline = (
  call: ResolvedMgFunctionCall,
  instance: MgInstanceInfo,
): ResolvedMgFunctionCall => {
  if (!isGeneratedVideoTag(call.htmlTag)) return call;
  const rootAt = instance.tags[0].start;
  const argumentsWithoutAt = call.htmlTag === "sc-longtake"
    ? {...call.arguments, at: rootAt}
    : Object.fromEntries(
      Object.entries(call.arguments).filter(([key]) => key !== "at"),
    );
  const renderSpec = call.render.spec && typeof call.render.spec === "object"
    ? call.htmlTag === "sc-longtake"
      ? {...call.render.spec as Record<string, unknown>, at: rootAt}
      : Object.fromEntries(
        Object.entries(call.render.spec as Record<string, unknown>).filter(([key]) => key !== "at"),
      )
    : call.render.spec;
  const elementAts = call.htmlTag === "sc-longtake"
    ? [rootAt, ...(Array.isArray(argumentsWithoutAt.segments)
      ? argumentsWithoutAt.segments.map((segment: any) => Number(segment?.at)).filter(Number.isFinite)
      : [])]
    : [rootAt];
  return {
    ...call,
    arguments: argumentsWithoutAt,
    at: rootAt,
    elementAts,
    render: {...call.render, spec: renderSpec},
  };
};

const scopeRootKey = (instance: MgInstanceInfo, instances: Map<string, MgInstanceInfo>): string => {
  let current = instance;
  while (current.parentInstance) {
    const parent = instances.get(current.parentInstance);
    if (!parent) break;
    current = parent;
  }
  return current.instanceKey;
};

const formatScopeTimedText = (members: MgInstanceInfo[], timeline: ArticleTimelineEntry[]): string => {
  const ranges = members
    .flatMap((instance) => instance.tags.map((tag) => ({start: tag.start, end: tag.end})))
    .sort((left, right) => left.start - right.start || left.end - right.end)
    .reduce<Array<{start: number; end: number}>>((merged, current) => {
      const previous = merged.at(-1);
      if (previous && current.start <= previous.end + 0.001) previous.end = Math.max(previous.end, current.end);
      else merged.push({...current});
      return merged;
    }, []);
  const selected = new Map<number, ArticleTimelineEntry>();
  for (const range of ranges) {
    for (const entry of timeline) {
      if (entry.start >= range.start - 0.001 && entry.end <= range.end + 0.001) selected.set(entry.index, entry);
    }
  }
  return [...selected.values()]
    .sort((left, right) => left.index - right.index)
    .map((entry) => `${entry.char}(${entry.start.toFixed(3)})`)
    .join("");
};

const formatScopePrompt = (
  root: MgInstanceInfo,
  members: MgInstanceInfo[],
  timeline: ArticleTimelineEntry[],
  referenceImages: string[],
  feedback: string,
): string => {
  const structure = [...members]
    .sort((left, right) => left.tags[0].documentOrder - right.tags[0].documentOrder)
    .map((instance) => {
      const indent = "  ".repeat(instance.depth - root.depth);
      const values = isGeneratedVideoTag(instance.tag)
        ? instance.tags.map((tag) => `「${tag.text}」`).join("；")
        : instance.mode === "together"
          ? `覆盖正文「${instance.tags[0].text}」；节点词 values=${JSON.stringify(instance.tags[0].values ?? [])}`
          : instance.tags.map((tag) => `value=${tag.value}「${tag.text}」`).join("；");
      return `${indent}- <${instance.tag}> group=${instance.group} order=${instance.order ?? "null"} depth=${instance.depth}：${values}`;
    })
    .join("\n");
  const graphContracts = members
    .filter((instance) => instance.tag === "directed-graph" && instance.graph)
    .map((instance) => [
      `\n已由人工审核的 directed-graph 固定拓扑（实例 ${instance.instanceKey}；Function Call 必须原样复制，不能增删、改名、改连线；只补每个节点和连线的绝对 at，以及每条边的 relation）：`,
      formatDirectedGraphTopology(instance.graph!),
      "节点 id 必须使用 n0、n1……，nodes 和 edges 的顺序也必须保持不变。",
    ].join("\n"))
    .join("\n");
  return [
    feedback ? `上次校验错误：\n${feedback}\n请重新处理当前 scope 的全部实例。` : "",
    `实例：<${root.tag}> / group=${root.group} / order=${root.order ?? "null"} / depth=${root.depth}`,
    "",
    "原文与真实绝对时间：",
    formatScopeTimedText(members, timeline),
    "",
    "子结构：",
    structure,
    graphContracts,
    "",
    ...(members.some((instance) => isGeneratedVideoTag(instance.tag)) ? [
      "可用参考图白名单：",
      referenceImages.length ? referenceImages.map((filePath) => `- ${filePath}`).join("\n") : "- 无",
      "",
    ] : []),
    "只处理这个 scope；每个逻辑实例恰好调用一次对应工具。",
  ].filter(Boolean).join("\n");
};

const listReferenceImages = async (sel: NovelSelection): Promise<string[]> => {
  const roots = [
    novelPaths.resourceDir(sel.novelName),
    novelPaths.charactersDir(sel.novelName),
    novelPaths.scenesDir(sel.novelName),
  ];
  const files: string[] = [];
  for (const root of roots) {
    const entries = await fs.readdir(root, {withFileTypes: true}).catch(() => []);
    for (const entry of entries) {
      if (entry.isFile() && /\.(?:png|jpe?g|webp)$/i.test(entry.name)) files.push(path.join(root, entry.name));
    }
  }
  return files.sort((left, right) => left.localeCompare(right, "zh-CN"));
};

const hashReferenceImages = async (referenceImages: readonly string[]): Promise<Map<string, string>> =>
  new Map(await Promise.all(referenceImages.map(async (filePath) => [
    path.resolve(filePath),
    createHash("sha256").update(await fs.readFile(filePath)).digest("hex"),
  ] as const)));

const requestScopeCalls = async (
  root: MgInstanceInfo,
  members: MgInstanceInfo[],
  timeline: ArticleTimelineEntry[],
  referenceImages: string[],
  feedback: string,
  videoDuration: number,
): Promise<ResolvedMgFunctionCall[]> => {
  const instances = new Map(members.map((instance) => [instance.instanceKey, instance]));
  const calls = new Map<string, ResolvedMgFunctionCall>();
  const tools: ToolDefinition[] = mgProvider.getPlanningTools(members.map((instance) => instance.tag)).map((definition) => ({
    name: definition.name,
    label: definition.label,
    description: definition.description,
    parameters: definition.parameters as any,
    execute: async (toolCallId: string, params: Record<string, unknown>) => {
      const raw: RawMgFunctionCall = {id: toolCallId, name: definition.name, arguments: params};
      const providerCall = resolveMgFunctionCall(raw);
      const instance = instances.get(providerCall.instanceKey);
      if (!instance) throw new Error(`当前 scope 不包含实例 ${providerCall.instanceKey}`);
      const resolved = bindHostTimeline(providerCall, instance);
      if (calls.has(resolved.instanceKey)) throw new Error(`${resolved.instanceKey} 已调用过一次`);
      validateResolvedCall(resolved, instance, videoDuration);
      calls.set(resolved.instanceKey, resolved);
      return {
        content: [{type: "text" as const, text: `任务 ${hashId(`${root.instanceKey}:${resolved.instanceKey}`)} 已接受`}],
        details: {},
      };
    },
  }));
  tools.unshift(searchWebTool);

  await runSubAgent(
    tools,
    `${mgProvider.getPlanningInstructions()}\n\n${mgProvider.getTemplatePlanningInstructions(members.map((instance) => instance.tag))}\n\n你只接收当前 scope 的原文和时间，不得补写其他正文。需要网络素材时必须先完成搜索和素材选择，再调用 MG Function Calling。工具调用被接受后会进入代码维护的视频任务队列。`,
    formatScopePrompt(root, members, timeline, referenceImages, feedback),
    `[视觉 Function Calling ${root.instanceKey}]`,
    [],
  );
  const missing = members.filter((instance) => !calls.has(instance.instanceKey));
  if (missing.length) throw new Error(`缺少 Function Call: ${missing.map((item) => item.instanceKey).join(", ")}`);
  return members.map((instance) => calls.get(instance.instanceKey)!);
};

const runScope = async (
  root: MgInstanceInfo,
  members: MgInstanceInfo[],
  timeline: ArticleTimelineEntry[],
  referenceImages: string[],
  videoDuration: number,
): Promise<ResolvedMgFunctionCall[]> => {
  let feedback = "";
  let lastError: unknown;
  for (let attempt = 1; attempt <= SCOPE_MAX_ATTEMPTS; attempt++) {
    try {
      console.log(`[视觉 Agent] ${root.instanceKey} 第 ${attempt}/${SCOPE_MAX_ATTEMPTS} 次`);
      return await requestScopeCalls(root, members, timeline, referenceImages, feedback, videoDuration);
    } catch (error) {
      lastError = error;
      feedback = error instanceof Error ? error.message : String(error);
      console.warn(`[视觉 Agent] ${root.instanceKey} 未通过: ${feedback}`);
    }
  }
  throw lastError ?? new Error(`${root.instanceKey} Function Calling 失败`);
};

const ownTargetWindow = (instance: MgInstanceInfo, video: MgVideoInfo): {startFrame: number; endFrame: number} => {
  const start = instance.tags[0].start;
  const last = instance.tags.at(-1)!;
  const end = isGeneratedVideoTag(instance.tag)
    ? last.end
    : Math.max(last.end + TRAILING_VISIBLE_SECONDS, start + MIN_VISIBLE_SECONDS);
  const startFrame = Math.max(0, Math.min(video.durationFrames - 1, Math.round(start * video.fps)));
  const endFrame = Math.min(
    video.durationFrames,
    Math.max(startFrame + 1, Math.round(end * video.fps)),
  );
  return {startFrame, endFrame};
};

const targetWindow = (
  instance: MgInstanceInfo,
  instances: Map<string, MgInstanceInfo>,
  video: MgVideoInfo,
  cache = new Map<string, {startFrame: number; endFrame: number}>(),
): {startFrame: number; endFrame: number} => {
  const existing = cache.get(instance.instanceKey);
  if (existing) return existing;
  const own = ownTargetWindow(instance, video);
  if (!instance.parentInstance) {
    cache.set(instance.instanceKey, own);
    return own;
  }
  const parent = instances.get(instance.parentInstance);
  if (!parent) throw new Error(`${instance.instanceKey} 找不到父实例 ${instance.parentInstance}`);
  const parentWindow = targetWindow(parent, instances, video, cache);
  const startFrame = Math.max(own.startFrame, parentWindow.startFrame);
  const endFrame = Math.min(own.endFrame, parentWindow.endFrame);
  if (endFrame <= startFrame) {
    throw new Error(`${instance.instanceKey} 与父实例 ${parent.instanceKey} 没有有效的时间交集`);
  }
  const result = {startFrame, endFrame};
  cache.set(instance.instanceKey, result);
  return result;
};

type FrameWindow = {startFrame: number; endFrame: number};

const intersectWindows = (left: FrameWindow[], right: FrameWindow[]): FrameWindow[] => {
  const intersections: FrameWindow[] = [];
  for (const a of left) {
    for (const b of right) {
      const startFrame = Math.max(a.startFrame, b.startFrame);
      const endFrame = Math.min(a.endFrame, b.endFrame);
      if (endFrame > startFrame) intersections.push({startFrame, endFrame});
    }
  }
  return intersections.sort((a, b) => a.startFrame - b.startFrame || a.endFrame - b.endFrame);
};

const ownActiveWindows = (
  instance: MgInstanceInfo,
  video: MgVideoInfo,
  target: FrameWindow,
): FrameWindow[] => {
  if (instance.mode !== "split") return [target];
  return instance.tags.flatMap((tag, index) => {
    const startFrame = Math.max(target.startFrame, Math.round(tag.start * video.fps));
    const nextStartFrame = instance.tags[index + 1]
      ? Math.round(instance.tags[index + 1].start * video.fps)
      : target.endFrame;
    const desiredEndFrame = Math.round(
      Math.max(tag.end + TRAILING_VISIBLE_SECONDS, tag.start + MIN_VISIBLE_SECONDS) * video.fps,
    );
    const endFrame = Math.min(target.endFrame, desiredEndFrame, Math.max(startFrame + 1, nextStartFrame - 1));
    if (endFrame <= startFrame) return [];
    return [{startFrame, endFrame}];
  });
};

const effectiveActiveWindows = (
  instance: MgInstanceInfo,
  instances: Map<string, MgInstanceInfo>,
  video: MgVideoInfo,
  windowCache: Map<string, FrameWindow>,
  activeCache = new Map<string, FrameWindow[]>(),
): FrameWindow[] => {
  const existing = activeCache.get(instance.instanceKey);
  if (existing) return existing;
  const target = targetWindow(instance, instances, video, windowCache);
  let windows = ownActiveWindows(instance, video, target);
  if (instance.parentInstance) {
    const parent = instances.get(instance.parentInstance);
    if (!parent) throw new Error(`${instance.instanceKey} 找不到父实例 ${instance.parentInstance}`);
    windows = intersectWindows(windows, effectiveActiveWindows(parent, instances, video, windowCache, activeCache));
  }
  if (!windows.length) throw new Error(`${instance.instanceKey} 与祖先实例没有有效的活动窗口交集`);
  activeCache.set(instance.instanceKey, windows);
  return windows;
};

const localActiveWindows = (
  instance: MgInstanceInfo,
  instances: Map<string, MgInstanceInfo>,
  video: MgVideoInfo,
  windowCache: Map<string, FrameWindow>,
): FrameWindow[] => {
  const target = targetWindow(instance, instances, video, windowCache);
  const effective = effectiveActiveWindows(instance, instances, video, windowCache);
  const needsMask = instance.mode === "split" || effective.some((window) =>
    window.startFrame !== target.startFrame || window.endFrame !== target.endFrame,
  );
  return needsMask ? effective.map((window) => ({
    startFrame: window.startFrame - target.startFrame,
    endFrame: window.endFrame - target.startFrame,
  })) : [];
};

const describeTask = (
  call: ResolvedMgFunctionCall,
  instance: MgInstanceInfo,
  instances: Map<string, MgInstanceInfo>,
  video: MgVideoInfo,
  windowCache: Map<string, {startFrame: number; endFrame: number}>,
  referenceImageHashes: ReadonlyMap<string, string>,
): {signature: string; startFrame: number; endFrame: number} => {
  const {startFrame, endFrame} = targetWindow(instance, instances, video, windowCache);
  const referenceState = String(call.arguments.reference_image_state ?? "none");
  const referencePath = referenceState === "existing"
    ? path.resolve(String(call.arguments.reference_image_path ?? ""))
    : undefined;
  const existingReferenceImageHash = referencePath
    ? referenceImageHashes.get(referencePath)
    : undefined;
  if (referencePath && !existingReferenceImageHash) {
    throw new Error(`${instance.instanceKey} 的已有参考图不在白名单或无法读取`);
  }
  const activeWindows = localActiveWindows(instance, instances, video, windowCache);
  return {
    signature: taskSignature({
      cacheVersion: VISUAL_RENDER_CACHE_VERSION,
      instanceKey: call.instanceKey,
      scopeKey: scopeRootKey(instance, instances),
      ...(instance.parentInstance ? {parentInstance: instance.parentInstance} : {}),
      depth: instance.depth,
      mode: instance.mode,
      name: call.name,
      arguments: call.arguments,
      sourceTags: instance.tags.map(({text, value, start, end}) => ({text, ...(value === undefined ? {} : {value}), start, end})),
      render: call.render,
      startFrame,
      endFrame,
      layerRole: call.layerRole,
      width: video.width,
      height: video.height,
      fps: video.fps,
      ...(existingReferenceImageHash ? {existingReferenceImageHash} : {}),
      ...(activeWindows.length ? {activeWindows} : {}),
    }),
    startFrame,
    endFrame,
  };
};

const zIndexFor = (
  instance: MgInstanceInfo,
  call: ResolvedMgFunctionCall,
  orderSpan: number,
): number => instance.depth * orderSpan * 2
  + (call.layerRole === "overlay" ? orderSpan : 0)
  + instance.tags[0].documentOrder;

const reuseValidClip = async (filePath: string, durationFrames: number, fps: number): Promise<boolean> => {
  if (!fsSync.existsSync(filePath)) return false;
  try {
    await assertMgVideoFrames(filePath, durationFrames, fps);
    return true;
  } catch {
    await fs.rm(filePath, {force: true});
    return false;
  }
};

const selectReferenceImage = async (
  sel: NovelSelection,
  call: ResolvedMgFunctionCall,
  referenceImages: string[],
  clipsDir: string,
  fileStem: string,
  fallbackPrompt = "",
): Promise<string> => {
  const args = call.arguments as Record<string, unknown>;
  const state = String(args.reference_image_state ?? "none");
  if (state === "existing") {
    const requested = path.resolve(String(args.reference_image_path ?? ""));
    const allowed = referenceImages.find((candidate) => path.resolve(candidate) === requested);
    if (!allowed || !fsSync.existsSync(allowed)) throw new Error("参考图不在当前白名单或文件不存在");
    return allowed;
  }
  const referencePath = path.join(clipsDir, `${fileStem}_reference.png`);
  const prompt = state === "generate"
    ? String(args.reference_image_prompt ?? "").trim()
    : fallbackPrompt.trim() || String(args.video_prompt ?? "").trim();
  if (!prompt) throw new Error("缺少参考图或首帧提示词");
  if (!fsSync.existsSync(referencePath)) {
    await generateVisualTagImage(
      `${prompt} Single clean cinematic first frame. No subtitles, captions, logos or watermarks.`,
      [],
      referencePath,
      sel.aspectRatio,
    );
  }
  return referencePath;
};

const renderScVideoTask = async (
  sel: NovelSelection,
  call: ResolvedMgFunctionCall,
  record: VisualFunctionRecord,
  referenceImages: string[],
  clipsDir: string,
  video: MgVideoInfo,
  update: (status: VisualFunctionStatus, extra?: Partial<VisualFunctionRecord>) => Promise<void>,
): Promise<string> => {
  const stem = clipFileStem(call.instanceKey, record.taskSignature);
  const generatedPath = path.join(clipsDir, `${stem}_generated.mp4`);
  const outputPath = path.join(clipsDir, `${stem}.mp4`);
  if (await reuseValidClip(outputPath, record.endFrame - record.startFrame, video.fps)) return outputPath;
  await update("preparing_reference");
  const imagePath = await selectReferenceImage(sel, call, referenceImages, clipsDir, stem);
  await update("generating_video");
  const prompt = String(call.arguments.video_prompt ?? "").trim();
  if (!prompt) throw new Error("<sc-video> Function Call 缺少 video_prompt");
  await generateVisualTagVideo(
    imagePath,
    `${prompt} No background music, speech, subtitles, captions, text overlays, logos or watermarks.`,
    generatedPath,
    sel.aspectRatio,
    record.duration,
  );
  await update("normalizing");
  await normalizeVisualTagVideo(
    generatedPath,
    outputPath,
    video.width,
    video.height,
    video.fps,
    record.endFrame - record.startFrame,
  );
  await assertMgVideoFrames(outputPath, record.endFrame - record.startFrame, video.fps);
  return outputPath;
};

export type ScLongtakeSegmentWindow = {
  index: number;
  startFrame: number;
  endFrame: number;
};

/** Convert absolute segment timestamps into adjacent, non-empty frame windows. */
export const computeScLongtakeSegmentWindows = (
  segments: unknown,
  startFrame: number,
  endFrame: number,
  fps: number,
): ScLongtakeSegmentWindow[] => {
  if (!Array.isArray(segments) || segments.length < 2 || segments.length > 8) {
    throw new Error("<sc-longtake> 必须包含 2-8 个 segments");
  }
  if (!Number.isInteger(startFrame) || !Number.isInteger(endFrame) || endFrame <= startFrame) {
    throw new Error("<sc-longtake> 的主时间窗口无效");
  }
  if (!Number.isFinite(fps) || fps <= 0) throw new Error("<sc-longtake> 的帧率无效");

  const timestamps = segments.map((segment: any, index) => {
    const at = Number(segment?.at);
    if (!Number.isFinite(at) || at < 0) throw new Error(`<sc-longtake> segments[${index}].at 无效`);
    return at;
  });
  for (let index = 1; index < timestamps.length; index++) {
    if (timestamps[index] <= timestamps[index - 1]) {
      throw new Error("<sc-longtake> segments.at 必须严格递增");
    }
  }
  if (Math.abs(timestamps[0] - startFrame / fps) > AT_TOLERANCE_SECONDS) {
    throw new Error("<sc-longtake> 第一段 at 必须接近主时间窗口起点");
  }

  const starts = [
    startFrame,
    ...timestamps.slice(1).map((at) => Math.round(at * fps)),
  ];
  return starts.map((segmentStart, index) => {
    const segmentEnd = index + 1 < starts.length ? starts[index + 1] : endFrame;
    if (segmentStart < startFrame || segmentStart >= endFrame || segmentEnd <= segmentStart) {
      throw new Error(`<sc-longtake> 第 ${index + 1} 段没有有效的帧区间`);
    }
    return {index, startFrame: segmentStart, endFrame: segmentEnd};
  });
};

const concatScLongtakeSegments = async (
  segmentPaths: string[],
  outputPath: string,
): Promise<void> => {
  if (!segmentPaths.length) throw new Error("<sc-longtake> 没有可拼接的视频片段");
  const directory = path.dirname(outputPath);
  const listPath = `${outputPath}.concat.txt`;
  const tempOutput = `${outputPath}.concat.mp4`;
  const list = segmentPaths
    .map((segmentPath) => `file '${path.basename(segmentPath).replace(/'/g, "'\\''")}'`)
    .join("\n");
  await fs.writeFile(listPath, `${list}\n`, "utf-8");
  try {
    await runMediaCommand(
      "ffmpeg",
      ["-y", "-f", "concat", "-safe", "0", "-i", path.basename(listPath), "-c", "copy", path.basename(tempOutput)],
      directory,
    );
    await fs.rename(tempOutput, outputPath);
  } finally {
    await fs.rm(listPath, {force: true});
    await fs.rm(tempOutput, {force: true});
  }
};

const renderScLongtakeTask = async (
  sel: NovelSelection,
  call: ResolvedMgFunctionCall,
  record: VisualFunctionRecord,
  referenceImages: string[],
  clipsDir: string,
  video: MgVideoInfo,
  update: (status: VisualFunctionStatus, extra?: Partial<VisualFunctionRecord>) => Promise<void>,
): Promise<string> => {
  const stem = clipFileStem(call.instanceKey, record.taskSignature);
  const outputPath = path.join(clipsDir, `${stem}.mp4`);
  const targetFrames = record.endFrame - record.startFrame;
  if (await reuseValidClip(outputPath, targetFrames, video.fps)) return outputPath;

  const args = call.arguments as Record<string, unknown>;
  const segments = Array.isArray(args.segments) ? args.segments : [];
  const windows = computeScLongtakeSegmentWindows(segments, record.startFrame, record.endFrame, video.fps);
  const normalizedPaths: string[] = [];
  let previousTail: string | undefined;

  for (const window of windows) {
    const segmentNumber = String(window.index + 1).padStart(2, "0");
    const segmentStem = `${stem}_seg${segmentNumber}`;
    const generatedPath = path.join(clipsDir, `${segmentStem}_generated.mp4`);
    const normalizedPath = path.join(clipsDir, `${segmentStem}.mp4`);
    const tailPath = path.join(clipsDir, `${segmentStem}_tail.png`);
    const segmentFrames = window.endFrame - window.startFrame;
    const segment = segments[window.index] as Record<string, unknown>;
    const basePrompt = String(segment?.video_prompt ?? "").trim();
    if (!basePrompt) throw new Error(`<sc-longtake> segments[${window.index}] 缺少 video_prompt`);

    const validSegment = await reuseValidClip(normalizedPath, segmentFrames, video.fps);
    if (!validSegment) {
      await fs.rm(tailPath, {force: true});
      let firstFrame = previousTail;
      if (!firstFrame) {
        await update("preparing_reference");
        firstFrame = await selectReferenceImage(sel, call, referenceImages, clipsDir, stem, basePrompt);
      }
      const continuityPrompt = window.index === 0
        ? basePrompt
        : `Start exactly from the supplied first frame and continue the same uninterrupted shot. Preserve the same subject identity, camera axis, lens, viewpoint, lighting, spatial layout, and motion direction; do not reset the composition or introduce a cut. ${basePrompt}`;
      await update("generating_video");
      if (!fsSync.existsSync(generatedPath)) {
        await generateVisualTagVideo(
          firstFrame,
          `${continuityPrompt} No background music, speech, subtitles, captions, text overlays, logos or watermarks.`,
          generatedPath,
          sel.aspectRatio,
          segmentFrames / video.fps,
        );
      }
      await update("normalizing");
      await normalizeVisualTagVideo(
        generatedPath,
        normalizedPath,
        video.width,
        video.height,
        video.fps,
        segmentFrames,
      );
      await assertMgVideoFrames(normalizedPath, segmentFrames, video.fps);
    }
    if (!fsSync.existsSync(normalizedPath)) throw new Error(`<sc-longtake> 第 ${window.index + 1} 段生成失败`);
    if (!fsSync.existsSync(tailPath) && !(await extractLastFrame(normalizedPath, tailPath))) {
      throw new Error(`<sc-longtake> 第 ${window.index + 1} 段尾帧提取失败`);
    }
    normalizedPaths.push(normalizedPath);
    previousTail = tailPath;
  }

  await concatScLongtakeSegments(normalizedPaths, outputPath);
  await assertMgVideoFrames(outputPath, targetFrames, video.fps);
  return outputPath;
};

const renderTemplateTask = async (
  sel: NovelSelection,
  call: ResolvedMgFunctionCall,
  record: VisualFunctionRecord,
  instance: MgInstanceInfo,
  instances: Map<string, MgInstanceInfo>,
  windowCache: Map<string, {startFrame: number; endFrame: number}>,
  clipsDir: string,
  video: MgVideoInfo,
  update: (status: VisualFunctionStatus, extra?: Partial<VisualFunctionRecord>) => Promise<void>,
): Promise<string> => {
  const activeWindows = localActiveWindows(instance, instances, video, windowCache);
  const needsAlpha = call.layerRole === "overlay" || activeWindows.length > 0;
  const extension = needsAlpha ? ".mov" : ".mp4";
  const outputPath = path.join(clipsDir, `${clipFileStem(call.instanceKey, record.taskSignature)}${extension}`);
  if (await reuseValidClip(outputPath, record.endFrame - record.startFrame, video.fps)) return outputPath;
  await update("rendering_template");
  const {renderVisualTagTemplateClip} = await import("./renderer.js");
  await renderVisualTagTemplateClip(
    sel,
    `${call.instanceKey}:${record.taskSignature}`,
    call.render,
    video.width,
    video.height,
    record.endFrame - record.startFrame,
    video.fps,
    outputPath,
    {
      ...(activeWindows.length ? {activeWindows} : {}),
      forceAlpha: needsAlpha,
    },
  );
  await assertMgVideoFrames(outputPath, record.endFrame - record.startFrame, video.fps);
  return outputPath;
};

const planInstancesFor = (instances: Map<string, MgInstanceInfo>): MgPlan["instances"] =>
  [...instances.values()].map((instance) => ({
    instanceKey: instance.instanceKey,
    group: instance.group,
    tag: instance.tag,
    ...(instance.order === undefined ? {} : {order: instance.order}),
    mode: instance.mode,
    tagCount: instance.tags.length,
    starts: instance.tags.map((tag) => tag.start),
  }));

const compositionNodesFor = (
  records: VisualFunctionRecord[],
  callsByInstance: Map<string, ResolvedMgFunctionCall>,
  instances: Map<string, MgInstanceInfo>,
): MgCompositionNode[] => {
  const maxDocumentOrder = Math.max(0, ...[...instances.values()].map((instance) => instance.tags[0].documentOrder));
  const orderSpan = maxDocumentOrder + 1;
  return records.map((record) => {
    const call = callsByInstance.get(record.instanceKey);
    const instance = instances.get(record.instanceKey);
    if (!call || !instance || !record.videoPath) {
      throw new Error(`${record.instanceKey} 缺少合成节点所需的 Function Call、实例或视频`);
    }
    return {
      nodeId: record.instanceKey,
      ...(instance.parentInstance ? {parentNodeId: instance.parentInstance} : {}),
      videoPath: record.videoPath,
      startFrame: record.startFrame,
      endFrame: record.endFrame,
      zIndex: zIndexFor(instance, call, orderSpan),
    };
  });
};

const sameJson = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

/**
 * Read-only resume audit. It replays Provider parsing and task signatures,
 * then checks every completed clip and both persisted composition documents.
 */
export async function isEssayMgPlanCurrent(sel: NovelSelection): Promise<boolean> {
  try {
    const htmlPath = novelPaths.mgAnnotation(sel.novelName, sel.episode);
    const timelinePath = novelPaths.articleTimeline(sel.novelName, sel.episode);
    const articlePath = novelPaths.cleanedText(sel.novelName, sel.episode);
    const audioPath = novelPaths.episodeAlignedAudio(sel.novelName, sel.episode);
    const [
      html,
      timelineRaw,
      article,
      audioDuration,
      referenceImages,
      recordsRaw,
      planRaw,
      bundleRaw,
    ] = await Promise.all([
      fs.readFile(htmlPath, "utf-8"),
      fs.readFile(timelinePath, "utf-8"),
      fs.readFile(articlePath, "utf-8"),
      getMediaDuration(audioPath),
      listReferenceImages(sel),
      fs.readFile(novelPaths.mgFunctionCalls(sel.novelName, sel.episode), "utf-8"),
      fs.readFile(novelPaths.mgPlan(sel.novelName, sel.episode), "utf-8"),
      fs.readFile(novelPaths.mgRenderBundle(sel.novelName, sel.episode), "utf-8"),
    ]);
    validateMgAnnotationHtml(html, article);
    const timeline = JSON.parse(timelineRaw) as ArticleTimelineEntry[];
    const records = JSON.parse(recordsRaw) as VisualFunctionRecord[];
    const plan = JSON.parse(planRaw) as MgPlan;
    const bundle = JSON.parse(bundleRaw) as MgRenderBundle;
    if (!Array.isArray(records)) return false;

    const instances = locateMgInstances(html, timeline, article);
    if (records.length !== instances.size) return false;
    const recordsByInstance = new Map(records.map((record) => [record.instanceKey, record]));
    if (recordsByInstance.size !== records.length) return false;

    const settings = getVisualTagVideoSettings(sel.aspectRatio);
    const video: MgVideoInfo = {
      ...settings,
      duration: audioDuration,
      durationFrames: Math.max(1, Math.ceil(audioDuration * settings.fps)),
    };
    const referenceImageHashes = await hashReferenceImages(referenceImages);
    const windowCache = new Map<string, {startFrame: number; endFrame: number}>();
    const callsByInstance = new Map<string, ResolvedMgFunctionCall>();
    const clipsToCheck: Array<{path: string; frames: number}> = [];

    for (const instance of instances.values()) {
      const record = recordsByInstance.get(instance.instanceKey);
      if (!record || record.status !== "completed" || !record.videoPath || !fsSync.existsSync(record.videoPath)) {
        return false;
      }
      const providerCall = resolveMgFunctionCall({id: record.id, name: record.name, arguments: record.arguments});
      const call = bindHostTimeline(providerCall, instance);
      validateResolvedCall(call, instance, video.duration);
      const current = describeTask(call, instance, instances, video, windowCache, referenceImageHashes);
      if (
        record.taskSignature !== current.signature
        || record.scopeKey !== scopeRootKey(instance, instances)
        || record.htmlTag !== call.htmlTag
        || record.group !== call.group
        || record.order !== call.order
        || record.startFrame !== current.startFrame
        || record.endFrame !== current.endFrame
        || record.layerRole !== call.layerRole
      ) return false;
      callsByInstance.set(instance.instanceKey, call);
      clipsToCheck.push({path: record.videoPath, frames: current.endFrame - current.startFrame});
    }

    const clipChecks = await runWithConcurrency(clipsToCheck, SCOPE_CONCURRENCY, async (clip) => {
      try {
        await assertMgVideoFrames(clip.path, clip.frames, video.fps);
        return true;
      } catch {
        return false;
      }
    });
    if (clipChecks.some((valid) => !valid)) return false;

    const nodes = compositionNodesFor(records, callsByInstance, instances);
    const expectedBundle: MgRenderBundle = {
      version: 4,
      width: video.width,
      height: video.height,
      fps: video.fps,
      durationFrames: video.durationFrames,
      nodes,
    };
    const expectedSource: MgPlan["source"] = {
      ...video,
      html: htmlPath,
      timeline: timelinePath,
      audio: audioPath,
    };
    return plan.version === 4
      && sameJson(plan.source, expectedSource)
      && sameJson(plan.instances, planInstancesFor(instances))
      && sameJson(plan.functionCalls, records)
      && sameJson(plan.nodes, nodes)
      && sameJson(bundle, expectedBundle);
  } catch {
    return false;
  }
}

export async function planEssayMg(sel: NovelSelection): Promise<string> {
  const htmlPath = novelPaths.mgAnnotation(sel.novelName, sel.episode);
  const timelinePath = novelPaths.articleTimeline(sel.novelName, sel.episode);
  const articlePath = novelPaths.cleanedText(sel.novelName, sel.episode);
  const audioPath = novelPaths.episodeAlignedAudio(sel.novelName, sel.episode);
  const [html, timelineRaw, article, audioDuration, referenceImages] = await Promise.all([
    fs.readFile(htmlPath, "utf-8"),
    fs.readFile(timelinePath, "utf-8"),
    fs.readFile(articlePath, "utf-8"),
    getMediaDuration(audioPath),
    listReferenceImages(sel),
  ]);
  const referenceImageHashes = await hashReferenceImages(referenceImages);
  const annotation = validateMgAnnotationHtml(html, article);
  const timeline = JSON.parse(timelineRaw) as ArticleTimelineEntry[];
  const instances = locateMgInstances(html, timeline, article);
  const settings = getVisualTagVideoSettings(sel.aspectRatio);
  const video: MgVideoInfo = {
    ...settings,
    duration: audioDuration,
    durationFrames: Math.max(1, Math.ceil(audioDuration * settings.fps)),
  };

  const scopes = new Map<string, MgInstanceInfo[]>();
  for (const instance of instances.values()) {
    const rootKey = scopeRootKey(instance, instances);
    const current = scopes.get(rootKey) ?? [];
    current.push(instance);
    scopes.set(rootKey, current);
  }
  const roots = [...scopes.keys()]
    .map((key) => instances.get(key)!)
    .sort((left, right) => left.tags[0].documentOrder - right.tags[0].documentOrder);

  const mgDir = novelPaths.mgDir(sel.novelName, sel.episode);
  const clipsDir = novelPaths.mgClipsDir(sel.novelName, sel.episode);
  await Promise.all([
    fs.mkdir(mgDir, {recursive: true}),
    fs.mkdir(clipsDir, {recursive: true}),
  ]);

  const previousRecords = await readFunctionRecords(sel);
  const previousByInstance = new Map(previousRecords.map((record) => [record.instanceKey, record]));
  const windowCache = new Map<string, {startFrame: number; endFrame: number}>();
  const reusableCalls = new Map<string, ResolvedMgFunctionCall>();
  for (const root of roots) {
    const members = scopes.get(root.instanceKey)!;
    const scopeCalls: ResolvedMgFunctionCall[] = [];
    let complete = true;
    for (const instance of members) {
      const previous = previousByInstance.get(instance.instanceKey);
      if (!previous) {
        complete = false;
        break;
      }
      try {
        const providerCall = resolveMgFunctionCall({id: previous.id, name: previous.name, arguments: previous.arguments});
        const call = bindHostTimeline(providerCall, instance);
        validateResolvedCall(call, instance, video.duration);
        const current = describeTask(call, instance, instances, video, windowCache, referenceImageHashes);
        if (previous.taskSignature !== current.signature) {
          complete = false;
          break;
        }
        scopeCalls.push(call);
      } catch {
        complete = false;
        break;
      }
    }
    if (complete) {
      for (const call of scopeCalls) reusableCalls.set(call.instanceKey, call);
    }
  }

  const scopesToRun = roots.filter((root) =>
    scopes.get(root.instanceKey)!.some((instance) => !reusableCalls.has(instance.instanceKey)),
  );
  const freshCalls = annotation.instanceCount === 0 ? [] : (await runWithConcurrency(
    scopesToRun,
    SCOPE_CONCURRENCY,
    (root) => runScope(root, scopes.get(root.instanceKey)!, timeline, referenceImages, video.duration),
  )).flat();
  for (const call of freshCalls) reusableCalls.set(call.instanceKey, call);
  const resolvedCalls = [...instances.values()].map((instance) => {
    const call = reusableCalls.get(instance.instanceKey);
    if (!call) throw new Error(`缺少 ${instance.instanceKey} 的 Function Call`);
    return call;
  });

  const records: VisualFunctionRecord[] = resolvedCalls.map((call) => {
    const instance = instances.get(call.instanceKey)!;
    const {signature, startFrame, endFrame} = describeTask(
      call,
      instance,
      instances,
      video,
      windowCache,
      referenceImageHashes,
    );
    const activeWindows = localActiveWindows(instance, instances, video, windowCache);
    const previous = previousByInstance.get(call.instanceKey);
    const record: VisualFunctionRecord = {
      id: call.id,
      taskId: hashId(`${sel.novelName}:${sel.episode}:${call.instanceKey}:${signature}`),
      taskSignature: signature,
      scopeKey: scopeRootKey(instance, instances),
      name: call.name,
      instanceKey: call.instanceKey,
      htmlTag: call.htmlTag,
      group: call.group,
      ...(call.order === undefined ? {} : {order: call.order}),
      arguments: call.arguments,
      status: "queued",
      retries: 0,
      start: startFrame / video.fps,
      end: endFrame / video.fps,
      duration: (endFrame - startFrame) / video.fps,
      startFrame,
      endFrame,
      layerRole: call.layerRole,
      ...(activeWindows.length ? {activeWindows} : {}),
    };
    if (
      previous?.status === "completed"
      && previous.taskSignature === signature
      && previous.videoPath
      && fsSync.existsSync(previous.videoPath)
    ) {
      record.status = "completed";
      record.retries = previous.retries;
      record.videoPath = previous.videoPath;
    }
    return record;
  });
  const flushRecords = createRecordWriter(sel, records);
  await flushRecords();

  const updateRecord = async (
    index: number,
    status: VisualFunctionStatus,
    extra: Partial<VisualFunctionRecord> = {},
  ): Promise<void> => {
    Object.assign(records[index], extra, {status});
    await flushRecords();
  };

  const callsByInstance = new Map(resolvedCalls.map((call) => [call.instanceKey, call]));
  await runWithConcurrency(records, SCOPE_CONCURRENCY, async (record, index) => {
    const call = callsByInstance.get(record.instanceKey)!;
    if (record.status === "completed" && record.videoPath) {
      if (await reuseValidClip(record.videoPath, record.endFrame - record.startFrame, video.fps)) {
        console.log(`[视觉任务] 复用 ${record.instanceKey} -> ${path.basename(record.videoPath)}`);
        return;
      }
      await updateRecord(index, "queued", {videoPath: undefined});
    }
    let lastError: unknown;
    for (let attempt = 1; attempt <= MEDIA_MAX_ATTEMPTS; attempt++) {
      try {
        const videoPath = call.htmlTag === "sc-video"
          ? await renderScVideoTask(
            sel,
            call,
            record,
            referenceImages,
            clipsDir,
            video,
            (status, extra) => updateRecord(index, status, extra),
          )
          : call.htmlTag === "sc-longtake"
            ? await renderScLongtakeTask(
              sel,
              call,
              record,
              referenceImages,
              clipsDir,
              video,
              (status, extra) => updateRecord(index, status, extra),
            )
            : await renderTemplateTask(
            sel,
            call,
            record,
            instances.get(record.instanceKey)!,
            instances,
            windowCache,
            clipsDir,
            video,
            (status, extra) => updateRecord(index, status, extra),
          );
        await updateRecord(index, "completed", {videoPath, error: undefined, retries: attempt - 1});
        return;
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        await updateRecord(index, "failed", {error: message, retries: attempt});
        if (attempt < MEDIA_MAX_ATTEMPTS) {
          console.warn(`[视觉任务] ${record.instanceKey} 第 ${attempt}/${MEDIA_MAX_ATTEMPTS} 次失败，重试: ${message}`);
        }
      }
    }
    throw lastError ?? new Error(`${record.instanceKey} 视频任务失败`);
  });

  const nodes = compositionNodesFor(records, callsByInstance, instances);
  const bundle: MgRenderBundle = {
    version: 4,
    width: video.width,
    height: video.height,
    fps: video.fps,
    durationFrames: video.durationFrames,
    nodes,
  };
  const plan: MgPlan = {
    version: 4,
    source: {...video, html: htmlPath, timeline: timelinePath, audio: audioPath},
    instances: planInstancesFor(instances),
    functionCalls: records,
    nodes,
  };
  await Promise.all([
    fs.writeFile(novelPaths.mgPlan(sel.novelName, sel.episode), `${JSON.stringify(plan, null, 2)}\n`, "utf-8"),
    fs.writeFile(novelPaths.mgRenderBundle(sel.novelName, sel.episode), `${JSON.stringify(bundle, null, 2)}\n`, "utf-8"),
  ]);
  console.log(`[视觉规划] ${scopesToRun.length}/${roots.length} 个 Agent scope / ${records.length} 个 Function Call / ${nodes.length} 个合成节点`);
  return novelPaths.mgPlan(sel.novelName, sel.episode);
}
