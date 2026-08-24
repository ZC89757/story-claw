import {
  collageNetworkFunctionDefinition,
  containmentFunctionDefinition,
  decompositionFunctionDefinition,
  directedGraphFunctionDefinition,
  emphasisFunctionDefinition,
  multiSeriesBarChartFunctionDefinition,
  multiSeriesLineChartFunctionDefinition,
  progressTimelineFunctionDefinition,
  resolveCollageNetworkFunctionArgs,
  resolveContainmentFunctionArgs,
  resolveDecompositionFunctionArgs,
  resolveDirectedGraphFunctionArgs,
  resolveEmphasisFunctionArgs,
  resolveMultiSeriesChartFunctionArgs,
  resolveProgressTimelineFunctionArgs,
  resolveSideBySideComparisonFunctionArgs,
  resolveTimedTableFunctionArgs,
  resolveTitleFunctionArgs,
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
  title: ["create_title_cue"],
  emphasis: ["create_emphasis_text_cue"],
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
};

export const OVERLAY_TEMPLATES = new Set<MgTemplateName>(["title", "emphasis"]);

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
    default: throw new Error(`未知 MG Function Call: ${call.name}`);
  }
  const template = TEMPLATE_BY_FUNCTION[call.name];
  if (!template) throw new Error(`Function Call 没有对应模板: ${call.name}`);
  return {...call, ...resolved, template};
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
    default: return [];
  }
};
