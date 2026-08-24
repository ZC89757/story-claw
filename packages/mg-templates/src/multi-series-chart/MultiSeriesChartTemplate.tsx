import {CSSProperties} from "react";
import {AbsoluteFill, Audio, useCurrentFrame, useVideoConfig} from "remotion";
import {evaluateChartDatum} from "./evaluate";
import {MultiSeriesChartSpec} from "./types";

type Props = {spec: MultiSeriesChartSpec; audioSrc?: string; style?: CSSProperties};
const WIDTH = 1920;
const HEIGHT = 1080;
const PLOT = {left: 155, right: 95, top: 190, bottom: 175};
const COLORS = ["#ef6334", "#58a6c4", "#e0b84f", "#69ad78", "#c178c7", "#e58aa1", "#8f9ee8", "#91a16b"];
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export const MultiSeriesChartTemplate = ({spec, audioSrc, style}: Props) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const seconds = frame / fps;
  const plotWidth = WIDTH - PLOT.left - PLOT.right;
  const plotHeight = HEIGHT - PLOT.top - PLOT.bottom;
  const categoryWidth = plotWidth / spec.xAxis.categories.length;
  const toY = (value: number) => PLOT.top + (1 - (value - spec.yAxis.min) / (spec.yAxis.max - spec.yAxis.min)) * plotHeight;
  const baselineValue = clamp(0, spec.yAxis.min, spec.yAxis.max);
  const baselineY = toY(baselineValue);
  const ticks = Array.from({length: spec.yAxis.ticks}, (_, index) => spec.yAxis.min + (spec.yAxis.max - spec.yAxis.min) * index / (spec.yAxis.ticks - 1));

  return <AbsoluteFill style={{background: "#171c20", color: "#eef2f3", fontFamily: '"Microsoft YaHei", Arial, sans-serif', ...style}}>
    {audioSrc ? <Audio src={audioSrc} /> : null}
    <div style={{position: "absolute", left: PLOT.left, top: 62, fontSize: 50, fontWeight: 900}}>{spec.title}</div>
    <div style={{position: "absolute", right: PLOT.right, top: 76, display: "flex", gap: 30}}>
      {spec.series.map((series, index) => <div key={series.name} style={{display: "flex", alignItems: "center", gap: 10, fontSize: 24, fontWeight: 800}}><span style={{width: 22, height: 22, background: COLORS[index], borderRadius: spec.chartType === "line" ? "50%" : 2}} />{series.name}</div>)}
    </div>

    <svg width={WIDTH} height={HEIGHT} viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
      {ticks.map((tick) => {
        const y = toY(tick);
        return <g key={tick}>
          <line x1={PLOT.left} y1={y} x2={WIDTH - PLOT.right} y2={y} stroke="#394349" strokeWidth={2} />
          <text x={PLOT.left - 22} y={y + 8} textAnchor="end" fontSize={24} fill="#9eaaaf">{Number.isInteger(tick) ? tick : tick.toFixed(1)}</text>
        </g>;
      })}
      <line x1={PLOT.left} y1={PLOT.top} x2={PLOT.left} y2={HEIGHT - PLOT.bottom} stroke="#9aa6aa" strokeWidth={4} />
      <line x1={PLOT.left} y1={HEIGHT - PLOT.bottom} x2={WIDTH - PLOT.right} y2={HEIGHT - PLOT.bottom} stroke="#9aa6aa" strokeWidth={4} />
      {spec.xAxis.categories.map((category, index) => {
        const x = PLOT.left + categoryWidth * (index + 0.5);
        return <text key={category} x={x} y={HEIGHT - PLOT.bottom + 48} textAnchor="middle" fontSize={25} fontWeight={750} fill="#cbd3d6">{category}</text>;
      })}
      <text x={PLOT.left + plotWidth / 2} y={HEIGHT - 48} textAnchor="middle" fontSize={27} fontWeight={800} fill="#aeb8bc">{spec.xAxis.label}</text>
      <text transform={`translate(48 ${PLOT.top + plotHeight / 2}) rotate(-90)`} textAnchor="middle" fontSize={27} fontWeight={800} fill="#aeb8bc">{spec.yAxis.label}{spec.yAxis.unit ? `（${spec.yAxis.unit}）` : ""}</text>

      {spec.chartType === "bar" ? spec.series.flatMap((series, seriesIndex) => series.data.map((datum, categoryIndex) => {
        const progress = evaluateChartDatum(datum, seconds);
        const groupWidth = categoryWidth * 0.7;
        const gap = Math.min(10, groupWidth * 0.04);
        const barWidth = Math.max(8, (groupWidth - gap * (spec.series.length - 1)) / spec.series.length);
        const groupLeft = PLOT.left + categoryWidth * categoryIndex + (categoryWidth - groupWidth) / 2;
        const x = groupLeft + seriesIndex * (barWidth + gap);
        const currentValue = baselineValue + (datum.value - baselineValue) * progress;
        const currentY = toY(currentValue);
        const y = Math.min(baselineY, currentY);
        const height = Math.abs(baselineY - currentY);
        return <g key={`${series.name}-${categoryIndex}`}>
          <rect x={x} y={y} width={barWidth} height={height} fill={COLORS[seriesIndex]} rx={2} />
          {progress > 0.72 ? <text x={x + barWidth / 2} y={y - 12} textAnchor="middle" fontSize={21} fontWeight={900} fill={COLORS[seriesIndex]} opacity={(progress - 0.72) / 0.28}>{datum.value}</text> : null}
        </g>;
      })) : spec.series.map((series, seriesIndex) => <g key={series.name}>
        {series.data.map((datum, index) => {
          const progress = evaluateChartDatum(datum, seconds);
          const x = PLOT.left + categoryWidth * (index + 0.5);
          const y = toY(datum.value);
          const previous = series.data[index - 1];
          if (!previous) return <g key={index} opacity={progress}><circle cx={x} cy={y} r={10} fill="#171c20" stroke={COLORS[seriesIndex]} strokeWidth={6} /></g>;
          const previousX = PLOT.left + categoryWidth * (index - 0.5);
          const previousY = toY(previous.value);
          const currentX = previousX + (x - previousX) * progress;
          const currentY = previousY + (y - previousY) * progress;
          return <g key={index}>
            <line x1={previousX} y1={previousY} x2={currentX} y2={currentY} stroke={COLORS[seriesIndex]} strokeWidth={7} strokeLinecap="round" />
            {progress > 0 ? <circle cx={currentX} cy={currentY} r={10} fill="#171c20" stroke={COLORS[seriesIndex]} strokeWidth={6} /> : null}
            {progress > 0.72 ? <text x={x} y={y - 18} textAnchor="middle" fontSize={21} fontWeight={900} fill={COLORS[seriesIndex]} opacity={(progress - 0.72) / 0.28}>{datum.value}</text> : null}
          </g>;
        })}
      </g>)}
    </svg>
  </AbsoluteFill>;
};
