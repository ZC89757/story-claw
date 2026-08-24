import {CSSProperties} from "react";
import {AbsoluteFill, Audio, useCurrentFrame, useVideoConfig} from "remotion";
import {evaluateTimedTableCell} from "./evaluate";
import {TimedTableSpec} from "./types";

type Props = {spec: TimedTableSpec; audioSrc?: string; style?: CSSProperties};

const textSize = (text: string, columns: number) => {
  const base = columns >= 4 ? 25 : 30;
  if (text.length > 52) return base - 6;
  if (text.length > 30) return base - 3;
  return base;
};

export const TimedTableTemplate = ({spec, audioSrc, style}: Props) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const seconds = frame / fps;

  return <AbsoluteFill style={{background: "#171c20", color: "#edf1f2", fontFamily: '"Microsoft YaHei", Arial, sans-serif', padding: "78px 90px", boxSizing: "border-box", ...style}}>
    {audioSrc ? <Audio src={audioSrc} /> : null}
    <div style={{display: "grid", gridTemplateColumns: `repeat(${spec.size.columns}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${spec.size.rows}, minmax(0, 1fr))`, width: "100%", height: "100%", borderTop: "3px solid #819097", borderLeft: "3px solid #819097", boxSizing: "border-box"}}>
      {spec.cells.map((cell, index) => {
        const row = Math.floor(index / spec.size.columns);
        const column = index % spec.size.columns;
        const state = evaluateTimedTableCell(cell, seconds);
        const isHeader = row === 0;
        const isLabel = column === 0;
        return <div key={index} style={{position: "relative", display: "flex", alignItems: "center", justifyContent: "center", padding: "20px 24px", boxSizing: "border-box", borderRight: "3px solid #819097", borderBottom: "3px solid #819097", background: isHeader ? "#314b57" : isLabel ? "#222b30" : "#1c2226", overflow: "hidden"}}>
          {state.visible ? <div style={{fontSize: isHeader ? 36 : isLabel ? 30 : textSize(cell.text, spec.size.columns), lineHeight: 1.42, fontWeight: isHeader || isLabel ? 900 : 650, color: isHeader ? "#ffffff" : isLabel ? "#f19a75" : "#e7ecee", textAlign: "center", opacity: state.opacity, transform: `translateY(${state.translateY}px)`, overflowWrap: "anywhere"}}>{cell.text}</div> : null}
        </div>;
      })}
    </div>
  </AbsoluteFill>;
};
