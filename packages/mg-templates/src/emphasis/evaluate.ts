import {EmphasisSpec} from "./types";

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

export const emphasisHasStarted = (spec: EmphasisSpec, seconds: number) => seconds >= spec.at;

export const evaluateEmphasis = (spec: EmphasisSpec, seconds: number) => {
  const progress = clamp01((seconds - spec.at) / 0.48);
  const overshoot = progress < 0.72
    ? 1.08 * (1 - Math.pow(1 - progress / 0.72, 3))
    : 1.08 + (1 - 1.08) * ((progress - 0.72) / 0.28);
  return {
    opacity: clamp01(progress / 0.35),
    translateY: (1 - overshoot) * 520,
    scale: 0.92 + overshoot * 0.08,
  };
};
