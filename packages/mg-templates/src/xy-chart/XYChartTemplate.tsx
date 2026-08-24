import {CSSProperties} from "react";
import {AbsoluteFill, useCurrentFrame, useVideoConfig} from "remotion";
import {evaluateXYChart, sampleXYChartTrail} from "./evaluate";
import {ChartPoint, XYChartSpec, XYChartTheme} from "./types";

const DEFAULT_THEME: XYChartTheme = {
  background: "#f3f0e9",
  panel: "#fffdfa",
  ink: "#19201c",
  muted: "#747971",
  grid: "#ddd9d1",
  accent: "#d94e3f",
};

type XYChartTemplateProps = {
  spec: XYChartSpec;
  theme?: Partial<XYChartTheme>;
  style?: CSSProperties;
};

const CHART = {width: 1920, height: 1080, left: 160, right: 125, top: 175, bottom: 170};

const ticks = (min: number, max: number, count: number) =>
  Array.from({length: count}, (_, index) => min + ((max - min) * index) / (count - 1));

const formatTick = (value: number, unit: string) => {
  if (unit === "年" && Number.isInteger(value) && value >= 1000 && value <= 3000) return String(value);
  return Number.isInteger(value) ? value.toLocaleString("zh-CN") : value.toFixed(1);
};

export const XYChartTemplate = ({spec, theme: themeOverrides, style}: XYChartTemplateProps) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const seconds = frame / fps;
  const point = evaluateXYChart(spec, seconds);
  const trail = sampleXYChartTrail(spec, seconds, fps);
  const theme = {...DEFAULT_THEME, ...themeOverrides};
  const plotWidth = CHART.width - CHART.left - CHART.right;
  const plotHeight = CHART.height - CHART.top - CHART.bottom;
  const toPixel = (value: ChartPoint) => ({
    x: CHART.left + ((value.x - spec.axes.x.min) / (spec.axes.x.max - spec.axes.x.min)) * plotWidth,
    y: CHART.top + (1 - (value.y - spec.axes.y.min) / (spec.axes.y.max - spec.axes.y.min)) * plotHeight,
  });
  const pixelPoint = toPixel(point);
  const path = trail.map((trailPoint, index) => {
    const pixel = toPixel(trailPoint);
    return `${index === 0 ? "M" : "L"} ${pixel.x.toFixed(2)} ${pixel.y.toFixed(2)}`;
  }).join(" ");
  const labelX = Math.min(pixelPoint.x + 28, CHART.width - 360);
  const labelY = Math.max(44, pixelPoint.y - 92);

  return (
    <AbsoluteFill style={{background: theme.background, color: theme.ink, fontFamily: '"Microsoft YaHei", Arial, sans-serif', ...style}}>
      <div style={{position: "absolute", left: CHART.left, top: 72, fontSize: 54, fontWeight: 900}}>{spec.title}</div>
      <svg width={CHART.width} height={CHART.height} viewBox={`0 0 ${CHART.width} ${CHART.height}`}>
        <rect x={CHART.left - 1} y={CHART.top - 1} width={plotWidth + 2} height={plotHeight + 2} fill={theme.panel} stroke={theme.grid} />
        {ticks(spec.axes.y.min, spec.axes.y.max, spec.axes.y.ticks).map((tick) => {
          const y = toPixel({x: spec.axes.x.min, y: tick, label: ""}).y;
          return <g key={`y-${tick}`}>
            <line x1={CHART.left} y1={y} x2={CHART.width - CHART.right} y2={y} stroke={theme.grid} strokeWidth="2" />
            <text x={CHART.left - 22} y={y + 8} textAnchor="end" fontSize="26" fill={theme.muted}>{formatTick(tick, spec.axes.y.unit)}</text>
          </g>;
        })}
        {ticks(spec.axes.x.min, spec.axes.x.max, spec.axes.x.ticks).map((tick) => {
          const x = toPixel({x: tick, y: spec.axes.y.min, label: ""}).x;
          return <g key={`x-${tick}`}>
            <line x1={x} y1={CHART.top} x2={x} y2={CHART.height - CHART.bottom} stroke={theme.grid} strokeWidth="2" />
            <text x={x} y={CHART.height - CHART.bottom + 42} textAnchor="middle" fontSize="26" fill={theme.muted}>{formatTick(tick, spec.axes.x.unit)}</text>
          </g>;
        })}
        <line x1={CHART.left} y1={CHART.top} x2={CHART.left} y2={CHART.height - CHART.bottom} stroke={theme.ink} strokeWidth="5" />
        <line x1={CHART.left} y1={CHART.height - CHART.bottom} x2={CHART.width - CHART.right} y2={CHART.height - CHART.bottom} stroke={theme.ink} strokeWidth="5" />
        <text x={CHART.left + plotWidth / 2} y={CHART.height - 54} textAnchor="middle" fontSize="31" fontWeight="700" fill={theme.ink}>
          {spec.axes.x.label}{spec.axes.x.unit ? `（${spec.axes.x.unit}）` : ""}
        </text>
        <text transform={`translate(52 ${CHART.top + plotHeight / 2}) rotate(-90)`} textAnchor="middle" fontSize="31" fontWeight="700" fill={theme.ink}>
          {spec.axes.y.label}{spec.axes.y.unit ? `（${spec.axes.y.unit}）` : ""}
        </text>
        <path d={path} fill="none" stroke={theme.accent} strokeWidth="11" strokeLinecap="round" strokeLinejoin="round" />
        <line x1={pixelPoint.x} y1={pixelPoint.y} x2={pixelPoint.x} y2={CHART.height - CHART.bottom} stroke={theme.accent} strokeWidth="3" strokeDasharray="10 10" opacity="0.45" />
        <line x1={CHART.left} y1={pixelPoint.y} x2={pixelPoint.x} y2={pixelPoint.y} stroke={theme.accent} strokeWidth="3" strokeDasharray="10 10" opacity="0.45" />
        <circle cx={pixelPoint.x} cy={pixelPoint.y} r="19" fill={theme.panel} stroke={theme.accent} strokeWidth="9" />
        <g transform={`translate(${labelX} ${labelY})`}>
          <rect width="310" height="66" fill={theme.ink} rx="4" />
          <text x="155" y="43" textAnchor="middle" fontSize="26" fontWeight="700" fill="#fff">{point.label}</text>
        </g>
      </svg>
    </AbsoluteFill>
  );
};
