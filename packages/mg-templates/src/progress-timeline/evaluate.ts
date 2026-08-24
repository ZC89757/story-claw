import {ProgressTimelineSpec, ProgressTimelineState} from "./types";

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const easeInOutCubic = (value: number) => value < 0.5
  ? 4 * value * value * value
  : 1 - Math.pow(-2 * value + 2, 3) / 2;

/** Visual timing is a template concern and is deliberately not exposed to the LLM. */
export const PROGRESS_MOVE_DURATION = 0.7;

export const evaluateProgressTimeline = (spec: ProgressTimelineSpec, seconds: number): ProgressTimelineState => {
  let activeIndex = 0;
  for (let index = 1; index < spec.nodes.length; index++) {
    if (spec.nodes[index].at > seconds) break;
    activeIndex = index;
  }
  const current = spec.nodes[activeIndex];
  const previous = spec.nodes[activeIndex - 1];
  if (!previous || current.motion === "instant") {
    return {progress: current.progress, activeIndex};
  }
  const ratio = clamp((seconds - current.at) / PROGRESS_MOVE_DURATION, 0, 1);
  return {
    progress: previous.progress + (current.progress - previous.progress) * easeInOutCubic(ratio),
    activeIndex,
  };
};
