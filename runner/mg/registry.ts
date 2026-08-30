import {
  collageNetworkFunctionDefinition,
  containmentFunctionDefinition,
  decompositionFunctionDefinition,
  directedGraphFunctionDefinition,
  emphasisFunctionDefinition,
  imageGridFunctionDefinition,
  imageStackFunctionDefinition,
  metricFunctionDefinition,
  cameraFunctionDefinition,
  effectFunctionDefinition,
  rhythmFunctionDefinition,
  showcaseFunctionDefinition,
  transitionFunctionDefinition,
  isMgStyleForTemplate,
  mgInstanceKey,
  multiSeriesBarChartFunctionDefinition,
  multiSeriesLineChartFunctionDefinition,
  progressTimelineFunctionDefinition,
  resolveCollageNetworkFunctionArgs,
  resolveContainmentFunctionArgs,
  resolveDecompositionFunctionArgs,
  resolveDirectedGraphFunctionArgs,
  resolveEmphasisFunctionArgs,
  resolveImageGridFunctionArgs,
  resolveImageStackFunctionArgs,
  resolveMetricFunctionArgs,
  resolveCameraFunctionArgs,
  resolveEffectFunctionArgs,
  resolveMultiSeriesChartFunctionArgs,
  resolveProgressTimelineFunctionArgs,
  resolveRhythmFunctionArgs,
  resolveSideBySideComparisonFunctionArgs,
  resolveShowcaseFunctionArgs,
  resolveTimedTableFunctionArgs,
  resolveTitleFunctionArgs,
  resolveTransitionFunctionArgs,
  resolveWeightedComparisonFunctionArgs,
  resolveXYChartFunctionArgs,
  sideBySideComparisonFunctionDefinition,
  timedTableFunctionDefinition,
  titleFunctionDefinition,
  weightedComparisonFunctionDefinition,
  xyChartFunctionDefinition,
} from "@story-claw/mg-templates";
import type {MgTemplateName} from "@story-claw/mg-templates";
import type {RawMgFunctionCall, ResolvedMgFunctionCall} from "./types.js";

export const MG_FUNCTION_DEFINITIONS = [
  progressTimelineFunctionDefinition,
  timedTableFunctionDefinition,
  directedGraphFunctionDefinition,
  titleFunctionDefinition,
  emphasisFunctionDefinition,
  imageStackFunctionDefinition,
  imageGridFunctionDefinition,
  showcaseFunctionDefinition,
  metricFunctionDefinition,
  transitionFunctionDefinition,
  rhythmFunctionDefinition,
  effectFunctionDefinition,
  cameraFunctionDefinition,
  xyChartFunctionDefinition,
  multiSeriesBarChartFunctionDefinition,
  multiSeriesLineChartFunctionDefinition,
  containmentFunctionDefinition,
  decompositionFunctionDefinition,
  weightedComparisonFunctionDefinition,
  sideBySideComparisonFunctionDefinition,
  collageNetworkFunctionDefinition,
] as const;

export const TAG_FUNCTIONS: Record<MgTemplateName, readonly string[]> = {
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
  "image-stack": ["create_image_stack"],
  "image-grid": ["create_image_grid"],
  showcase: ["create_showcase_timeline"],
  metric: ["create_metric_timeline"],
  transition: ["create_transition_cue"],
  rhythm: ["create_rhythm_cue"],
  effect: ["create_effect_cue"],
  camera: ["create_camera_move"],
  title: ["create_title_cue"],
  emphasis: ["create_emphasis_text_cue"],
};

export const functionsForTemplateStyle = (template: MgTemplateName, style: string): readonly string[] => {
  if (template === "multi-series-chart" && style === "bar") return ["create_multi_series_bar_chart"];
  if (template === "multi-series-chart" && style === "line") return ["create_multi_series_line_chart"];
  return TAG_FUNCTIONS[template];
};

export const TEMPLATE_BY_FUNCTION: Record<string, MgTemplateName> = {
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
  create_image_stack: "image-stack",
  create_image_grid: "image-grid",
  create_showcase_timeline: "showcase",
  create_metric_timeline: "metric",
  create_transition_cue: "transition",
  create_rhythm_cue: "rhythm",
  create_effect_cue: "effect",
  create_camera_move: "camera",
};

export const BACKGROUND_BY_TEMPLATE: Record<MgTemplateName, string> = {
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
  "image-stack": "#f3f0e9",
  "image-grid": "#f3f0e9",
  showcase: "#10171b",
  metric: "#0e1519",
  transition: "#111111",
  rhythm: "#111111",
  effect: "#111111",
  camera: "#111111",
};

export const backgroundForTemplateStyle = (template: MgTemplateName, style: string): string => {
  if (template === "progress-timeline" && style === "vertical") return "#191d21";
  if (template === "directed-graph" && style === "radial") return "#f4f0e8";
  return BACKGROUND_BY_TEMPLATE[template];
};

export const OVERLAY_TEMPLATES = new Set<MgTemplateName>(["title", "emphasis", "transition", "rhythm", "effect"]);

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

export const resolveMgFunctionCall = (call: RawMgFunctionCall): ResolvedMgFunctionCall => {
  const args = call.arguments as never;
  let resolved: {group: string; order?: number | null; at: number; spec: unknown};
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
    case "create_image_stack": resolved = resolveImageStackFunctionArgs(args); break;
    case "create_image_grid": resolved = resolveImageGridFunctionArgs(args); break;
    case "create_showcase_timeline": resolved = resolveShowcaseFunctionArgs(args); break;
    case "create_metric_timeline": resolved = resolveMetricFunctionArgs(args); break;
    case "create_transition_cue": resolved = resolveTransitionFunctionArgs(args); break;
    case "create_rhythm_cue": resolved = resolveRhythmFunctionArgs(args); break;
    case "create_effect_cue": resolved = resolveEffectFunctionArgs(args); break;
    case "create_camera_move": resolved = resolveCameraFunctionArgs(args); break;
    default: throw new Error(`未知 MG Function Call: ${call.name}`);
  }
  const template = TEMPLATE_BY_FUNCTION[call.name];
  if (!template) throw new Error(`Function Call 没有对应模板: ${call.name}`);
  if (!isMgStyleForTemplate(template, resolved.group)) {
    throw new Error(`<${template}> 不支持 group 样式 ${resolved.group}`);
  }
  if (!functionsForTemplateStyle(template, resolved.group).includes(call.name)) {
    throw new Error(`<${template}> 的 group 样式 ${resolved.group} 不能调用 ${call.name}`);
  }
  // The Function Calling schema accepts null for a singleton order. Internally
  // the planner/runtime represent that case by omitting order altogether.
  const normalizedOrder = typeof resolved.order === "number" ? resolved.order : undefined;
  return {
    ...call,
    group: resolved.group,
    ...(normalizedOrder === undefined ? {} : {order: normalizedOrder}),
    at: resolved.at,
    spec: resolved.spec,
    instanceKey: mgInstanceKey(template, normalizedOrder),
    template,
  };
};

export const elementAts = (call: RawMgFunctionCall): number[] => {
  const args = call.arguments as any;
  switch (call.name) {
    case "create_progress_timeline": return (args.nodes ?? []).map((item: any) => item.at);
    case "create_timed_table": return (args.cells ?? []).map((item: any) => item.at);
    case "create_directed_graph_timeline": return (args.edges ?? []).map((item: any) => item.at);
    case "create_title_cue":
    case "create_emphasis_text_cue": return [args.at];
    case "create_xy_chart_timeline": return (args.keyframes ?? []).map((item: any) => item.at);
    case "create_multi_series_bar_chart":
    case "create_multi_series_line_chart":
      return (args.series ?? []).flatMap((series: any) => (series.data ?? []).map((item: any) => item.at));
    case "create_containment_timeline":
      return [...(args.relations ?? []), ...(args.highlights ?? [])].map((item: any) => item.at);
    case "create_decomposition_timeline":
      return [...(args.parts ?? []), ...(args.highlights ?? [])].map((item: any) => item.at);
    case "create_weighted_comparison":
    case "create_side_by_side_comparison":
      return [...(args.items ?? []), ...(args.highlights ?? [])].map((item: any) => item.at);
    case "create_collage_network":
      return [...(args.nodes ?? []), ...(args.edges ?? [])].map((item: any) => item.at);
    case "create_image_stack":
    case "create_image_grid":
      return (args.images ?? []).map((item: any) => item.at);
    case "create_showcase_timeline":
      return (args.items ?? []).map((item: any) => item.at);
    case "create_metric_timeline":
      return (args.points ?? []).map((item: any) => item.at);
    case "create_transition_cue":
    case "create_rhythm_cue":
      return [args.at];
    case "create_effect_cue":
    case "create_camera_move":
      return [args.at, ...(args.items ?? []).map((item: any) => item.at)];
    default: return [];
  }
};
