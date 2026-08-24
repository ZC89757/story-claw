import {ChartPoint, XYChartSpec} from "./types";

const easeInOutCubic = (value: number) =>
  value < 0.5 ? 4 * value * value * value : 1 - Math.pow(-2 * value + 2, 3) / 2;

const pointState = ({x, y, label}: XYChartSpec["keyframes"][number]): ChartPoint => ({x, y, label});

/** Returns the chart state at a scene-local time in seconds. */
export const evaluateXYChart = (spec: XYChartSpec, seconds: number): ChartPoint => {
  const points = spec.keyframes;
  if (seconds <= 0) return pointState(points[0]);
  const nextIndex = points.findIndex((point) => point.at >= seconds);
  if (nextIndex < 0) return pointState(points[points.length - 1]);
  const next = points[nextIndex];
  const previous = points[nextIndex - 1];
  if (!previous || seconds === next.at) return pointState(next);
  if (next.motion === "instant") return seconds < next.at ? pointState(previous) : pointState(next);

  const rawProgress = (seconds - previous.at) / (next.at - previous.at);
  const progress = easeInOutCubic(Math.max(0, Math.min(1, rawProgress)));
  return {
    x: previous.x + (next.x - previous.x) * progress,
    y: previous.y + (next.y - previous.y) * progress,
    label: progress < 0.5 ? previous.label : next.label,
  };
};

/** Samples the visible line up to the requested time. */
export const sampleXYChartTrail = (spec: XYChartSpec, seconds: number, fps: number): ChartPoint[] => {
  const count = Math.max(1, Math.ceil(Math.max(0, seconds) * fps));
  return Array.from({length: count + 1}, (_, index) =>
    evaluateXYChart(spec, Math.min(seconds, index / fps)),
  );
};
