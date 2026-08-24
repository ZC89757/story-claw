import {CSSProperties, useMemo} from "react";
import {AbsoluteFill, Audio, useCurrentFrame, useVideoConfig} from "remotion";
import {evaluateDecompositionEvent} from "./evaluate";
import {DecompositionSpec, ExtractPartEvent} from "./types";

type Props = {spec: DecompositionSpec; audioSrc?: string; style?: CSSProperties};
type Position = {x: number; y: number};

const WIDTH = 1920;
const HEIGHT = 1080;
const CENTER = {x: WIDTH / 2, y: HEIGHT / 2 + 25};
const COLORS = ["#ef6841", "#2f8f83", "#d89b2b", "#527eb5", "#8c68a9", "#c35f7c", "#657239", "#8b6650"];

const makePositions = (count: number): Position[] => Array.from({length: count}, (_, index) => {
  const angle = -Math.PI / 2 + index / count * Math.PI * 2;
  return {x: CENTER.x + Math.cos(angle) * 650, y: CENTER.y + Math.sin(angle) * 360};
});

export const DecompositionTemplate = ({spec, audioSrc, style}: Props) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const seconds = frame / fps;
  const extracts = useMemo(() => spec.events.filter((event): event is ExtractPartEvent => event.action === "extract"), [spec]);
  const positions = useMemo(() => makePositions(extracts.length), [extracts.length]);
  const latestHighlight = [...spec.events].reverse().find((event) => event.action === "highlight" && event.at <= seconds);
  const highlightTarget = latestHighlight?.action === "highlight" ? latestHighlight.target : undefined;
  const highlightProgress = latestHighlight ? evaluateDecompositionEvent(latestHighlight, seconds).progress : 0;
  const revealed = extracts.reduce((count, event) => count + evaluateDecompositionEvent(event, seconds).progress, 0);

  return <AbsoluteFill style={{background: "#f3efe6", color: "#20292c", fontFamily: '"Microsoft YaHei", Arial, sans-serif', overflow: "hidden", ...style}}>
    {audioSrc ? <Audio src={audioSrc} /> : null}
    <div style={{position: "absolute", inset: 0, backgroundImage: "linear-gradient(#d6d0c5 1px, transparent 1px), linear-gradient(90deg, #d6d0c5 1px, transparent 1px)", backgroundSize: "54px 54px", opacity: 0.25}} />
    <div style={{position: "absolute", left: 68, top: 50, maxWidth: 1300, fontSize: 38, lineHeight: 1.1, fontWeight: 900, color: "#20292c"}}>{spec.title ?? "整体拆解"}</div>
    <svg width={WIDTH} height={HEIGHT} style={{position: "absolute", inset: 0}}>
      {extracts.map((event, index) => {
        const progress = evaluateDecompositionEvent(event, seconds).progress;
        const target = positions[index];
        const x2 = CENTER.x + (target.x - CENTER.x) * progress;
        const y2 = CENTER.y + (target.y - CENTER.y) * progress;
        return <line key={event.part} x1={CENTER.x} y1={CENTER.y} x2={x2} y2={y2} stroke={COLORS[index]} strokeWidth={3} strokeDasharray="9 9" opacity={progress * 0.75} />;
      })}
    </svg>
    <div style={{position: "absolute", left: CENTER.x - 180, top: CENTER.y - 145, width: 360, height: 290, border: "5px solid #20292c", background: "#fffdf8", boxShadow: "12px 12px 0 #d7d0c4", display: "flex", alignItems: "center", justifyContent: "center", padding: 34, boxSizing: "border-box", transform: `scale(${1 - Math.min(0.08, revealed * 0.012)})`}}>
      <div style={{fontSize: spec.whole.length > 10 ? 34 : 42, lineHeight: 1.15, fontWeight: 900, textAlign: "center"}}>{spec.whole}</div>
      <div style={{position: "absolute", left: 20, right: 20, bottom: 18, display: "flex", gap: 7}}>{extracts.map((event, index) => <div key={event.part} style={{height: 8, flex: 1, background: COLORS[index], opacity: evaluateDecompositionEvent(event, seconds).progress}} />)}</div>
    </div>
    {extracts.map((event, index) => {
      const progress = evaluateDecompositionEvent(event, seconds).progress;
      const target = positions[index];
      const x = CENTER.x + (target.x - CENTER.x) * progress;
      const y = CENTER.y + (target.y - CENTER.y) * progress;
      const focused = highlightTarget === event.part;
      const dimmed = highlightTarget && !focused;
      return <div key={event.part} style={{position: "absolute", left: x - 170, top: y - 72, width: 340, minHeight: 144, padding: "27px 25px", boxSizing: "border-box", background: "#fffdf8", border: `4px solid ${COLORS[index]}`, boxShadow: focused ? `0 0 0 ${12 * highlightProgress}px ${COLORS[index]}35` : "8px 8px 0 #d7d0c4", opacity: progress * (dimmed ? 1 - highlightProgress * 0.72 : 1), transform: `scale(${0.72 + progress * 0.28 + (focused ? highlightProgress * 0.05 : 0)})`, transformOrigin: "center", display: "flex", flexDirection: "column", justifyContent: "center"}}>
        <div style={{fontSize: event.part.length > 10 ? 25 : 31, fontWeight: 900, color: COLORS[index], lineHeight: 1.18, textAlign: "center"}}>{event.part}</div>
      </div>;
    })}
  </AbsoluteFill>;
};
