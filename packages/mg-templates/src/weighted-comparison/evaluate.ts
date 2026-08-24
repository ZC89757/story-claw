import {WeightedComparisonEventState} from "./types";

export const COMPARISON_ADD_DURATION = 0.62;
export const COMPARISON_HIGHLIGHT_DURATION = 0.4;
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const easeOutBack = (value: number) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(value - 1, 3) + c1 * Math.pow(value - 1, 2);
};
const easeOutCubic = (value: number) => 1 - Math.pow(1 - value, 3);

export const evaluateWeightedComparisonEvent = (event: {at: number; action: "add" | "highlight"}, seconds: number): WeightedComparisonEventState => {
  const ratio = clamp01((seconds - event.at) / (event.action === "add" ? COMPARISON_ADD_DURATION : COMPARISON_HIGHLIGHT_DURATION));
  if (ratio === 0 || ratio === 1) return {progress: ratio};
  return {progress: event.action === "add" ? easeOutBack(ratio) : easeOutCubic(ratio)};
};
