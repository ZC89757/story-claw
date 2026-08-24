import {CollageNetworkEdge, CollageNetworkEdgeState, CollageNetworkNode, CollageNetworkNodeState} from "./types";

export const NODE_REVEAL_DURATION = 0.58;
export const EDGE_DRAW_DURATION = 0.72;
export const EDGE_LABEL_DELAY = 0.36;
export const EDGE_LABEL_DURATION = 0.3;
export const EDGE_FOCUS_DURATION = 2.45;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const easeOutBack = (value: number) => {
  const c1 = 1.35;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(value - 1, 3) + c1 * Math.pow(value - 1, 2);
};
const easeOutCubic = (value: number) => 1 - Math.pow(1 - value, 3);
const smoothstep = (value: number) => value * value * (3 - 2 * value);

export const evaluateCollageNetworkNode = (node: CollageNetworkNode, seconds: number): CollageNetworkNodeState => ({
  progress: easeOutBack(clamp01((seconds - node.at) / NODE_REVEAL_DURATION)),
});

export const evaluateCollageNetworkEdge = (edge: CollageNetworkEdge, seconds: number): CollageNetworkEdgeState => {
  const elapsed = seconds - edge.at;
  const attack = smoothstep(clamp01(elapsed / 0.42));
  const release = 1 - smoothstep(clamp01((elapsed - 1.78) / (EDGE_FOCUS_DURATION - 1.78)));
  return {
    lineProgress: easeOutCubic(clamp01(elapsed / EDGE_DRAW_DURATION)),
    labelProgress: easeOutCubic(clamp01((elapsed - EDGE_LABEL_DELAY) / EDGE_LABEL_DURATION)),
    focusProgress: attack * release,
  };
};
