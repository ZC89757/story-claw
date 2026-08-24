import {DirectedGraphEdge, DirectedGraphEdgeState} from "./types";

const EDGE_DRAW_DURATION = 0.55;
const NODE_REVEAL_DURATION = 0.35;
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const easeOutCubic = (value: number) => 1 - Math.pow(1 - value, 3);

export const evaluateDirectedGraphEdge = (edge: DirectedGraphEdge, seconds: number): DirectedGraphEdgeState => ({
  lineProgress: easeOutCubic(clamp01((seconds - edge.at) / EDGE_DRAW_DURATION)),
  nodeProgress: easeOutCubic(clamp01((seconds - edge.at - EDGE_DRAW_DURATION) / NODE_REVEAL_DURATION)),
});
