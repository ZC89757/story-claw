import {createHash} from "node:crypto";
import {execFile} from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {promisify} from "node:util";
import {fileURLToPath} from "node:url";
import {createRequire} from "node:module";
import OpenAI from "openai";
import {
  progressTimelineFunctionDefinition,
  resolveProgressTimelineFunctionArgs,
} from "../../story-claw-templates/src/progress-timeline/index.js";
import {
  resolveTimedTableFunctionArgs,
  timedTableFunctionDefinition,
} from "../../story-claw-templates/src/timed-table/index.js";
import {
  directedGraphFunctionDefinition,
  resolveDirectedGraphFunctionArgs,
} from "../../story-claw-templates/src/directed-graph/index.js";
import {resolveTitleFunctionArgs, titleFunctionDefinition} from "../../story-claw-templates/src/title/index.js";
import {emphasisFunctionDefinition, resolveEmphasisFunctionArgs} from "../../story-claw-templates/src/emphasis/index.js";
import {resolveXYChartFunctionArgs, xyChartFunctionDefinition} from "../../story-claw-templates/src/xy-chart/index.js";
import {
  multiSeriesBarChartFunctionDefinition,
  multiSeriesLineChartFunctionDefinition,
  resolveMultiSeriesChartFunctionArgs,
} from "../../story-claw-templates/src/multi-series-chart/index.js";
import {containmentFunctionDefinition, resolveContainmentFunctionArgs} from "../../story-claw-templates/src/containment/index.js";
import {decompositionFunctionDefinition, resolveDecompositionFunctionArgs} from "../../story-claw-templates/src/decomposition/index.js";
import {
  resolveSideBySideComparisonFunctionArgs,
  resolveWeightedComparisonFunctionArgs,
  sideBySideComparisonFunctionDefinition,
  weightedComparisonFunctionDefinition,
} from "../../story-claw-templates/src/weighted-comparison/index.js";
import {collageNetworkFunctionDefinition, resolveCollageNetworkFunctionArgs} from "../../story-claw-templates/src/collage-network/index.js";

const require = createRequire(import.meta.url);
const parse5 = require("parse5") as {parse(input: string): HtmlNode};
const execFileAsync = promisify(execFile);
const ROOT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE_DIR = path.resolve(ROOT_DIR, "../story-claw-templates");
const EP_DIR = path.join(ROOT_DIR, "workspace", "谷歌的第二次创业_横屏测试_20260822", "ep01");
const HTML_PATH = path.join(ROOT_DIR, "谷歌的第二次创业_MG标注版.html");
const TIMELINE_PATH = path.join(EP_DIR, "article_timeline.json");
const ARTICLE_PATH = path.join(EP_DIR, "原文_clean.txt");
const RAW_VIDEO_PATH = path.join(EP_DIR, "ep01_raw.mp4");
const OUTPUT_DIR = path.join(EP_DIR, "mg_optimized");
const SPECS_DIR = path.join(OUTPUT_DIR, "specs");
const GENERATED_BUNDLE_PATH = path.join(TEMPLATE_DIR, "examples", "google-optimized.generated.json");
const PUBLIC_BASE_DIR = path.join(TEMPLATE_DIR, "public", "google-optimized", "base");
const PUBLIC_BASE_PREFIX = "google-optimized/base";
const SPLIT_VISIBLE_SECONDS = 1.4;
const AT_TOLERANCE_SECONDS = 0.35;

type HtmlNode = {
  nodeName?: string;
  tagName?: string;
  value?: string;
  attrs?: Array<{name: string; value: string}>;
  childNodes?: HtmlNode[];
};

type TimelineEntry = {
  index: number;
  char: string;
  group_order: number;
  start: number;
  end: number;
};

type MgMode = "together" | "split";

type LocatedTag = {
  tag: string;
  group: string;
  mode: MgMode;
  value?: string;
  text: string;
  start: number;
  end: number;
  paragraphEnd: number;
};

type GroupInfo = {
  tag: string;
  group: string;
  mode: MgMode;
  tags: LocatedTag[];
  paragraphEnd: number;
};

type RawFunctionCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

type ResolvedCall = RawFunctionCall & {
  group: string;
  at: number;
  template: string;
  spec: unknown;
};

type SceneOverlay = {
  group: string;
  spec: unknown;
  fromFrame: number;
  durationFrames: number;
};

type ScenePlan = {
  id: string;
  compositionId: string;
  group: string;
  mode: MgMode;
  template: string;
  renderMode: "replace" | "overlay";
  start: number;
  end: number;
  startFrame: number;
  endFrame: number;
  durationFrames: number;
  timelineOffsetFrames: number;
  sourceText: string;
  specFile: string;
  clipFile: string;
  baseFile?: string;
  background: string;
  overlays: SceneOverlay[];
  spec: unknown;
};

type VideoInfo = {
  width: number;
  height: number;
  fps: number;
  duration: number;
  durationFrames: number;
};

const MG_TAGS = new Set([
  "progress-timeline",
  "timed-table",
  "directed-graph",
  "side-by-side-comparison",
  "weighted-comparison",
  "decomposition",
  "xy-chart",
  "multi-series-chart",
  "containment",
  "collage-network",
  "title",
  "emphasis",
]);

const TAG_FUNCTIONS: Record<string, string[]> = {
  "progress-timeline": ["create_progress_timeline"],
  "timed-table": ["create_timed_table"],
  "directed-graph": ["create_directed_graph_timeline"],
  "side-by-side-comparison": ["create_side_by_side_comparison"],
  "weighted-comparison": ["create_weighted_comparison"],
  decomposition: ["create_decomposition_timeline"],
  "xy-chart": ["create_xy_chart_timeline"],
  "multi-series-chart": ["create_multi_series_bar_chart", "create_multi_series_line_chart"],
  containment: ["create_containment_timeline"],
  "collage-network": ["create_collage_network"],
  title: ["create_title_cue"],
  emphasis: ["create_emphasis_text_cue"],
};

const FUNCTION_DEFINITIONS = [
  progressTimelineFunctionDefinition,
  timedTableFunctionDefinition,
  directedGraphFunctionDefinition,
  titleFunctionDefinition,
  emphasisFunctionDefinition,
  xyChartFunctionDefinition,
  multiSeriesBarChartFunctionDefinition,
  multiSeriesLineChartFunctionDefinition,
  containmentFunctionDefinition,
  decompositionFunctionDefinition,
  weightedComparisonFunctionDefinition,
  sideBySideComparisonFunctionDefinition,
  collageNetworkFunctionDefinition,
];

const TEMPLATE_BY_FUNCTION: Record<string, string> = {
  create_progress_timeline: "progress-timeline",
  create_timed_table: "timed-table",
  create_directed_graph_timeline: "directed-graph",
  create_title_cue: "title",
  create_emphasis_text_cue: "emphasis",
  create_xy_chart_timeline: "xy-chart",
  create_multi_series_bar_chart: "multi-series-chart",
  create_multi_series_line_chart: "multi-series-chart",
  create_containment_timeline: "containment",
  create_decomposition_timeline: "decomposition",
  create_weighted_comparison: "weighted-comparison",
  create_side_by_side_comparison: "side-by-side-comparison",
  create_collage_network: "collage-network",
};

const BACKGROUND_BY_TEMPLATE: Record<string, string> = {
  "progress-timeline": "#f4f1ea",
  "timed-table": "#171c20",
  "directed-graph": "#191d21",
  title: "#171c20",
  emphasis: "#111111",
  "xy-chart": "#f3f0e9",
  "multi-series-chart": "#171c20",
  containment: "#f4f1ea",
  decomposition: "#f3efe6",
  "weighted-comparison": "#171d1f",
  "side-by-side-comparison": "#f3efe6",
  "collage-network": "#eee9de",
};

const textContent = (node: HtmlNode): string => {
  if (node.nodeName === "#text") return node.value ?? "";
  return (node.childNodes ?? []).map(textContent).join("");
};

const descendants = (node: HtmlNode, predicate: (candidate: HtmlNode) => boolean): HtmlNode[] => {
  const found: HtmlNode[] = [];
  const visit = (candidate: HtmlNode) => {
    if (predicate(candidate)) found.push(candidate);
    for (const child of candidate.childNodes ?? []) visit(child);
  };
  visit(node);
  return found;
};

const attrsOf = (node: HtmlNode): Record<string, string> =>
  Object.fromEntries((node.attrs ?? []).map((attr) => [attr.name, attr.value]));

const sha256 = async (filePath: string): Promise<string> => {
  const data = await fs.readFile(filePath);
  return createHash("sha256").update(data).digest("hex");
};

const round3 = (value: number) => Math.round(value * 1000) / 1000;

const parseRate = (rate: string): number => {
  const [numerator, denominator = "1"] = rate.split("/");
  return Number(numerator) / Number(denominator);
};

const probeVideo = async (filePath: string): Promise<VideoInfo> => {
  const {stdout} = await execFileAsync("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height,r_frame_rate,nb_frames:format=duration",
    "-of", "json",
    filePath,
  ]);
  const probe = JSON.parse(stdout) as {streams?: Array<Record<string, string | number>>; format?: Record<string, string>};
  const stream = probe.streams?.[0];
  if (!stream) throw new Error("ep01_raw.mp4 缺少视频流");
  const fps = parseRate(String(stream.r_frame_rate));
  const duration = Number(probe.format?.duration);
  const durationFrames = Number(stream.nb_frames) || Math.round(duration * fps);
  const width = Number(stream.width);
  const height = Number(stream.height);
  if (![fps, duration, durationFrames, width, height].every(Number.isFinite)) throw new Error("无法读取原片媒体信息");
  return {fps, duration, durationFrames, width, height};
};

const locateHtmlGroups = (html: string, timeline: TimelineEntry[], articleSource: string): Map<string, GroupInfo> => {
  const document = parse5.parse(html);
  const article = descendants(document, (node) => node.tagName === "article")[0];
  if (!article) throw new Error("MG 标注 HTML 中找不到 article");
  const paragraphs = descendants(article, (node) => node.tagName === "p");
  const plainArticle = paragraphs.map((paragraph) => textContent(paragraph).trim()).join("\n\n");
  if (plainArticle !== articleSource.trim()) throw new Error("HTML 去标签后的正文与原文_clean.txt 不一致");

  const timelineText = timeline.map((entry) => entry.char).join("");
  const charOffsets: number[] = [];
  let charCursor = 0;
  timeline.forEach((entry) => {
    charOffsets.push(charCursor);
    charCursor += entry.char.length;
  });
  const entryAtOffset = (offset: number): TimelineEntry => {
    let low = 0;
    let high = timeline.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const start = charOffsets[middle];
      const end = start + timeline[middle].char.length;
      if (offset < start) high = middle - 1;
      else if (offset >= end) low = middle + 1;
      else return timeline[middle];
    }
    throw new Error(`时间轴字符偏移越界: ${offset}`);
  };

  const located: LocatedTag[] = [];
  let timelineCursor = 0;
  for (const paragraph of paragraphs) {
    const paragraphText = textContent(paragraph).trim();
    const paragraphOffset = timelineText.indexOf(paragraphText, timelineCursor);
    if (paragraphOffset < 0) throw new Error(`正文段落无法映射到字级时间轴: ${paragraphText.slice(0, 40)}`);
    timelineCursor = paragraphOffset + paragraphText.length;
    const paragraphEnd = entryAtOffset(paragraphOffset + paragraphText.length - 1).end;
    let relativeOffset = 0;

    const walk = (node: HtmlNode) => {
      if (node.nodeName === "#text") {
        relativeOffset += (node.value ?? "").length;
        return;
      }
      const startOffset = relativeOffset;
      for (const child of node.childNodes ?? []) walk(child);
      const endOffset = relativeOffset;
      if (!node.tagName || !MG_TAGS.has(node.tagName)) return;
      const attrs = attrsOf(node);
      const group = attrs.group;
      const mode = attrs.mode;
      if (!group || !/^[A-Za-z0-9_-]+$/.test(group)) throw new Error(`<${node.tagName}> 缺少合法 group`);
      if (mode !== "together" && mode !== "split") throw new Error(`<${node.tagName}> 的 mode 必须是 together 或 split`);
      if ("at" in attrs) throw new Error(`<${node.tagName}> 不应在第一阶段 HTML 中包含 at`);
      const startEntry = entryAtOffset(paragraphOffset + startOffset);
      const endEntry = entryAtOffset(paragraphOffset + endOffset - 1);
      located.push({
        tag: node.tagName,
        group,
        mode,
        value: attrs.value,
        text: textContent(node),
        start: startEntry.start,
        end: endEntry.end,
        paragraphEnd,
      });
    };
    for (const child of paragraph.childNodes ?? []) walk(child);
  }

  const groups = new Map<string, GroupInfo>();
  for (const tag of located.sort((left, right) => left.start - right.start || right.end - left.end)) {
    const current = groups.get(tag.group);
    if (!current) {
      groups.set(tag.group, {tag: tag.tag, group: tag.group, mode: tag.mode, tags: [tag], paragraphEnd: tag.paragraphEnd});
      continue;
    }
    if (current.tag !== tag.tag) throw new Error(`group ${tag.group} 混用了 ${current.tag} 和 ${tag.tag}`);
    if (current.mode !== tag.mode) throw new Error(`group ${tag.group} 的 mode 不一致`);
    current.tags.push(tag);
    current.paragraphEnd = Math.max(current.paragraphEnd, tag.paragraphEnd);
  }
  return groups;
};

const toChatTool = (definition: any) => ({
  type: "function" as const,
  function: {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    strict: definition.strict,
  },
});

const requestFunctionCalls = async (
  client: OpenAI,
  model: string,
  html: string,
  timelineRaw: string,
  repairFeedback = "",
): Promise<RawFunctionCall[]> => {
  const response = await client.chat.completions.create({
    model,
    max_tokens: 20000,
    parallel_tool_calls: true,
    messages: [
      {
        role: "system",
        content: [
          "你是 Story Claw 的第二阶段 MG Function Calling 编排器。",
          "你会直接收到第一阶段 AI 输出的完整 HTML 和原始字级时间戳 JSON；不得要求代码先把标签转成结构化事实。",
          "必须为 HTML 中每个不同的 group 恰好调用一次与标签名对应的函数，包括嵌套标签；不得漏组、合并组或为不存在的标签调用函数。",
          "标签映射：progress-timeline→create_progress_timeline；timed-table→create_timed_table；directed-graph→create_directed_graph_timeline；side-by-side-comparison→create_side_by_side_comparison；weighted-comparison→create_weighted_comparison；decomposition→create_decomposition_timeline；xy-chart→create_xy_chart_timeline；multi-series-chart→在 bar/line 两个函数中择一；containment→create_containment_timeline；collage-network→create_collage_network；title→create_title_cue；emphasis→create_emphasis_text_cue。",
          "所有 at 都必须是整集时间轴的绝对秒数，直接复制对应文字第一个字的 start；禁止输出相对 0 秒。根级 at 必须等于该 group 最早标签文字的 start。",
          "每个会逐步出现的节点、单元格、边、组成部分、对比项、关键帧、数据点、实体或关系都必须有自己的 at。表格表头等模型新增元素使用根级 at。",
          "group 必须逐字复制 HTML 属性。mode 只属于 HTML，任何 Function Call 都不得输出 mode。",
          "只填可见语义内容与时间。不要输出 action、motion、progress、detail、kind、assetSrc、chartType、sequence、source 或其他模板样式参数。",
          "动态表格使用 6 行 2 列：第一行是表头，后五行分别承载五项财务指标；每个单元格显式填写 row、column、text、at。",
          "有向图要形成可验证的连续飞轮：除第一条边外，每条边的 from 必须是之前已经出现的节点。",
          "普通左右对比不得虚构权重；没有自然强调时 highlights 传空数组。拆解模板不写详情。",
          "多系列图必须保留 2022/2023/2024 的六个原始数值以及亏损 -19 的负号。",
          "重点大字不超过 16 个汉字。不得输出普通文本，只输出工具调用。",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          repairFeedback ? `上一次调用未通过校验，请完全重做并修复：\n${repairFeedback}\n` : "",
          "第一阶段 HTML：",
          html,
          "\n原始字级时间戳 JSON：",
          timelineRaw,
        ].join("\n"),
      },
    ],
    tools: FUNCTION_DEFINITIONS.map(toChatTool),
    tool_choice: "required",
  } as any);

  const toolCalls = response.choices[0]?.message?.tool_calls ?? [];
  if (toolCalls.length === 0) throw new Error("模型没有返回任何 Function Call");
  return toolCalls.map((call) => {
    const functionCall = (call as any).function as {name: string; arguments: string};
    if (!functionCall) throw new Error("模型返回了非函数类型的工具调用");
    return {
      id: call.id,
      name: functionCall.name,
      arguments: JSON.parse(functionCall.arguments) as Record<string, unknown>,
    };
  });
};

const assetForCollageNode = (node: {id: string; label: string}): string | undefined => {
  const key = `${node.id} ${node.label}`.toLowerCase();
  const candidates: Array<[RegExp, string]> = [
    [/(microsoft|微软)/i, "microsoft.svg"],
    [/(openai)/i, "openai.svg"],
    [/(amazon|亚马逊|aws)/i, "amazon.svg"],
    [/(anthropic)/i, "anthropic.svg"],
    [/(google|谷歌)/i, "google.svg"],
    [/(nvidia|英伟达)/i, "nvidia.svg"],
  ];
  const match = candidates.find(([pattern]) => pattern.test(key));
  return match ? `ai-company-logos/${match[1]}` : undefined;
};

const resolveOneCall = (call: RawFunctionCall): ResolvedCall => {
  const args = call.arguments as any;
  let resolved: {group: string; at: number; spec: unknown};
  switch (call.name) {
    case "create_progress_timeline": resolved = resolveProgressTimelineFunctionArgs(args); break;
    case "create_timed_table": resolved = resolveTimedTableFunctionArgs(args); break;
    case "create_directed_graph_timeline": resolved = resolveDirectedGraphFunctionArgs(args); break;
    case "create_title_cue": resolved = resolveTitleFunctionArgs(args); break;
    case "create_emphasis_text_cue": resolved = resolveEmphasisFunctionArgs(args); break;
    case "create_xy_chart_timeline": resolved = resolveXYChartFunctionArgs(args); break;
    case "create_multi_series_bar_chart": resolved = resolveMultiSeriesChartFunctionArgs(args, "bar"); break;
    case "create_multi_series_line_chart": resolved = resolveMultiSeriesChartFunctionArgs(args, "line"); break;
    case "create_containment_timeline": resolved = resolveContainmentFunctionArgs(args); break;
    case "create_decomposition_timeline": resolved = resolveDecompositionFunctionArgs(args); break;
    case "create_weighted_comparison": resolved = resolveWeightedComparisonFunctionArgs(args); break;
    case "create_side_by_side_comparison": resolved = resolveSideBySideComparisonFunctionArgs(args); break;
    case "create_collage_network": resolved = resolveCollageNetworkFunctionArgs(args, {resolveAsset: assetForCollageNode}); break;
    default: throw new Error(`未知 Function Call: ${call.name}`);
  }
  return {...call, ...resolved, template: TEMPLATE_BY_FUNCTION[call.name]};
};

const elementAts = (call: RawFunctionCall): number[] => {
  const args = call.arguments as any;
  switch (call.name) {
    case "create_progress_timeline": return (args.nodes ?? []).map((item: any) => item.at);
    case "create_timed_table": return (args.cells ?? []).map((item: any) => item.at);
    case "create_directed_graph_timeline": return (args.edges ?? []).map((item: any) => item.at);
    case "create_title_cue":
    case "create_emphasis_text_cue": return [args.at];
    case "create_xy_chart_timeline": return (args.keyframes ?? []).map((item: any) => item.at);
    case "create_multi_series_bar_chart":
    case "create_multi_series_line_chart": return (args.series ?? []).flatMap((series: any) => (series.data ?? []).map((item: any) => item.at));
    case "create_containment_timeline": return [...(args.relations ?? []), ...(args.highlights ?? [])].map((item: any) => item.at);
    case "create_decomposition_timeline": return [...(args.parts ?? []), ...(args.highlights ?? [])].map((item: any) => item.at);
    case "create_weighted_comparison":
    case "create_side_by_side_comparison": return [...(args.items ?? []), ...(args.highlights ?? [])].map((item: any) => item.at);
    case "create_collage_network": return [...(args.nodes ?? []), ...(args.edges ?? [])].map((item: any) => item.at);
    default: return [];
  }
};

const validateAndResolveCalls = (rawCalls: RawFunctionCall[], groups: Map<string, GroupInfo>): ResolvedCall[] => {
  const errors: string[] = [];
  const callsByGroup = new Map<string, RawFunctionCall>();
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

  const resolved: ResolvedCall[] = [];
  for (const [groupName, group] of groups) {
    const call = callsByGroup.get(groupName);
    if (!call) continue;
    const allowed = TAG_FUNCTIONS[group.tag] ?? [];
    if (!allowed.includes(call.name)) {
      errors.push(`group ${groupName} 的 <${group.tag}> 错用了 ${call.name}`);
      continue;
    }
    if ("mode" in call.arguments) errors.push(`group ${groupName} 不应在 Function Call 输出 mode`);
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
      errors.push(`group ${groupName} 存在超出所属段落范围的元素 at`);
    }
    try {
      resolved.push(resolveOneCall(call));
    } catch (error) {
      errors.push(`group ${groupName} 参数校验失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (errors.length) throw new Error(errors.join("\n"));
  return resolved.sort((left, right) => left.at - right.at);
};

const buildScenes = (
  calls: ResolvedCall[],
  groups: Map<string, GroupInfo>,
  video: VideoInfo,
): ScenePlan[] => {
  const rootFrame = (at: number) => Math.max(0, Math.round(at * video.fps));
  const mainScenes: ScenePlan[] = [];
  const emphasisCalls = calls.filter((call) => call.template === "emphasis");

  for (const call of calls.filter((candidate) => candidate.template !== "emphasis")) {
    const group = groups.get(call.group)!;
    const specFile = `specs/${call.group}.json`;
    if (group.mode === "together") {
      const startFrame = rootFrame(call.at);
      const endFrame = Math.min(video.durationFrames, Math.max(startFrame + 1, Math.ceil(group.paragraphEnd * video.fps)));
      mainScenes.push({
        id: call.group,
        compositionId: "",
        group: call.group,
        mode: group.mode,
        template: call.template,
        renderMode: "replace",
        start: startFrame / video.fps,
        end: endFrame / video.fps,
        startFrame,
        endFrame,
        durationFrames: endFrame - startFrame,
        timelineOffsetFrames: 0,
        sourceText: group.tags.map((tag) => tag.text).join("｜"),
        specFile,
        clipFile: "",
        background: BACKGROUND_BY_TEMPLATE[call.template],
        overlays: [],
        spec: call.spec,
      });
      continue;
    }

    const callRootFrame = rootFrame(call.at);
    group.tags.forEach((tag, index) => {
      const startFrame = rootFrame(tag.start);
      const nextStart = group.tags[index + 1]?.start;
      const naturalEnd = startFrame + Math.round(SPLIT_VISIBLE_SECONDS * video.fps);
      const beforeNext = nextStart === undefined ? video.durationFrames : Math.floor((nextStart - 0.04) * video.fps);
      const endFrame = Math.min(video.durationFrames, Math.max(startFrame + 1, Math.min(naturalEnd, beforeNext)));
      mainScenes.push({
        id: `${call.group}-${String(index + 1).padStart(2, "0")}`,
        compositionId: "",
        group: call.group,
        mode: group.mode,
        template: call.template,
        renderMode: "replace",
        start: startFrame / video.fps,
        end: endFrame / video.fps,
        startFrame,
        endFrame,
        durationFrames: endFrame - startFrame,
        timelineOffsetFrames: startFrame - callRootFrame,
        sourceText: tag.text,
        specFile,
        clipFile: "",
        background: BACKGROUND_BY_TEMPLATE[call.template],
        overlays: [],
        spec: call.spec,
      });
    });
  }

  for (const call of emphasisCalls) {
    const group = groups.get(call.group)!;
    const startFrame = rootFrame(call.at);
    const contentEnd = Math.max(group.tags.at(-1)!.end + 0.25, call.at + 0.8);
    const requestedEndFrame = Math.min(video.durationFrames, Math.ceil(contentEnd * video.fps));
    const owner = mainScenes.find((scene) => startFrame >= scene.startFrame && startFrame < scene.endFrame);
    if (owner) {
      owner.overlays.push({
        group: call.group,
        spec: call.spec,
        fromFrame: startFrame - owner.startFrame,
        durationFrames: Math.max(1, Math.min(requestedEndFrame, owner.endFrame) - startFrame),
      });
      continue;
    }
    const endFrame = Math.max(startFrame + 1, requestedEndFrame);
    mainScenes.push({
      id: call.group,
      compositionId: "",
      group: call.group,
      mode: group.mode,
      template: call.template,
      renderMode: "overlay",
      start: startFrame / video.fps,
      end: endFrame / video.fps,
      startFrame,
      endFrame,
      durationFrames: endFrame - startFrame,
      timelineOffsetFrames: 0,
      sourceText: group.tags.map((tag) => tag.text).join("｜"),
      specFile: `specs/${call.group}.json`,
      clipFile: "",
      baseFile: `${PUBLIC_BASE_PREFIX}/${call.group}.mp4`,
      background: BACKGROUND_BY_TEMPLATE.emphasis,
      overlays: [],
      spec: call.spec,
    });
  }

  const scenes = mainScenes.sort((left, right) => left.startFrame - right.startFrame || left.endFrame - right.endFrame);
  for (let index = 0; index < scenes.length; index++) {
    const scene = scenes[index];
    const previous = scenes[index - 1];
    if (previous && scene.startFrame < previous.endFrame) {
      throw new Error(`MG 场景重叠: ${previous.id} 与 ${scene.id}`);
    }
    scene.compositionId = `GoogleOptimized${String(index + 1).padStart(2, "0")}`;
    scene.clipFile = `clips/${scene.id}.mp4`;
  }
  return scenes;
};

const prepareOverlayBases = async (scenes: ScenePlan[], video: VideoInfo) => {
  await fs.mkdir(PUBLIC_BASE_DIR, {recursive: true});
  for (const scene of scenes.filter((candidate) => candidate.renderMode === "overlay")) {
    const outputPath = path.join(PUBLIC_BASE_DIR, `${scene.group}.mp4`);
    await execFileAsync("ffmpeg", [
      "-y",
      "-i", RAW_VIDEO_PATH,
      "-vf", `trim=start=${scene.start.toFixed(6)}:end=${scene.end.toFixed(6)},setpts=PTS-STARTPTS,fps=${video.fps},scale=${video.width}:${video.height},setsar=1`,
      "-frames:v", String(scene.durationFrames),
      "-an",
      "-c:v", "libx264",
      "-preset", "fast",
      "-crf", "18",
      "-pix_fmt", "yuv420p",
      outputPath,
    ], {maxBuffer: 20 * 1024 * 1024});
  }
};

const main = async () => {
  const [html, timelineRaw, articleSource, configRaw, rawHash, video] = await Promise.all([
    fs.readFile(HTML_PATH, "utf-8"),
    fs.readFile(TIMELINE_PATH, "utf-8"),
    fs.readFile(ARTICLE_PATH, "utf-8"),
    fs.readFile(path.join(os.homedir(), ".story-claw", "config.json"), "utf-8"),
    sha256(RAW_VIDEO_PATH),
    probeVideo(RAW_VIDEO_PATH),
  ]);
  const timeline = JSON.parse(timelineRaw) as TimelineEntry[];
  const config = JSON.parse(configRaw) as {api_key: string; base_url?: string; model: string};
  const client = new OpenAI({
    apiKey: config.api_key,
    baseURL: config.base_url ?? "https://api.openai.com/v1",
    timeout: 600_000,
    maxRetries: 1,
  });

  let groups: Map<string, GroupInfo> | undefined;
  let rawCalls: RawFunctionCall[] = [];
  let resolvedCalls: ResolvedCall[] = [];
  let feedback = "";
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`[第二阶段 AI] Function Calling 第 ${attempt}/3 次`);
    try {
      rawCalls = await requestFunctionCalls(client, config.model, html, timelineRaw, feedback);
      groups ??= locateHtmlGroups(html, timeline, articleSource);
      resolvedCalls = validateAndResolveCalls(rawCalls, groups);
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
      feedback = error instanceof Error ? error.message : String(error);
      console.warn(`[第二阶段 AI] 第 ${attempt}/3 次未通过:\n${feedback}`);
    }
  }
  if (lastError || !groups || resolvedCalls.length === 0) throw lastError ?? new Error("Function Calling 未产生可用结果");

  const scenes = buildScenes(resolvedCalls, groups, video);
  await Promise.all([fs.mkdir(SPECS_DIR, {recursive: true}), fs.mkdir(path.dirname(GENERATED_BUNDLE_PATH), {recursive: true})]);
  await Promise.all(resolvedCalls.map((call) =>
    fs.writeFile(path.join(SPECS_DIR, `${call.group}.json`), `${JSON.stringify(call.spec, null, 2)}\n`, "utf-8"),
  ));
  await prepareOverlayBases(scenes, video);

  const plan = {
    version: 2,
    architecture: {
      stage1: "AI outputs HTML tags with group and together/split mode, without at",
      stage2: "AI reads the raw HTML and word timestamps, then emits one Function Call per group with absolute at values",
      code: "validates calls, resolves local time, applies mode, renders and assembles",
    },
    source: {
      rawVideo: RAW_VIDEO_PATH,
      sha256: rawHash,
      ...video,
      html: HTML_PATH,
      timeline: TIMELINE_PATH,
      subtitles: path.join(EP_DIR, "global_subtitles.ass"),
    },
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
    scenes: scenes.map(({spec, ...scene}) => scene),
  };
  await fs.mkdir(OUTPUT_DIR, {recursive: true});
  await fs.writeFile(path.join(OUTPUT_DIR, "function_calls.json"), `${JSON.stringify(plan.functionCalls, null, 2)}\n`, "utf-8");
  await fs.writeFile(path.join(OUTPUT_DIR, "mg_plan.json"), `${JSON.stringify(plan, null, 2)}\n`, "utf-8");
  await fs.writeFile(GENERATED_BUNDLE_PATH, `${JSON.stringify({fps: video.fps, width: video.width, height: video.height, scenes}, null, 2)}\n`, "utf-8");

  console.log(`[第二阶段 AI] ${resolvedCalls.length} 个 group 全部通过参数与时间校验`);
  console.log(`[模式] split 生成 ${scenes.filter((scene) => scene.mode === "split").length} 个短片段，together/overlay 生成 ${scenes.filter((scene) => scene.mode !== "split").length} 个片段`);
  console.log(`[计划] ${path.join(OUTPUT_DIR, "mg_plan.json")}`);
  console.log(`[Remotion] ${GENERATED_BUNDLE_PATH}`);
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
