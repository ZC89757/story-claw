import {CSSProperties} from "react";

export type AxisDefinition = {
  min: number;
  max: number;
  meaning: string;
  unit: string;
  ticks: number;
};

export type ChartAxes = {
  x: AxisDefinition;
  y: AxisDefinition;
};

export type ChartPoint = {
  x: number;
  y: number;
  label?: string;
};

export type MovementMode = "ease" | "instant";

export type ChartMotionSpec = {
  axes: ChartAxes;
  keyframes: Record<string, ChartPoint>;
  movement: MovementMode;
};

type TimedPoint = ChartPoint & {time: number};

const assertFinite = (value: number, field: string) => {
  if (!Number.isFinite(value)) throw new Error(`${field} must be finite`);
};

export const validateChartMotionSpec = (spec: ChartMotionSpec): TimedPoint[] => {
  for (const [name, axis] of Object.entries(spec.axes)) {
    assertFinite(axis.min, `${name}.min`);
    assertFinite(axis.max, `${name}.max`);
    if (axis.max <= axis.min) throw new Error(`${name}.max must be greater than min`);
    if (!Number.isInteger(axis.ticks) || axis.ticks < 2) throw new Error(`${name}.ticks must be an integer >= 2`);
  }
  if (spec.movement !== "ease" && spec.movement !== "instant") {
    throw new Error("movement must be ease or instant");
  }

  const points = Object.entries(spec.keyframes)
    .map(([rawTime, point]) => ({...point, time: Number(rawTime)}))
    .sort((a, b) => a.time - b.time);
  if (points.length === 0) throw new Error("keyframes must not be empty");

  points.forEach((point, index) => {
    assertFinite(point.time, `keyframes[${index}].time`);
    assertFinite(point.x, `keyframes[${index}].x`);
    assertFinite(point.y, `keyframes[${index}].y`);
    if (point.time < 0) throw new Error("keyframe time must be >= 0");
    if (point.x < spec.axes.x.min || point.x > spec.axes.x.max) throw new Error(`x=${point.x} is outside the axis range`);
    if (point.y < spec.axes.y.min || point.y > spec.axes.y.max) throw new Error(`y=${point.y} is outside the axis range`);
  });
  return points;
};

const easeInOutCubic = (value: number) =>
  value < 0.5 ? 4 * value * value * value : 1 - Math.pow(-2 * value + 2, 3) / 2;

export const evaluateChartPoint = (spec: ChartMotionSpec, seconds: number): ChartPoint => {
  const points = validateChartMotionSpec(spec);
  if (seconds <= points[0].time) return points[0];
  const nextIndex = points.findIndex((point) => point.time >= seconds);
  if (nextIndex === -1) return points[points.length - 1];

  const previous = points[nextIndex - 1];
  const next = points[nextIndex];
  if (spec.movement === "instant") return seconds < next.time ? previous : next;

  const linear = (seconds - previous.time) / Math.max(0.0001, next.time - previous.time);
  const progress = easeInOutCubic(Math.max(0, Math.min(1, linear)));
  return {
    x: previous.x + (next.x - previous.x) * progress,
    y: previous.y + (next.y - previous.y) * progress,
    label: progress < 0.5 ? previous.label : next.label,
  };
};

export const sampleChartTrail = (spec: ChartMotionSpec, seconds: number, sampleRate = 30) => {
  const samples = Math.max(1, Math.ceil(seconds * sampleRate));
  return Array.from({length: samples + 1}, (_, index) =>
    evaluateChartPoint(spec, Math.min(seconds, index / sampleRate)),
  );
};

type RisingChartTemplateProps = {
  axes: ChartAxes;
  point: ChartPoint;
  trail: ChartPoint[];
  accent?: string;
  style?: CSSProperties;
};

const WIDTH = 1180;
const HEIGHT = 610;
const PLOT = {left: 118, right: 58, top: 52, bottom: 92};

const tickValues = (axis: AxisDefinition) =>
  Array.from({length: axis.ticks}, (_, index) => axis.min + (index / (axis.ticks - 1)) * (axis.max - axis.min));

const formatTick = (value: number) => Number.isInteger(value) ? value.toLocaleString("zh-CN") : value.toFixed(1);

export const RisingChartTemplate = ({axes, point, trail, accent = "#d94e3f", style}: RisingChartTemplateProps) => {
  const plotWidth = WIDTH - PLOT.left - PLOT.right;
  const plotHeight = HEIGHT - PLOT.top - PLOT.bottom;
  const toPixel = (dataPoint: ChartPoint) => ({
    x: PLOT.left + ((dataPoint.x - axes.x.min) / (axes.x.max - axes.x.min)) * plotWidth,
    y: PLOT.top + (1 - (dataPoint.y - axes.y.min) / (axes.y.max - axes.y.min)) * plotHeight,
  });
  const pixelPoint = toPixel(point);
  const path = trail.map((trailPoint, index) => {
    const pixel = toPixel(trailPoint);
    return `${index === 0 ? "M" : "L"} ${pixel.x.toFixed(2)} ${pixel.y.toFixed(2)}`;
  }).join(" ");

  return (
    <div style={{width: WIDTH, height: HEIGHT, background: "#fffdfa", border: "1px solid #d8d5ce", ...style}}>
      <svg width={WIDTH} height={HEIGHT} viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
        {tickValues(axes.y).map((tick) => {
          const y = toPixel({x: axes.x.min, y: tick}).y;
          return <g key={`y-${tick}`}>
            <line x1={PLOT.left} y1={y} x2={WIDTH - PLOT.right} y2={y} stroke="#ddd9d1" strokeWidth="2" />
            <text x={PLOT.left - 20} y={y + 8} textAnchor="end" fontSize="22" fill="#6d706b">{formatTick(tick)}</text>
          </g>;
        })}
        {tickValues(axes.x).map((tick) => {
          const x = toPixel({x: tick, y: axes.y.min}).x;
          return <g key={`x-${tick}`}>
            <line x1={x} y1={PLOT.top} x2={x} y2={HEIGHT - PLOT.bottom} stroke="#ece9e2" strokeWidth="2" />
            <text x={x} y={HEIGHT - PLOT.bottom + 36} textAnchor="middle" fontSize="22" fill="#6d706b">{formatTick(tick)}</text>
          </g>;
        })}
        <line x1={PLOT.left} y1={PLOT.top} x2={PLOT.left} y2={HEIGHT - PLOT.bottom} stroke="#1d211f" strokeWidth="4" />
        <line x1={PLOT.left} y1={HEIGHT - PLOT.bottom} x2={WIDTH - PLOT.right} y2={HEIGHT - PLOT.bottom} stroke="#1d211f" strokeWidth="4" />
        <text x={PLOT.left + plotWidth / 2} y={HEIGHT - 22} textAnchor="middle" fontSize="25" fontWeight="700" fill="#1d211f">
          {axes.x.meaning}{axes.x.unit ? `（${axes.x.unit}）` : ""}
        </text>
        <text transform={`translate(30 ${PLOT.top + plotHeight / 2}) rotate(-90)`} textAnchor="middle" fontSize="25" fontWeight="700" fill="#1d211f">
          {axes.y.meaning}{axes.y.unit ? `（${axes.y.unit}）` : ""}
        </text>
        {path ? <path d={path} fill="none" stroke={accent} strokeWidth="9" strokeLinecap="round" strokeLinejoin="round" /> : null}
        <line x1={pixelPoint.x} y1={pixelPoint.y} x2={pixelPoint.x} y2={HEIGHT - PLOT.bottom} stroke={accent} strokeWidth="3" strokeDasharray="8 8" opacity="0.45" />
        <line x1={PLOT.left} y1={pixelPoint.y} x2={pixelPoint.x} y2={pixelPoint.y} stroke={accent} strokeWidth="3" strokeDasharray="8 8" opacity="0.45" />
        <circle cx={pixelPoint.x} cy={pixelPoint.y} r="16" fill="#fffdfa" stroke={accent} strokeWidth="8" />
        <g transform={`translate(${Math.min(pixelPoint.x + 22, WIDTH - 270)} ${Math.max(pixelPoint.y - 74, 18)})`}>
          <rect width="238" height="58" fill="#1d211f" />
          <text x="119" y="38" textAnchor="middle" fontSize="23" fontWeight="700" fill="#fff">
            {point.label ?? `(${point.x.toFixed(1)}, ${point.y.toFixed(1)})`}
          </text>
        </g>
      </svg>
    </div>
  );
};
