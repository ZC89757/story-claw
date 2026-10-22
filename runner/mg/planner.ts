import fs from "node:fs/promises";
import fsSync from "node:fs";
import {createHash} from "node:crypto";
import path from "node:path";
import type {ToolDefinition} from "@mariozechner/pi-coding-agent";
import {runSubAgent} from "../../agent.js";
import {searchWebTool} from "../../tools/search-web.js";
import type {NovelSelection} from "../../ui/select.js";
import {getStoryVideoConfig} from "../../utils/story-video-config.js";
import {h3ClipCacheIdentity} from "../../utils/h3-clip.js";
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
import {getMgAnnotationWindow} from "./timing.js";
import {formatReviewedTopology, reviewedTopologyErrors} from "./reviewed-topology.js";
import {isGeneratedVideoTag, runVisualTaskQueue} from "./task-queue.js";
import type {
  MgCompositionNode,
  MgInstanceInfo,
  MgRenderBundle,
  MgScenePlan,
  MgVideoInfo,
  RawMgFunctionCall,
  ResolvedMgFunctionCall,
  VisualFunctionRecord,
  VisualFunctionStatus,
} from "./types.js";

const AT_TOLERANCE_SECONDS = 0.35;
const SCOPE_CONCURRENCY = 4;
const SCOPE_MAX_ATTEMPTS = 3;
const MEDIA_MAX_ATTEMPTS = 3;
const WEB_NEWS_REPLAN_MAX_ATTEMPTS = 3;
const VISUAL_RENDER_CACHE_VERSION = 3;

export type MgPlanRefreshOptions = {
  /** Re-call every Function Calling tool and render every instance using the existing HTML. */
  all?: boolean;
  /** Additional source context for this run; does not reuse previous Function Calls. */
  planningContext?: string;
  replanInstanceKeys?: readonly string[];
  rerenderInstanceKeys?: readonly string[];
  reuseGeneratedVideoInstanceKeys?: readonly string[];
  /** Called once, after local clips finish, only when an uncached generated video is needed. */
  beforeGeneratedVideo?: () => Promise<void>;
  /** Explicit preplanned calls, validated through the same Provider and reviewed HTML rules. */
  functionCalls?: readonly RawMgFunctionCall[];
  /** Trusted local render checkpoints accompanying those exact calls; timing and media are rechecked. */
  preparedClips?: readonly PreparedMgClip[];
};

export type PreparedMgClip = Pick<VisualFunctionRecord, "instanceKey" | "name" | "arguments" | "startFrame" | "endFrame"> & {videoPath: string};



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
  generatedVideoBackend?: unknown;
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

const cleanupUnreferencedClips = async (
  sel: NovelSelection,
  records: VisualFunctionRecord[],
): Promise<void> => {
  const clipsDir = novelPaths.mgClipsDir(sel.novelName, sel.episode);
  const referenced = new Set(records.map((record) => record.videoPath).filter(Boolean).map((file) => path.resolve(file!)));
  let entries: fsSync.Dirent[];
  try { entries = await fs.readdir(clipsDir, {withFileTypes: true}); } catch { return; }
  await Promise.all(entries
    .filter((entry) => entry.isFile() && !referenced.has(path.resolve(clipsDir, entry.name)))
    .map((entry) => fs.rm(path.join(clipsDir, entry.name), {force: true})));
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
  instances: Map<string, MgInstanceInfo>,
  video: MgVideoInfo,
): WindowCandidate[] => {
  const rootFrame = getMgAnnotationWindow(instance.tags, instances, video).startFrame;
  const groups = instance.mode === "together" ? [instance.tags] : instance.tags.map((tag) => [tag]);
  const active = effectiveActiveWindows(instance, instances, video, new Map());
  return groups.flatMap((tags, index) => {
    const own = getMgAnnotationWindow(tags, instances, video);
    return intersectWindows([own], active).map((window) => ({
      key: instance.mode === "together" ? `${instance.instanceKey}-together` : `${instance.instanceKey}-split-${index + 1}`,
      instance, call, rootFrame, ...window,
      sourceText: tags.map((tag) => tag.text).join("｜"),
      order: tags[0].documentOrder,
    }));
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

const buildScenes = (
  calls: ResolvedMgFunctionCall[],
  instances: Map<string, MgInstanceInfo>,
  video: MgVideoInfo,
): MgScenePlan[] => {
  const allWindows = calls.flatMap((call) => instanceWindows(call, instances.get(call.instanceKey)!, instances, video));
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
  errors.push(...reviewedTopologyErrors(call.arguments, instance.graph));
  const rootAt = instance.tags[0].start;
  if (!Number.isFinite(call.at) || Math.abs(call.at - rootAt) > AT_TOLERANCE_SECONDS) {
    errors.push(`根 at=${call.at}，应接近 ${rootAt}`);
  }
  for (const tag of instance.tags) {
    if (!call.elementAts.some((at) => Math.abs(at - tag.start) <= AT_TOLERANCE_SECONDS)) {
      errors.push(`没有元素 at 对应“${tag.text.slice(0, 24)}”的 ${tag.start}`);
    }
    for (const anchor of tag.valueAnchors ?? []) {
      if (!call.elementAts.some((at) => Math.abs(at - anchor.start) <= AT_TOLERANCE_SECONDS)) {
        errors.push(`没有元素 at 对应 value=${anchor.value}“${anchor.text.slice(0, 24)}”的 ${anchor.start}`);
      }
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

/** All templates resolve their internal event offsets against host-owned HTML timing. */
const resolveAnnotatedCall = (
  raw: RawMgFunctionCall,
  instances: Map<string, MgInstanceInfo>,
  video: MgVideoInfo,
): ResolvedMgFunctionCall => {
  const identity = mgProvider.identifyCall({name: raw.name, arguments: raw.arguments});
  const instance = instances.get(identity.instanceKey);
  if (!instance) throw new Error(`HTML 不包含实例 ${identity.instanceKey}`);
  const target = targetWindow(instance, instances, video);
  return resolveMgFunctionCall(raw, {
    start: instance.tags[0].start,
    end: target.endFrame / video.fps,
  });
};

export const validateProvidedMgCalls = (
  rawCalls: readonly RawMgFunctionCall[],
  instances: Map<string, MgInstanceInfo>,
  video: MgVideoInfo,
): Map<string, ResolvedMgFunctionCall> => {
  if (!Array.isArray(rawCalls)) throw new Error("预规划 Function Calls 必须是数组");
  const calls = new Map<string, ResolvedMgFunctionCall>();
  for (const raw of rawCalls) {
    const call = resolveAnnotatedCall(raw, instances, video);
    if (calls.has(call.instanceKey)) throw new Error(`重复的预规划实例 ${call.instanceKey}`);
    validateResolvedCall(call, instances.get(call.instanceKey)!, video.duration);
    calls.set(call.instanceKey, call);
  }
  const missing = [...instances.keys()].filter((key) => !calls.has(key));
  if (missing.length) throw new Error(`预规划缺少实例: ${missing.join(", ")}`);
  return calls;
};

export const adoptPreparedMgClips = async (
  records: VisualFunctionRecord[],
  clips: readonly PreparedMgClip[],
  fps: number,
): Promise<void> => {
  const seen = new Set<string>();
  const accepted: Array<{record: VisualFunctionRecord; clip: PreparedMgClip}> = [];
  for (const clip of clips) {
    const record = records.find((candidate) => candidate.instanceKey === clip.instanceKey);
    if (!record || seen.has(clip.instanceKey)) throw new Error(`预渲染片段实例无效或重复: ${clip.instanceKey}`);
    seen.add(clip.instanceKey);
    if (record.name !== clip.name || JSON.stringify(stableValue(record.arguments)) !== JSON.stringify(stableValue(clip.arguments))
      || record.startFrame !== clip.startFrame || record.endFrame !== clip.endFrame) {
      throw new Error(`预渲染片段与当前参数或时间不一致: ${clip.instanceKey}`);
    }
    await assertMgVideoFrames(clip.videoPath, record.endFrame - record.startFrame, fps);
    accepted.push({record, clip});
  }
  for (const {record, clip} of accepted) Object.assign(record, {status: "completed", videoPath: clip.videoPath, error: undefined});
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
  instances: Map<string, MgInstanceInfo>,
  video: MgVideoInfo,
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
      const window = targetWindow(instance, instances, video);
      return `${indent}- 宿主窗口=${instance.tags[0].start.toFixed(3)}-${(window.endFrame / video.fps).toFixed(3)}s；<${instance.tag}> group=${instance.group} order=${instance.order ?? "null"} depth=${instance.depth}：${values}`;
    })
    .join("\n");
  const graphContracts = members
    .filter((instance) => instance.graph)
    .map((instance) => [
      `\n已由人工审核的 <${instance.tag}> 固定拓扑（实例 ${instance.instanceKey}；Function Call 必须原样复制，不能增删、改名、改连线；只补函数 Schema 允许的图片/属性、绝对 at 和边 relation）：`,
      formatReviewedTopology(instance.graph!),
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
  allInstances: Map<string, MgInstanceInfo>,
  video: MgVideoInfo,
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
      const providerCall = resolveAnnotatedCall(raw, allInstances, video);
      const instance = instances.get(providerCall.instanceKey);
      if (!instance) throw new Error(`当前 scope 不包含实例 ${providerCall.instanceKey}`);
      const resolved = providerCall;
      if (calls.has(resolved.instanceKey)) throw new Error(`${resolved.instanceKey} 已调用过一次`);
      validateResolvedCall(resolved, instance, video.duration);
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
    formatScopePrompt(root, members, timeline, referenceImages, feedback, allInstances, video),
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
  allInstances: Map<string, MgInstanceInfo>,
  video: MgVideoInfo,
  initialFeedback = "",
): Promise<ResolvedMgFunctionCall[]> => {
  let feedback = initialFeedback;
  let lastError: unknown;
  for (let attempt = 1; attempt <= SCOPE_MAX_ATTEMPTS; attempt++) {
    try {
      console.log(`[视觉 Agent] ${root.instanceKey} 第 ${attempt}/${SCOPE_MAX_ATTEMPTS} 次`);
      return await requestScopeCalls(root, members, timeline, referenceImages, feedback, allInstances, video);
    } catch (error) {
      lastError = error;
      feedback = [initialFeedback, error instanceof Error ? error.message : String(error)]
        .filter(Boolean)
        .join("\n\n");
      console.warn(`[视觉 Agent] ${root.instanceKey} 未通过: ${feedback}`);
    }
  }
  throw lastError ?? new Error(`${root.instanceKey} Function Calling 失败`);
};

export const selectMgPlanningTargets = (
  roots: readonly MgInstanceInfo[],
  scopes: ReadonlyMap<string, MgInstanceInfo[]>,
  reusableCalls: ReadonlyMap<string, ResolvedMgFunctionCall>,
  replanInstanceKeys?: ReadonlySet<string>,
): Array<{root: MgInstanceInfo; members: MgInstanceInfo[]}> => replanInstanceKeys
  ? [...scopes.values()].flat().filter((instance) => replanInstanceKeys.has(instance.instanceKey))
    .map((instance) => ({root: instance, members: [instance]}))
  : roots.filter((root) => scopes.get(root.instanceKey)!.some((instance) => !reusableCalls.has(instance.instanceKey)))
    .map((root) => ({root, members: scopes.get(root.instanceKey)!}));

const isWebFocusTag = (tag: string | undefined): boolean => tag === "web-news-focus" || tag === "web-page-focus";

const isWebFocusCaptureFailure = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("WEB_NEWS_FOCUS_CAPTURE_FAILED") || message.includes("WEB_PAGE_FOCUS_CAPTURE_FAILED");
};

export const webFocusNeedsPageRead = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return isWebFocusCaptureFailure(error)
    && /\b(?:WEB_FOCUS_TEXT_NOT_FOUND|WEB_SNAPSHOT_NOT_FOUND)\b/.test(message);
};

const failedWebFocusUrl = (error: unknown): string | undefined => {
  const message = error instanceof Error ? error.message : String(error);
  return message.match(/WEB_(?:NEWS|PAGE)_FOCUS_CAPTURE_FAILED url=(\S+)/)?.[1];
};

const normalizedWebUrl = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
};

const ownTargetWindow = (
  instance: MgInstanceInfo,
  instances: Map<string, MgInstanceInfo>,
  video: MgVideoInfo,
): {startFrame: number; endFrame: number} => getMgAnnotationWindow(instance.tags, instances, video);

const targetWindow = (
  instance: MgInstanceInfo,
  instances: Map<string, MgInstanceInfo>,
  video: MgVideoInfo,
  cache = new Map<string, {startFrame: number; endFrame: number}>(),
): {startFrame: number; endFrame: number} => {
  const existing = cache.get(instance.instanceKey);
  if (existing) return existing;
  const own = ownTargetWindow(instance, instances, video);
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
  instances: Map<string, MgInstanceInfo>,
  video: MgVideoInfo,
  target: FrameWindow,
): FrameWindow[] => {
  if (instance.mode !== "split") return [target];
  return instance.tags.flatMap((tag) =>
    intersectWindows([getMgAnnotationWindow([tag], instances, video)], [target]),
  );
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
  let windows = ownActiveWindows(instance, instances, video, target);
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
      ...(isGeneratedVideoTag(call.htmlTag) ? {generatedVideoBackend: h3ClipCacheIdentity(getStoryVideoConfig(), fsSync.readFileSync(getStoryVideoConfig().workflowPath))} : {}),
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
  forceRender = false,
): Promise<string> => {
  const activeWindows = localActiveWindows(instance, instances, video, windowCache);
  const needsAlpha = call.layerRole === "overlay" || activeWindows.length > 0;
  const extension = needsAlpha ? ".mov" : ".mp4";
  const outputPath = path.join(clipsDir, `${clipFileStem(call.instanceKey, record.taskSignature)}${extension}`);
  if (!forceRender && await reuseValidClip(outputPath, record.endFrame - record.startFrame, video.fps)) return outputPath;
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
      bundleRaw,
    ] = await Promise.all([
      fs.readFile(htmlPath, "utf-8"),
      fs.readFile(timelinePath, "utf-8"),
      fs.readFile(articlePath, "utf-8"),
      getMediaDuration(audioPath),
      listReferenceImages(sel),
      fs.readFile(novelPaths.mgFunctionCalls(sel.novelName, sel.episode), "utf-8"),
      fs.readFile(novelPaths.mgRenderBundle(sel.novelName, sel.episode), "utf-8"),
    ]);
    validateMgAnnotationHtml(html, article);
    const timeline = JSON.parse(timelineRaw) as ArticleTimelineEntry[];
    const records = JSON.parse(recordsRaw) as VisualFunctionRecord[];
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
      const call = resolveAnnotatedCall({id: record.id, name: record.name, arguments: record.arguments}, instances, video);
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
    return sameJson(bundle, expectedBundle);
  } catch {
    return false;
  }
}

export async function planEssayMg(sel: NovelSelection, refresh: MgPlanRefreshOptions = {}): Promise<string> {
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

  const providedCalls = refresh.functionCalls === undefined ? undefined : validateProvidedMgCalls(refresh.functionCalls, instances, video);
  if (refresh.preparedClips?.length && !providedCalls) throw new Error("导入预渲染片段需要同时提供已校验的 Function Calls");

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
  const replanInstanceKeys = new Set(refresh.replanInstanceKeys ?? []);
  const rerenderInstanceKeys = new Set(refresh.rerenderInstanceKeys ?? []);
  const targetedRefresh = replanInstanceKeys.size > 0 || rerenderInstanceKeys.size > 0;
  const forcedRenderKeys = new Set(refresh.all ? instances.keys() : [...replanInstanceKeys, ...rerenderInstanceKeys]);
  if (refresh.all && targetedRefresh) throw new Error("全量重跑不能与定向重跑混用");
  if (!targetedRefresh) await cleanupUnreferencedClips(sel, previousRecords);
  const previousByInstance = new Map(previousRecords.map((record) => [record.instanceKey, record]));
  const reuseGeneratedKeys = new Set(refresh.reuseGeneratedVideoInstanceKeys ?? []);
  if (targetedRefresh && reuseGeneratedKeys.size) {
    throw new Error("定向重跑不能同时指定保留已有生成视频");
  }
  if (targetedRefresh) {
    const unknown = [...forcedRenderKeys].filter((key) => !instances.has(key));
    if (unknown.length) throw new Error(`定向重跑找不到实例: ${unknown.join(", ")}`);
    const missingCacheKeys = [...instances.keys()].filter((key) => !previousByInstance.has(key) && !replanInstanceKeys.has(key));
    const removedCacheKeys = [...previousByInstance.keys()].filter((key) => !instances.has(key));
    if (missingCacheKeys.length || removedCacheKeys.length) {
      throw new Error(`定向重跑需要完整的未修改实例缓存: missing=${missingCacheKeys.join(", ")}; removed=${removedCacheKeys.join(", ")}`);
    }
    const generatedVideoKeys = [...forcedRenderKeys].filter((key) => isGeneratedVideoTag(instances.get(key)?.tag));
    if (generatedVideoKeys.length) throw new Error(`定向 MG 重跑不能重新生成图生视频: ${generatedVideoKeys.join(", ")}`);
  }
  const windowCache = new Map<string, {startFrame: number; endFrame: number}>();
  const reusableCalls = new Map<string, ResolvedMgFunctionCall>();
  const preservedGeneratedCalls = new Map<string, ResolvedMgFunctionCall>();
  for (const key of reuseGeneratedKeys) {
    const instance = instances.get(key);
    const previous = previousByInstance.get(key);
    if (!instance || !isGeneratedVideoTag(instance.tag) || previous?.status !== "completed" || !previous.videoPath) {
      throw new Error(`无法保留生成视频 ${key}：缺少当前实例或已完成的旧片段`);
    }
    const call = resolveAnnotatedCall({id: previous.id, name: previous.name, arguments: previous.arguments}, instances, video);
    validateResolvedCall(call, instance, video.duration);
    const current = targetWindow(instance, instances, video, windowCache);
    if (previous.startFrame !== current.startFrame || previous.endFrame !== current.endFrame) {
      throw new Error(`无法保留生成视频 ${key}：新旧时间窗口不同`);
    }
    await assertMgVideoFrames(previous.videoPath, current.endFrame - current.startFrame, video.fps);
    preservedGeneratedCalls.set(key, call);
  }
  for (const root of targetedRefresh || refresh.all ? [] : roots) {
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
        const call = resolveAnnotatedCall({id: previous.id, name: previous.name, arguments: previous.arguments}, instances, video);
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

  if (targetedRefresh) {
    for (const instance of instances.values()) {
      if (replanInstanceKeys.has(instance.instanceKey)) continue;
      const previous = previousByInstance.get(instance.instanceKey);
      if (!previous) throw new Error(`定向重跑缺少 ${instance.instanceKey} 的旧 Function Call`);
      const call = resolveAnnotatedCall({id: previous.id, name: previous.name, arguments: previous.arguments}, instances, video);
      validateResolvedCall(call, instance, video.duration);
      const current = describeTask(call, instance, instances, video, windowCache, referenceImageHashes);
      if (!rerenderInstanceKeys.has(instance.instanceKey)) {
        if (previous.taskSignature !== current.signature || previous.startFrame !== current.startFrame || previous.endFrame !== current.endFrame) {
          throw new Error(`定向重跑期间 ${instance.instanceKey} 的缓存签名或时间窗口已变化；请单独处理该实例`);
        }
        if (previous.status !== "completed" || !previous.videoPath || !fsSync.existsSync(previous.videoPath)) {
          throw new Error(`定向重跑期间 ${instance.instanceKey} 缺少可复用片段`);
        }
        await assertMgVideoFrames(previous.videoPath, current.endFrame - current.startFrame, video.fps);
      }
      reusableCalls.set(instance.instanceKey, call);
    }
  }

  if (providedCalls) for (const [key, call] of providedCalls) reusableCalls.set(key, call);
  const planningTargets = selectMgPlanningTargets(
    roots, scopes, reusableCalls, targetedRefresh ? replanInstanceKeys : undefined,
  );
  const freshCalls = annotation.instanceCount === 0 ? [] : (await runWithConcurrency(
    planningTargets,
    SCOPE_CONCURRENCY,
    ({root, members}) => runScope(
      root,
      members,
      timeline,
      referenceImages,
      instances,
      video,
      [
        refresh.planningContext,
        targetedRefresh && isWebFocusTag(root.tag)
          ? `旧网页 ${String(previousByInstance.get(root.instanceKey)?.arguments.url ?? "")} 捕获失败或产生黑帧。必须另选符合模板来源规则的网页，并从新网页正文逐字选取定位短语。`
          : "",
      ].filter(Boolean).join("\n\n"),
    ),
  )).flat();
  for (const call of freshCalls) {
    if (!preservedGeneratedCalls.has(call.instanceKey)) reusableCalls.set(call.instanceKey, call);
  }
  for (const [key, call] of preservedGeneratedCalls) reusableCalls.set(key, call);
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
      timing: {start: call.at, end: endFrame / video.fps},
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
      !forcedRenderKeys.has(call.instanceKey)
      &&
      previous?.status === "completed"
      && (previous.taskSignature === signature || preservedGeneratedCalls.has(call.instanceKey))
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
  if (refresh.preparedClips?.length) await adoptPreparedMgClips(records, refresh.preparedClips, video.fps);
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
  // Remotion template renders share a local Chromium/webpack runtime. Running
  // several at once can close browser targets and strand every pending clip.
  await runVisualTaskQueue(records, async (record, index, prepareGeneratedVideo) => {
    let call = callsByInstance.get(record.instanceKey)!;
    if (record.status === "completed" && record.videoPath) {
      if (await reuseValidClip(record.videoPath, record.endFrame - record.startFrame, video.fps)) {
        console.log(`[视觉任务] 复用 ${record.instanceKey} -> ${path.basename(record.videoPath)}`);
        return;
      }
      await updateRecord(index, "queued", {videoPath: undefined});
    }
    if (isGeneratedVideoTag(call.htmlTag)) await prepareGeneratedVideo();
    let lastError: unknown;
    let mediaAttempt = 0;
    let webReplans = 0;
    const rejectedWebUrls = new Set<string>();
    while (true) {
      const attempt = mediaAttempt + 1;
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
            forcedRenderKeys.has(call.instanceKey),
          );
        await updateRecord(index, "completed", {videoPath, error: undefined, retries: attempt - 1});
        return;
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        await updateRecord(index, "failed", {error: message, retries: attempt});
        if (providedCalls && isWebFocusCaptureFailure(error)) break;
        if (isWebFocusTag(call.htmlTag) && isWebFocusCaptureFailure(error)) {
          const rejectedUrl = failedWebFocusUrl(error) ?? String(call.arguments.url ?? "");
          const normalizedRejectedUrl = normalizedWebUrl(rejectedUrl);
          const rereadPage = webFocusNeedsPageRead(error);
          if (!rereadPage && normalizedRejectedUrl) rejectedWebUrls.add(normalizedRejectedUrl);
          if (webReplans >= WEB_NEWS_REPLAN_MAX_ATTEMPTS) break;
          let replacementAccepted = false;
          const instance = instances.get(record.instanceKey)!;
          while (webReplans < WEB_NEWS_REPLAN_MAX_ATTEMPTS && !replacementAccepted) {
            webReplans++;
            console.warn(`[视觉任务] ${record.instanceKey} ${rereadPage ? "定位文字无效，重新读取快照" : "网页捕获失败，重新搜索"} (${webReplans}/${WEB_NEWS_REPLAN_MAX_ATTEMPTS}): ${rejectedUrl}`);
            const rejectedList = [...rejectedWebUrls].join("、");
            const nextFunction = call.name;
            const feedback = rereadPage
              ? `网页重点实例 ${record.instanceKey} 的定位文字不正确或尚未读取网页。必须先调用 search_web({url: ${JSON.stringify(rejectedUrl)}}) 重新读取同一份最终正文，再逐字复制其中实际存在的短语，仅重新调用 ${nextFunction}。不需要换网页，不要自行翻译，也不要引用清稿或搜索摘要；保留当前时间轴语义。捕获错误：${message.split("\nChrome:")[0]}`
              : `网页重点实例 ${record.instanceKey} 的页面捕获失败。必须调用 search_web({query}) 搜索另一篇可靠来源，再调用 search_web({url}) 读取所选正文。以下 URL 均已被程序拒绝，不能再次使用：${rejectedList}。不能使用 fallback URL、摘要或截图替代。然后仅为此实例重新调用 ${nextFunction}，保留当前时间轴语义并使用新网页正文中的逐字定位短语。`;
            try {
              const replanned = await runScope(instance, [instance], timeline, referenceImages, instances, video, feedback);
              const nextCall = replanned[0];
              const nextUrl = normalizedWebUrl(nextCall.arguments.url);
              if (!nextUrl) throw new Error("重新规划没有提供有效的 canonical URL");
              if (rejectedWebUrls.has(nextUrl)) {
                throw new Error(`重新规划再次选择了已失败 URL：${nextUrl}`);
              }
              const nextTask = describeTask(nextCall, instance, instances, video, windowCache, referenceImageHashes);
              if (nextTask.startFrame !== record.startFrame || nextTask.endFrame !== record.endFrame) {
                throw new Error(`${record.instanceKey} 重新规划意外改变了时间窗口`);
              }
              call = nextCall;
              callsByInstance.set(record.instanceKey, call);
              const nextRecord: VisualFunctionRecord = {
                ...record,
                id: call.id,
                taskId: hashId(`${sel.novelName}:${sel.episode}:${call.instanceKey}:${nextTask.signature}`),
                taskSignature: nextTask.signature,
                name: call.name,
                htmlTag: call.htmlTag,
                group: call.group,
                ...(call.order === undefined ? {order: undefined} : {order: call.order}),
                arguments: call.arguments,
                status: "queued",
                retries: 0,
                error: undefined,
                videoPath: undefined,
              };
              records[index] = nextRecord;
              record = nextRecord;
              await flushRecords();
              mediaAttempt = 0;
              replacementAccepted = true;
            } catch (replanError) {
              lastError = replanError;
              const detail = replanError instanceof Error ? replanError.message : String(replanError);
              await updateRecord(index, "failed", {error: `重新读取/规划失败${rejectedList ? `（已拒绝 ${rejectedList}）` : ""}：${detail}`, retries: webReplans});
            }
          }
          if (replacementAccepted) continue;
          break;
        }
        if (isGeneratedVideoTag(call.htmlTag)) break; // H3 owns retries; never resubmit an ambiguous accepted GPU job.
        mediaAttempt++;
        if (mediaAttempt < MEDIA_MAX_ATTEMPTS) {
          console.warn(`[视觉任务] ${record.instanceKey} 第 ${attempt}/${MEDIA_MAX_ATTEMPTS} 次失败，重试: ${message}`);
          continue;
        }
        break;
      }
    }
    throw lastError ?? new Error(`${record.instanceKey} 视频任务失败`);
  }, refresh.beforeGeneratedVideo);

  const nodes = compositionNodesFor(records, callsByInstance, instances);
  const bundle: MgRenderBundle = {
    version: 4,
    width: video.width,
    height: video.height,
    fps: video.fps,
    durationFrames: video.durationFrames,
    nodes,
  };
  await Promise.all([
    fs.writeFile(novelPaths.mgFunctionCalls(sel.novelName, sel.episode), `${JSON.stringify(records, null, 2)}\n`, "utf-8"),
    fs.writeFile(novelPaths.mgRenderBundle(sel.novelName, sel.episode), `${JSON.stringify(bundle, null, 2)}\n`, "utf-8"),
  ]);
  if (!targetedRefresh) await cleanupUnreferencedClips(sel, records);
  console.log(`[视觉规划] ${planningTargets.length}/${roots.length} 个 Agent scope / ${records.length} 个 Function Call / ${nodes.length} 个合成节点`);
  return novelPaths.mgFunctionCalls(sel.novelName, sel.episode);
}
