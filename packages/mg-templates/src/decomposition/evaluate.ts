import {DecompositionEvent, DecompositionEventState} from "./types";

export const EXTRACT_DURATION = 0.72;
export const PART_HIGHLIGHT_DURATION = 0.42;
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const easeOutCubic = (value: number) => 1 - Math.pow(1 - value, 3);

export const evaluateDecompositionEvent = (event: DecompositionEvent, seconds: number): DecompositionEventState => {
  const duration = event.action === "extract" ? EXTRACT_DURATION : PART_HIGHLIGHT_DURATION;
  return {progress: easeOutCubic(clamp01((seconds - event.at) / duration))};
};
