import fs from "node:fs/promises";
import path from "node:path";
import type {ToolDefinition} from "@mariozechner/pi-coding-agent";
import type {MgRuntimeOverlay, MgTemplateName} from "@story-claw/mg-templates";
import {runSubAgent} from "../../agent.js";
import type {NovelSelection} from "../../ui/select.js";
import {novelPaths} from "../../utils/paths.js";
import type {ArticleTimelineEntry} from "../render.js";
import {locateMgGroups, validateMgAnnotationHtml} from "./html.js";
import {probeMgVideo, sha256File} from "./media.js";
import {
  BACKGROUND_BY_TEMPLATE,
  elementAts,
  MG_FUNCTION_DEFINITIONS,
  OVERLAY_TEMPLATES,
  resolveMgFunctionCall,
  TAG_FUNCTIONS,
} from "./registry.js";
import type {
  MgGroupInfo,
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

const FUNCTION_CALLING_SYSTEM = `你负责把 HTML 中的 MG 标签转换成动画工具调用。

你会收到完整 HTML 和与正文逐字对应的时间轴 JSON。

调用规则：
- HTML 中每个 group 必须调用一次对应工具，包括嵌套 group
- 同一 group 内的标签按 value 顺序组成一段动画
- 根据标签名称选择工具；<multi-series-chart> 根据数据表达选择柱状图或折线图
- 不得合并、遗漏或创建 HTML 中不存在的 group

时间规则：
- at 直接使用时间轴 JSON 中的 start 数值，不进行换算
- group 的 at 使用该 group 第一处标签文字首字的 start
- 节点、单元格、边、部件、对比项、数据点和关系等元素，各自使用对应文字首字的 start
- 没有单独对应文字的结构性元素使用 group 的 at

内容规则：
- 根据标签文字及其所在段落填写动画内容
- 保留原文中的数字、正负号、年份、单位和系列关系
- 参数必须符合工具 Schema
- 工具返回错误时修正当前 group；全部 group 调用完成后结束`;

const definitionLabel = (name: string): string => ({
  create_progress_timeline: "时间进度条",
  create_timed_table: "动态表格",
  create_directed_graph_timeline: "有向关系图",
  create_title_cue: "标题动画",
  create_emphasis_text_cue: "重点大字",
  create_xy_chart_timeline: "坐标趋势图",
  create_multi_series_bar_chart: "多系列柱状图",
  create_multi_series_line_chart: "多系列折线图",
  create_containment_timeline: "包含关系",
  create_decomposition_timeline: "整体拆解",
  create_weighted_comparison: "加权对比",
  create_side_by_side_comparison: "左右对比",
  create_collage_network: "拼贴关系网络",
} as Record<string, string>)[name] ?? name;

type MgFunctionDefinition = (typeof MG_FUNCTION_DEFINITIONS)[number];

export const selectMgFunctionDefinitions = (
  tags: Iterable<MgTemplateName>,
): MgFunctionDefinition[] => {
  const names = new Set<string>();
  for (const tag of tags) {
    for (const name of TAG_FUNCTIONS[tag]) names.add(name);
  }
  return MG_FUNCTION_DEFINITIONS.filter((definition) => names.has(definition.name));
};

const requestFunctionCalls = async (
  html: string,
  timelineRaw: string,
  feedback: string,
  definitions: readonly MgFunctionDefinition[],
): Promise<RawMgFunctionCall[]> => {
  const calls: RawMgFunctionCall[] = [];
  const tools: ToolDefinition[] = definitions.map((definition) => ({
    name: definition.name,
    label: definitionLabel(definition.name),
    description: definition.description,
    parameters: definition.parameters as any,
    execute: async (toolCallId: string, params: Record<string, unknown>) => {
      const call = {id: toolCallId, name: definition.name, arguments: params};
      resolveMgFunctionCall(call);
      calls.push(call);
      return {
        content: [{type: "text" as const, text: `已记录 group ${String(params.group ?? "")}`}],
        details: {},
      };
    },
  }));

  await runSubAgent(
    tools,
    FUNCTION_CALLING_SYSTEM,
    [
      feedback ? `校验错误：\n${feedback}\n请重新完成所有 group。` : "",
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
  groups: Map<string, MgGroupInfo>,
  videoDuration: number,
): ResolvedMgFunctionCall[] => {
  const errors: string[] = [];
  const callsByGroup = new Map<string, RawMgFunctionCall>();
  for (const call of rawCalls) {
    const group = typeof call.arguments.group === "string" ? call.arguments.group : "";
    if (!group) {
      errors.push(`${call.name} 缺少 group`);
      continue;
    }
    if (callsByGroup.has(group)) errors.push(`group ${group} 被调用了多次`);
    else callsByGroup.set(group, call);
  }
  for (const group of groups.keys()) if (!callsByGroup.has(group)) errors.push(`缺少 group ${group} 的 Function Call`);
  for (const group of callsByGroup.keys()) if (!groups.has(group)) errors.push(`多出了 HTML 不存在的 group ${group}`);

  const resolved: ResolvedMgFunctionCall[] = [];
  for (const [groupName, group] of groups) {
    const call = callsByGroup.get(groupName);
    if (!call) continue;
    if (!TAG_FUNCTIONS[group.tag].includes(call.name)) {
      errors.push(`group ${groupName} 的 <${group.tag}> 错用了 ${call.name}`);
      continue;
    }
    const rootAt = Number(call.arguments.at);
    const expectedRootAt = group.tags[0].start;
    if (!Number.isFinite(rootAt) || Math.abs(rootAt - expectedRootAt) > AT_TOLERANCE_SECONDS) {
      errors.push(`group ${groupName} 根 at=${rootAt}，应接近 ${expectedRootAt}`);
    }
    const ats = elementAts(call).filter(Number.isFinite);
    for (const tag of group.tags) {
      if (!ats.some((at) => Math.abs(at - tag.start) <= AT_TOLERANCE_SECONDS)) {
        errors.push(`group ${groupName} 没有元素 at 对应“${tag.text.slice(0, 24)}”的 ${tag.start}`);
      }
    }
    if (ats.some((at) => at < expectedRootAt - AT_TOLERANCE_SECONDS || at > group.paragraphEnd + AT_TOLERANCE_SECONDS)) {
      errors.push(`group ${groupName} 存在超出所属正文范围的元素 at`);
    }
    if (ats.some((at) => at > videoDuration + AT_TOLERANCE_SECONDS)) {
      errors.push(`group ${groupName} 存在超出原画时长的元素 at`);
    }
    try {
      resolved.push(resolveMgFunctionCall(call));
    } catch (error) {
      errors.push(`group ${groupName} 参数校验失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (errors.length) throw new Error(errors.join("\n"));
  return resolved.sort((left, right) => left.at - right.at);
};

type WindowCandidate = {
  key: string;
  group: MgGroupInfo;
  call: ResolvedMgFunctionCall;
  rootFrame: number;
  startFrame: number;
  endFrame: number;
  sourceText: string;
  order: number;
};

const groupWindows = (
  call: ResolvedMgFunctionCall,
  group: MgGroupInfo,
  video: MgVideoInfo,
): WindowCandidate[] => {
  const frame = (seconds: number) => Math.max(0, Math.min(video.durationFrames, Math.round(seconds * video.fps)));
  const startFrameAt = (seconds: number) => Math.min(video.durationFrames - 1, frame(seconds));
  const rootFrame = startFrameAt(call.at);
  if (group.mode === "together") {
    const lastTag = group.tags.at(-1)!;
    const endSeconds = Math.max(lastTag.end + TRAILING_VISIBLE_SECONDS, call.at + MIN_VISIBLE_SECONDS);
    return [{
      key: `${group.group}-together`,
      group,
      call,
      rootFrame,
      startFrame: rootFrame,
      endFrame: Math.min(video.durationFrames, Math.max(rootFrame + 1, frame(endSeconds))),
      sourceText: group.tags.map((tag) => tag.text).join("｜"),
      order: group.tags[0].documentOrder,
    }];
  }

  return group.tags.map((tag, index) => {
    const startFrame = startFrameAt(tag.start);
    const nextStartFrame = group.tags[index + 1] ? startFrameAt(group.tags[index + 1].start) : video.durationFrames;
    const desiredEnd = frame(Math.max(tag.end + TRAILING_VISIBLE_SECONDS, tag.start + MIN_VISIBLE_SECONDS));
    const endFrame = Math.min(
      video.durationFrames,
      Math.max(startFrame + 1, Math.min(desiredEnd, Math.max(startFrame + 1, nextStartFrame - 1))),
    );
    return {
      key: `${group.group}-split-${index + 1}`,
      group,
      call,
      rootFrame,
      startFrame,
      endFrame,
      sourceText: tag.text,
      order: tag.documentOrder,
    };
  });
};

type OwnedInterval = {candidate: WindowCandidate; startFrame: number; endFrame: number};

const resolveMainIntervals = (candidates: WindowCandidate[]): OwnedInterval[] => {
  if (!candidates.length) return [];
  const boundaries = [...new Set(candidates.flatMap((candidate) => [candidate.startFrame, candidate.endFrame]))].sort((a, b) => a - b);
  const intervals: OwnedInterval[] = [];
  for (let index = 0; index < boundaries.length - 1; index++) {
    const startFrame = boundaries[index];
    const endFrame = boundaries[index + 1];
    if (endFrame <= startFrame) continue;
    const active = candidates
      .filter((candidate) => candidate.startFrame <= startFrame && candidate.endFrame >= endFrame)
      .sort((left, right) =>
        right.group.depth - left.group.depth ||
        right.startFrame - left.startFrame ||
        right.order - left.order,
      );
    const winner = active[0];
    if (!winner) continue;
    const previous = intervals.at(-1);
    if (previous?.candidate.key === winner.key && previous.endFrame === startFrame) previous.endFrame = endFrame;
    else intervals.push({candidate: winner, startFrame, endFrame});
  }
  return intervals;
};

const makeMainScenes = (intervals: OwnedInterval[], video: MgVideoInfo): MgScenePlan[] => {
  const counts = new Map<string, number>();
  return intervals.map(({candidate, startFrame, endFrame}) => {
    const count = (counts.get(candidate.group.group) ?? 0) + 1;
    counts.set(candidate.group.group, count);
    const id = `${candidate.group.group}-${String(count).padStart(2, "0")}`;
    return {
      id,
      group: candidate.group.group,
      template: candidate.call.template,
      renderMode: "replace",
      start: startFrame / video.fps,
      end: endFrame / video.fps,
      startFrame,
      endFrame,
      durationFrames: endFrame - startFrame,
      timelineOffsetFrames: startFrame - candidate.rootFrame,
      sourceText: candidate.sourceText,
      specFile: `specs/${candidate.group.group}.json`,
      clipFile: `clips/${id}.mp4`,
      background: BACKGROUND_BY_TEMPLATE[candidate.call.template],
      overlays: [],
      spec: candidate.call.spec,
    };
  });
};

type OverlayFragment = {
  candidate: WindowCandidate;
  startFrame: number;
  endFrame: number;
};

const subtractCoverage = (
  startFrame: number,
  endFrame: number,
  coverage: Array<{startFrame: number; endFrame: number}>,
): Array<{startFrame: number; endFrame: number}> => {
  const result: Array<{startFrame: number; endFrame: number}> = [];
  let cursor = startFrame;
  for (const item of coverage.sort((a, b) => a.startFrame - b.startFrame)) {
    if (item.endFrame <= cursor || item.startFrame >= endFrame) continue;
    if (item.startFrame > cursor) result.push({startFrame: cursor, endFrame: Math.min(item.startFrame, endFrame)});
    cursor = Math.max(cursor, item.endFrame);
    if (cursor >= endFrame) break;
  }
  if (cursor < endFrame) result.push({startFrame: cursor, endFrame});
  return result.filter((item) => item.endFrame > item.startFrame);
};

const overlayFor = (
  fragment: OverlayFragment,
  ownerStartFrame: number,
): MgRuntimeOverlay => ({
  group: fragment.candidate.group.group,
  template: fragment.candidate.call.template as "title" | "emphasis",
  spec: fragment.candidate.call.spec,
  fromFrame: fragment.startFrame - ownerStartFrame,
  durationFrames: fragment.endFrame - fragment.startFrame,
  timelineOffsetFrames: fragment.startFrame - fragment.candidate.rootFrame,
});

const attachOverlays = (
  mainScenes: MgScenePlan[],
  overlayCandidates: WindowCandidate[],
  video: MgVideoInfo,
): MgScenePlan[] => {
  const rawFragments: OverlayFragment[] = [];
  for (const candidate of overlayCandidates) {
    const coverage: Array<{startFrame: number; endFrame: number}> = [];
    for (const scene of mainScenes) {
      const startFrame = Math.max(candidate.startFrame, scene.startFrame);
      const endFrame = Math.min(candidate.endFrame, scene.endFrame);
      if (endFrame <= startFrame) continue;
      coverage.push({startFrame, endFrame});
      scene.overlays.push(overlayFor({candidate, startFrame, endFrame}, scene.startFrame));
    }
    for (const interval of subtractCoverage(candidate.startFrame, candidate.endFrame, coverage)) {
      rawFragments.push({candidate, ...interval});
    }
  }

  if (!rawFragments.length) return mainScenes;
  const boundaries = [...new Set(rawFragments.flatMap((fragment) => [fragment.startFrame, fragment.endFrame]))].sort((a, b) => a - b);
  let rawIndex = 0;
  for (let index = 0; index < boundaries.length - 1; index++) {
    const startFrame = boundaries[index];
    const endFrame = boundaries[index + 1];
    const active = rawFragments.filter((fragment) => fragment.startFrame <= startFrame && fragment.endFrame >= endFrame);
    if (!active.length) continue;
    const id = `raw-overlay-${String(++rawIndex).padStart(2, "0")}`;
    mainScenes.push({
      id,
      group: id,
      template: "raw-overlay",
      renderMode: "overlay",
      start: startFrame / video.fps,
      end: endFrame / video.fps,
      startFrame,
      endFrame,
      durationFrames: endFrame - startFrame,
      timelineOffsetFrames: 0,
      sourceText: active.map((fragment) => fragment.candidate.sourceText).join("｜"),
      clipFile: `clips/${id}.mp4`,
      baseFile: `base/${id}.mp4`,
      background: "#111111",
      overlays: active.map((fragment) => overlayFor({candidate: fragment.candidate, startFrame, endFrame}, startFrame)),
    });
  }
  return mainScenes;
};

const buildScenes = (
  calls: ResolvedMgFunctionCall[],
  groups: Map<string, MgGroupInfo>,
  video: MgVideoInfo,
): MgScenePlan[] => {
  const allWindows = calls.flatMap((call) => groupWindows(call, groups.get(call.group)!, video));
  const mainCandidates = allWindows.filter((candidate) => !OVERLAY_TEMPLATES.has(candidate.call.template));
  const overlayCandidates = allWindows.filter((candidate) => OVERLAY_TEMPLATES.has(candidate.call.template));
  const scenes = attachOverlays(makeMainScenes(resolveMainIntervals(mainCandidates), video), overlayCandidates, video)
    .sort((left, right) => left.startFrame - right.startFrame || left.endFrame - right.endFrame);
  for (let index = 1; index < scenes.length; index++) {
    if (scenes[index].startFrame < scenes[index - 1].endFrame) {
      throw new Error(`MG 场景重叠: ${scenes[index - 1].id} 与 ${scenes[index].id}`);
    }
  }
  return scenes;
};

/** 纯函数入口，供编排测试验证 together/split 和嵌套覆盖规则。 */
export const compileMgScenes = buildScenes;

export async function planEssayMg(sel: NovelSelection): Promise<string> {
  const htmlPath = novelPaths.mgAnnotation(sel.novelName, sel.episode);
  const timelinePath = novelPaths.articleTimeline(sel.novelName, sel.episode);
  const articlePath = novelPaths.cleanedText(sel.novelName, sel.episode);
  const rawVideoPath = novelPaths.episodeRawVideo(sel.novelName, sel.episode);
  const [html, timelineRaw, article, video, rawHash] = await Promise.all([
    fs.readFile(htmlPath, "utf-8"),
    fs.readFile(timelinePath, "utf-8"),
    fs.readFile(articlePath, "utf-8"),
    probeMgVideo(rawVideoPath),
    sha256File(rawVideoPath),
  ]);
  const annotation = validateMgAnnotationHtml(html, article);
  const timeline = JSON.parse(timelineRaw) as ArticleTimelineEntry[];
  const compactTimeline = JSON.stringify(timeline);
  const groups = locateMgGroups(html, timeline, article);
  const functionDefinitions = selectMgFunctionDefinitions(
    new Set([...groups.values()].map((group) => group.tag)),
  );

  let resolvedCalls: ResolvedMgFunctionCall[] = [];
  let rawCalls: RawMgFunctionCall[] = [];
  if (annotation.groupCount > 0) {
    let feedback = "";
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      console.log(`[MG Function Calling] 第 ${attempt}/3 次`);
      try {
        rawCalls = await requestFunctionCalls(html, compactTimeline, feedback, functionDefinitions);
        resolvedCalls = validateAndResolveCalls(rawCalls, groups, video.duration);
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

  const scenes = buildScenes(resolvedCalls, groups, video);
  const mgDir = novelPaths.mgDir(sel.novelName, sel.episode);
  const specsDir = novelPaths.mgSpecsDir(sel.novelName, sel.episode);
  await Promise.all([
    fs.mkdir(mgDir, {recursive: true}),
    fs.mkdir(specsDir, {recursive: true}),
  ]);
  await Promise.all(resolvedCalls.map((call) =>
    fs.writeFile(path.join(specsDir, `${call.group}.json`), `${JSON.stringify(call.spec, null, 2)}\n`, "utf-8"),
  ));

  const bundle: MgRenderBundle = {version: 1, width: video.width, height: video.height, fps: video.fps, scenes};
  const plan: MgPlan = {
    version: 1,
    source: {rawVideo: rawVideoPath, sha256: rawHash, ...video, html: htmlPath, timeline: timelinePath},
    groups: [...groups.values()].map((group) => ({
      group: group.group,
      tag: group.tag,
      mode: group.mode,
      tagCount: group.tags.length,
      starts: group.tags.map((tag) => tag.start),
    })),
    functionCalls: resolvedCalls.map((call) => ({
      id: call.id,
      name: call.name,
      group: call.group,
      at: call.at,
      arguments: call.arguments,
      specFile: `specs/${call.group}.json`,
    })),
    scenes: scenes.map(({spec, overlays, ...scene}) => ({
      ...scene,
      overlays: overlays.map(({spec: _spec, ...overlay}) => ({...overlay, specFile: `specs/${overlay.group}.json`})),
    })),
  };
  await Promise.all([
    fs.writeFile(novelPaths.mgFunctionCalls(sel.novelName, sel.episode), `${JSON.stringify(plan.functionCalls, null, 2)}\n`, "utf-8"),
    fs.writeFile(novelPaths.mgPlan(sel.novelName, sel.episode), `${JSON.stringify(plan, null, 2)}\n`, "utf-8"),
    fs.writeFile(novelPaths.mgRenderBundle(sel.novelName, sel.episode), `${JSON.stringify(bundle, null, 2)}\n`, "utf-8"),
  ]);
  console.log(`[MG规划] ${resolvedCalls.length} 个 Function Call / ${scenes.length} 个渲染片段`);
  return novelPaths.mgPlan(sel.novelName, sel.episode);
}
