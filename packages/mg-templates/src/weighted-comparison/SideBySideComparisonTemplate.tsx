import {CSSProperties} from "react";
import {AbsoluteFill, Audio, useCurrentFrame, useVideoConfig} from "remotion";
import {getSideBySideComparisonState} from "./helpers";
import {ComparisonSide, SideBySideComparisonSpec} from "./types";

type Props = {spec: SideBySideComparisonSpec; audioSrc?: string; style?: CSSProperties};
const COLORS = {left: "#2f8f83", right: "#ef6841"};

export const SideBySideComparisonTemplate = ({spec, audioSrc, style}: Props) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const state = getSideBySideComparisonState(spec, frame / fps);
  const sideOpacity = (side: ComparisonSide) => state.highlightSide && state.highlightSide !== side ? 1 - state.highlightProgress * 0.76 : 1;

  return <AbsoluteFill style={{background: "#f3efe6", color: "#20292c", fontFamily: '"Microsoft YaHei", Arial, sans-serif', overflow: "hidden", ...style}}>
    {audioSrc ? <Audio src={audioSrc} /> : null}
    <div style={{position: "absolute", inset: 0, backgroundImage: "radial-gradient(#aaa69e 1.2px, transparent 1.2px)", backgroundSize: "36px 36px", opacity: 0.23}} />
    <div style={{position: "absolute", left: 0, right: 0, top: 45, textAlign: "center", fontSize: 47, fontWeight: 900}}>{spec.title}</div>
    {(["left", "right"] as const).map((side) => {
      const points = state.points.filter((point) => point.side === side);
      const color = COLORS[side];
      return <div key={side} style={{position: "absolute", left: side === "left" ? 96 : 1004, top: 150, width: 820, height: 830, padding: 35, boxSizing: "border-box", background: "#fffdf8", borderTop: `10px solid ${color}`, boxShadow: "10px 10px 0 #d4cec2", opacity: sideOpacity(side), transform: `scale(${state.highlightSide === side ? 1 + state.highlightProgress * 0.018 : 1})`}}>
        <div style={{fontSize: 38, lineHeight: 1.12, fontWeight: 900, color, paddingBottom: 23, borderBottom: `3px solid ${color}`}}>{side === "left" ? spec.leftLabel : spec.rightLabel}</div>
        <div style={{marginTop: 28}}>
          {points.map((point, index) => {
            const progress = state.progress.get(point) ?? 0;
            return <div key={`${point.at}-${point.text}`} style={{display: "grid", gridTemplateColumns: "52px 1fr", alignItems: "center", gap: 16, minHeight: 104, marginBottom: 17, padding: "15px 19px", boxSizing: "border-box", border: "2px solid #d8d2c7", background: index % 2 ? "#f6f2ea" : "#fffdf8", opacity: Math.max(0, Math.min(1, progress)), transform: `translateX(${(1 - progress) * (side === "left" ? -42 : 42)}px)`}}>
              <div style={{width: 43, height: 43, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", background: color, color: "white", fontSize: 21, fontWeight: 900}}>{index + 1}</div>
              <div style={{fontSize: 24, lineHeight: 1.35, fontWeight: 750}}>{point.text}</div>
            </div>;
          })}
        </div>
      </div>;
    })}
  </AbsoluteFill>;
};
