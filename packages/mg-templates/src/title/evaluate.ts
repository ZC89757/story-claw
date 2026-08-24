import {TitleSpec} from "./types";

export const titleElapsed = (spec: TitleSpec, seconds: number) => Math.max(0, seconds - spec.at);
export const titleHasStarted = (spec: TitleSpec, seconds: number) => seconds >= spec.at;
export const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
export const easeOutCubic = (value: number) => 1 - Math.pow(1 - clamp01(value), 3);
