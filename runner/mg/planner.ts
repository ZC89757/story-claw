import fs from "node:fs/promises";
import path from "node:path";
import type {ToolDefinition} from "@mariozechner/pi-coding-agent";
import type {MgRuntimeOverlay, MgTemplateName} from "@story-claw/mg-templates";
import {runSubAgent} from "../../agent.js";
import type {NovelSelection} from "../../ui/select.js";
import {novelPaths} from "../../utils/paths.js";
import type {ArticleTimelineEntry} from "../render.js";
import {locateMgInstances, validateMgAnnotationHtml} from "./html.js";
import {probeMgVideo, sha256File} from "./media.js";
import {
  backgroundForTemplateStyle,
  elementAts,
  functionsForTemplateStyle,
  MG_FUNCTION_DEFINITIONS,
  OVERLAY_TEMPLATES,
  resolveMgFunctionCall,
  TAG_FUNCTIONS,
} from "./registry.js";
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

const FUNCTION_CALLING_SYSTEM = `你负责把 HTML 中的 MG 标签转换成动画工具调用。

你会收到完整 HTML 和与正文逐字对应的时间轴 JSON。

调用规则：
- 每个动画实例必须调用一次对应工具，包括嵌套实例；动画实例由“标签名称 + order”确定
- 同一种标签只有一个实例、HTML 未写 order 时，Function Call 的 order 填 null
- 同一种标签有多个实例时，原样复制该实例的 order；同一实例内的标签按 value 顺序组成一段动画
- group 是用户选择的渲染样式，必须从 HTML 原样复制，不得自行改写
- 根据标签名称选择工具；<multi-series-chart> 根据 group=bar 或 group=line 选择对应工具
- <mg-showcase> 用 create_showcase_timeline；items 只填可读的界面/卡片/步骤文字和绝对 at
- <mg-metric> 用 create_metric_timeline；points 只填 label、value 和绝对 at，保留原文数字及单位
- <mg-transition> 用 create_transition_cue；只填接缝锚点文字和根 at，几何形状、强度、音效由 group 固定
- <mg-rhythm> 用 create_rhythm_cue；只填节拍锚点文字和根 at，脉冲/冻结/频闪由 group 固定
- <mg-effect> 用 create_effect_cue；只填效果锚点文字和根 at，光斑/扫描/冲击/装配由 group 固定；同实例多个标注时用 items 保留各自 at
- <mg-camera> 用 create_camera_move；只填运镜锚点文字和根 at，推拉/俯仰/旋转/视差由 group 固定；同实例多个标注时用 items 保留各自 at
- 不得合并、遗漏或创建 HTML 中不存在的动画实例

时间规则：
- at 直接使用时间轴 JSON 中的 start 数值，不进行换算
- 实例的 at 使用该实例第一处标签文字首字的 start
- 节点、单元格、边、部件、对比项、数据点和关系等元素，各自使用对应文字首字的 start
- 没有单独对应文字的结构性元素使用实例的 at

内容规则：
- 根据标签文字及其所在段落填写动画内容
- 保留原文中的数字、正负号、年份、单位和系列关系
- image-stack/image-grid 的 images[].image 填图片 URL、本地图片路径或生图提示词；代码会在渲染前自动识别并处理
- URL 只能逐字取自输入 HTML、正文或已提供的素材路径；无法确认时不要编造 URL
- 参数必须符合工具 Schema
- 工具返回错误时修正当前实例；全部实例调用完成后结束`;

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
  create_image_stack: "图片叠加",
  create_image_grid: "图片并列",
  create_showcase_timeline: "界面陈列",
  create_metric_timeline: "指标动画",
  create_transition_cue: "转场",
  create_rhythm_cue: "节拍强调",
  create_effect_cue: "视觉效果",
  create_camera_move: "运镜",
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
        content: [{
          type: "text" as const,
          text: `已记录 ${definitionLabel(definition.name)} order=${String(params.order ?? "null")}`,
        }],
        details: {},
      };
    },
  }));

  await runSubAgent(
    tools,
    FUNCTION_CALLING_SYSTEM,
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
    if (!functionsForTemplateStyle(instance.tag, instance.group).includes(call.name)) {
      errors.push(`${instanceKey} 的 <${instance.tag}> 样式 ${instance.group} 错用了 ${call.name}`);
      continue;
    }
    if (call.group !== instance.group) {
      errors.push(`${instanceKey} 的 group 应为 ${instance.group}，实际为 ${call.group}`);
    }
    if (call.order !== instance.order) {
      errors.push(`${instanceKey} 的 order 应为 ${instance.order ?? "null"}，实际为 ${call.order ?? "null"}`);
    }
    const rootAt = Number(call.arguments.at);
    const expectedRootAt = instance.tags[0].start;
    if (!Number.isFinite(rootAt) || Math.abs(rootAt - expectedRootAt) > AT_TOLERANCE_SECONDS) {
      errors.push(`${instanceKey} 根 at=${rootAt}，应接近 ${expectedRootAt}`);
    }
    const ats = elementAts(call).filter(Number.isFinite);
    for (const tag of instance.tags) {
      if (!ats.some((at) => Math.abs(at - tag.start) <= AT_TOLERANCE_SECONDS)) {
        errors.push(`${instanceKey} 没有元素 at 对应“${tag.text.slice(0, 24)}”的 ${tag.start}`);
      }
    }
    if (ats.some((at) => at < expectedRootAt - AT_TOLERANCE_SECONDS || at > instance.paragraphEnd + AT_TOLERANCE_SECONDS)) {
      errors.push(`${instanceKey} 存在超出所属正文范围的元素 at`);
    }
    if (ats.some((at) => at > videoDuration + AT_TOLERANCE_SECONDS)) {
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
      key: `${instance.instanceKey}-together`,
      instance,
      call,
      rootFrame,
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
    const endFrame = Math.min(
      video.durationFrames,
      Math.max(startFrame + 1, Math.min(desiredEnd, Math.max(startFrame + 1, nextStartFrame - 1))),
    );
    return {
      key: `${instance.instanceKey}-split-${index + 1}`,
      instance,
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
        right.instance.depth - left.instance.depth ||
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
    const instance = candidate.instance;
    const count = (counts.get(instance.instanceKey) ?? 0) + 1;
    counts.set(instance.instanceKey, count);
    const id = `${instance.instanceKey}-${String(count).padStart(2, "0")}`;
    return {
      id,
      instance: instance.instanceKey,
      group: instance.group,
      ...(instance.order === undefined ? {} : {order: instance.order}),
      template: candidate.call.template,
      renderMode: candidate.call.template === "camera" ? "overlay" : "replace",
      start: startFrame / video.fps,
      end: endFrame / video.fps,
      startFrame,
      endFrame,
      durationFrames: endFrame - startFrame,
      timelineOffsetFrames: startFrame - candidate.rootFrame,
      sourceText: candidate.sourceText,
      specFile: `specs/${instance.instanceKey}.json`,
      clipFile: `clips/${id}.mp4`,
      ...(candidate.call.template === "camera" ? {baseFile: `base/${id}.mp4`} : {}),
      background: backgroundForTemplateStyle(candidate.call.template, instance.group),
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
  instance: fragment.candidate.instance.instanceKey,
  group: fragment.candidate.instance.group,
  ...(fragment.candidate.instance.order === undefined ? {} : {order: fragment.candidate.instance.order}),
  template: fragment.candidate.call.template as "title" | "emphasis" | "transition" | "rhythm" | "effect",
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
      instance: id,
      group: "raw",
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
  instances: Map<string, MgInstanceInfo>,
  video: MgVideoInfo,
): MgScenePlan[] => {
  const allWindows = calls.flatMap((call) => instanceWindows(call, instances.get(call.instanceKey)!, video));
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
  const instances = locateMgInstances(html, timeline, article);
  const functionDefinitions = selectMgFunctionDefinitions(
    new Set([...instances.values()].map((instance) => instance.tag)),
  );

  let resolvedCalls: ResolvedMgFunctionCall[] = [];
  let rawCalls: RawMgFunctionCall[] = [];
  if (annotation.instanceCount > 0) {
    let feedback = "";
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      console.log(`[MG Function Calling] 第 ${attempt}/3 次`);
      try {
        rawCalls = await requestFunctionCalls(html, compactTimeline, feedback, functionDefinitions);
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
  await Promise.all([
    fs.mkdir(mgDir, {recursive: true}),
    fs.mkdir(specsDir, {recursive: true}),
  ]);
  await Promise.all(resolvedCalls.map((call) =>
    fs.writeFile(path.join(specsDir, `${call.instanceKey}.json`), `${JSON.stringify(call.spec, null, 2)}\n`, "utf-8"),
  ));

  const bundle: MgRenderBundle = {version: 2, width: video.width, height: video.height, fps: video.fps, scenes};
  const plan: MgPlan = {
    version: 2,
    source: {rawVideo: rawVideoPath, sha256: rawHash, ...video, html: htmlPath, timeline: timelinePath},
    instances: [...instances.values()].map((instance) => ({
      instanceKey: instance.instanceKey,
      group: instance.group,
      tag: instance.tag,
      ...(instance.order === undefined ? {} : {order: instance.order}),
      mode: instance.mode,
      tagCount: instance.tags.length,
      starts: instance.tags.map((tag) => tag.start),
    })),
    functionCalls: resolvedCalls.map((call) => ({
      id: call.id,
      name: call.name,
      instanceKey: call.instanceKey,
      group: call.group,
      ...(call.order === undefined ? {} : {order: call.order}),
      at: call.at,
      arguments: call.arguments,
      specFile: `specs/${call.instanceKey}.json`,
    })),
    scenes: scenes.map(({spec, overlays, ...scene}) => ({
      ...scene,
      overlays: overlays.map(({spec: _spec, ...overlay}) => ({...overlay, specFile: `specs/${overlay.instance}.json`})),
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
