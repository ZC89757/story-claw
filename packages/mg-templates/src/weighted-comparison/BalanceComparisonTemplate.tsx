import {CSSProperties} from "react";
import {AbsoluteFill, Audio, useCurrentFrame, useVideoConfig} from "remotion";
import {getComparisonState} from "./helpers";
import {ComparisonSide, WeightedComparisonSpec} from "./types";

type Props = {spec: WeightedComparisonSpec; audioSrc?: string; style?: CSSProperties};
const WIDTH = 1920;
const HEIGHT = 1080;
const LEFT = "#2f8f83";
const RIGHT = "#ef6841";

export const BalanceComparisonTemplate = ({spec, audioSrc, style}: Props) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const state = getComparisonState(spec, frame / fps);
  const total = Math.max(1, state.leftTotal + state.rightTotal);
  const tilt = Math.max(-10, Math.min(10, (state.rightTotal - state.leftTotal) / total * 16));
  const sideOpacity = (side: ComparisonSide) => state.highlightSide && state.highlightSide !== side ? 1 - state.highlightProgress * 0.72 : 1;

  return <AbsoluteFill style={{background: "#171d1f", color: "#f4f1e9", fontFamily: '"Microsoft YaHei", Arial, sans-serif', overflow: "hidden", ...style}}>
    {audioSrc ? <Audio src={audioSrc} /> : null}
    <div style={{position: "absolute", inset: 0, backgroundImage: "linear-gradient(#2b3335 1px, transparent 1px), linear-gradient(90deg, #2b3335 1px, transparent 1px)", backgroundSize: "58px 58px", opacity: 0.42}} />
    <div style={{position: "absolute", left: 0, right: 0, top: 48, textAlign: "center", fontSize: 46, fontWeight: 900}}>{spec.title}</div>
    {(["left", "right"] as const).map((side) => {
      const points = state.points.filter((point) => point.side === side);
      const color = side === "left" ? LEFT : RIGHT;
      const x = side === "left" ? 92 : 1438;
      return <div key={side} style={{position: "absolute", left: x, top: 158, width: 390, opacity: sideOpacity(side)}}>
        <div style={{fontSize: 31, fontWeight: 900, color, marginBottom: 18}}>{side === "left" ? spec.leftLabel : spec.rightLabel}</div>
        {points.map((point) => {
          const progress = state.progress.get(point) ?? 0;
          return <div key={`${point.at}-${point.text}`} style={{minHeight: 70, marginBottom: 13, padding: "14px 16px", boxSizing: "border-box", borderLeft: `7px solid ${color}`, background: "#f4f1e9", color: "#20292c", fontSize: 20, lineHeight: 1.3, fontWeight: 750, opacity: Math.max(0, Math.min(1, progress)), transform: `translateY(${(1 - progress) * 30}px)`}}>
            {point.text}<span style={{float: "right", color, fontWeight: 900}}>×{point.weight}</span>
          </div>;
        })}
      </div>;
    })}
    <div style={{position: "absolute", left: 585, top: 270, width: 750, height: 650}}>
      <div style={{position: "absolute", left: 364, top: 155, width: 22, height: 390, background: "#d8d2c5"}} />
      <div style={{position: "absolute", left: 293, top: 495, width: 164, height: 32, borderRadius: "50% 50% 0 0", background: "#d8d2c5"}} />
      <div style={{position: "absolute", left: 0, top: 135, width: 750, height: 18, background: "#f4f1e9", transformOrigin: "center", transform: `rotate(${tilt}deg)`, transition: "none"}}>
        {[{side: "left" as const, x: 78, color: LEFT, total: state.leftTotal}, {side: "right" as const, x: 672, color: RIGHT, total: state.rightTotal}].map((pan) => <div key={pan.side} style={{position: "absolute", left: pan.x - 103, top: 0, width: 206, height: 285, opacity: sideOpacity(pan.side), transform: `rotate(${-tilt}deg)`, transformOrigin: "center top"}}>
          <div style={{position: "absolute", left: 100, top: 0, width: 3, height: 168, background: "#9ba3a3"}} />
          <div style={{position: "absolute", left: 18, top: 158, width: 170, height: 24, borderRadius: "0 0 90px 90px", background: pan.color}} />
          <div style={{position: "absolute", left: 42, top: 102, width: 122, display: "flex", flexWrap: "wrap-reverse", justifyContent: "center", alignContent: "flex-end", gap: 4}}>
            {Array.from({length: Math.round(pan.total)}).map((_, index) => <div key={index} style={{width: 24, height: 20, background: pan.color, border: "2px solid #171d1f"}} />)}
          </div>
          <div style={{position: "absolute", top: 200, left: 0, right: 0, textAlign: "center", color: pan.color, fontSize: 28, fontWeight: 900}}>{pan.total.toFixed(1)}</div>
        </div>)}
      </div>
    </div>
  </AbsoluteFill>;
};
