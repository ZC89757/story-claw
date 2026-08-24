import {ContainmentEvent, ContainmentEventState} from "./types";

export const CONTAIN_DURATION = 0.7;
export const HIGHLIGHT_DURATION = 0.45;
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const easeOutCubic = (value: number) => 1 - Math.pow(1 - value, 3);

export const evaluateContainmentEvent = (event: ContainmentEvent, seconds: number): ContainmentEventState => {
  const duration = event.action === "contain" ? CONTAIN_DURATION : HIGHLIGHT_DURATION;
  return {progress: easeOutCubic(clamp01((seconds - event.at) / duration))};
};
