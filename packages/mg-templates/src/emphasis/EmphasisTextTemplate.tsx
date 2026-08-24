import {CSSProperties} from "react";
import {AbsoluteFill, useCurrentFrame, useVideoConfig} from "remotion";
import {emphasisHasStarted, evaluateEmphasis} from "./evaluate";
import {EmphasisSpec} from "./types";

type Props = {spec: EmphasisSpec; style?: CSSProperties};

const fontSizeFor = (text: string) => {
  const length = Array.from(text).length;
  if (length <= 2) return 360;
  if (length <= 4) return 280;
  if (length <= 8) return 175;
  if (length <= 12) return 145;
  return 125;
};

export const EmphasisTextTemplate = ({spec, style}: Props) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const seconds = frame / fps;
  if (!emphasisHasStarted(spec, seconds)) return null;
  const state = evaluateEmphasis(spec, seconds);

  return <AbsoluteFill style={{background: "transparent", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", fontFamily: '"Microsoft YaHei", Arial, sans-serif', ...style}}>
    <div style={{maxWidth: 1700, padding: "0 70px", boxSizing: "border-box", textAlign: "center", color: "#f7f8f8", fontSize: fontSizeFor(spec.text), lineHeight: 1.05, fontWeight: 950, letterSpacing: 0, opacity: state.opacity, transform: `translateY(${state.translateY}px) scale(${state.scale})`, WebkitTextStroke: "3px rgba(20,25,28,.68)", paintOrder: "stroke fill", textShadow: "0 16px 36px rgba(0,0,0,.58), 0 2px 0 rgba(239,91,42,.55)", overflowWrap: "anywhere"}}>{spec.text}</div>
  </AbsoluteFill>;
};
