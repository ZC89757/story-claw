import {MultiSeriesChartDatum} from "./types";

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
export const evaluateChartDatum = (datum: MultiSeriesChartDatum, seconds: number) => {
  const raw = clamp01((seconds - datum.at) / 0.6);
  return raw < 0.5 ? 4 * raw * raw * raw : 1 - Math.pow(-2 * raw + 2, 3) / 2;
};
