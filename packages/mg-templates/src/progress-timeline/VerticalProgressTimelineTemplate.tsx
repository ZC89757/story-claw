import {CSSProperties} from "react";
import {AbsoluteFill, Audio, Img, OffthreadVideo, useCurrentFrame, useVideoConfig} from "remotion";
import {evaluateProgressTimeline} from "./evaluate";
import {ProgressDetail, ProgressTimelineSpec} from "./types";

type Props = {spec: ProgressTimelineSpec; audioSrc?: string; style?: CSSProperties};

const TRACK_X = 150;
const TRACK_TOP = 250;
const TRACK_HEIGHT = 3000;
const FOCUS_Y = 535;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const nodeY = (progress: number) => TRACK_TOP + (progress / 100) * TRACK_HEIGHT;
const smooth = (value: number) => value * value * (3 - 2 * value);

const DetailContent = ({detail}: {detail: ProgressDetail}) => {
  if (detail.type === "text") {
    return <div style={{fontSize: 34, lineHeight: 1.55, fontWeight: 650, color: "#243138"}}>{detail.value}</div>;
  }
  const mediaStyle: CSSProperties = {display: "block", width: "100%", height: 250, objectFit: "cover"};
  return <>
    {detail.type === "image"
      ? <Img src={detail.src} style={mediaStyle} />
      : <OffthreadVideo src={detail.src} muted style={mediaStyle} />}
    <div style={{fontSize: 25, lineHeight: 1.4, color: "#3c4b52", marginTop: 16}}>{detail.caption}</div>
  </>;
};

export const VerticalProgressTimelineTemplate = ({spec, audioSrc, style}: Props) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const seconds = frame / fps;
  const state = evaluateProgressTimeline(spec, seconds);
  const active = spec.nodes[state.activeIndex];
  const cameraY = spec.followViewport ? FOCUS_Y - nodeY(state.progress) : 0;
  const reveal = smooth(clamp((seconds - active.at) / 0.4, 0, 1));
  const activeY = nodeY(state.progress);

  return <AbsoluteFill style={{background: "#191d21", color: "#eaf0f2", fontFamily: '"Microsoft YaHei", Arial, sans-serif', overflow: "hidden", ...style}}>
    {audioSrc ? <Audio src={audioSrc} /> : null}

    <div style={{position: "absolute", left: 700, top: -155, width: 1370, height: 1370, borderRadius: "50%", background: "#35515d", border: "2px solid rgba(255,255,255,.08)"}} />
    <div style={{position: "absolute", left: 1080, top: 88, color: "#c8d4d8", fontSize: 22, fontWeight: 800, letterSpacing: 0}}>{Math.round(state.progress)}%</div>

    <div style={{position: "absolute", left: 0, top: 0, width: 680, height: TRACK_TOP + TRACK_HEIGHT + 400, transform: `translateY(${cameraY}px)`}}>
      <div style={{position: "absolute", left: TRACK_X - 2, top: TRACK_TOP, width: 4, height: TRACK_HEIGHT, background: "#596168"}} />
      <div style={{position: "absolute", left: TRACK_X - 3, top: TRACK_TOP, width: 6, height: Math.max(0, activeY - TRACK_TOP), background: "#ef5b2a"}} />

      {spec.nodes.map((node, index) => {
        const y = nodeY(node.progress);
        const complete = state.progress >= node.progress;
        const isActive = index === state.activeIndex;
        const size = node.kind === "major" ? 40 : 22;
        return <div key={node.id} style={{position: "absolute", left: TRACK_X, top: y, transform: "translate(-50%, -50%)"}}>
          <div style={{width: size, height: size, borderRadius: "50%", boxSizing: "border-box", background: isActive ? "#dcebf0" : complete ? "#ef5b2a" : "#191d21", border: `${node.kind === "major" ? 5 : 4}px solid ${isActive ? "#eff8fb" : complete ? "#ef5b2a" : "#697178"}`, boxShadow: isActive ? "0 0 0 8px rgba(220,235,240,.18)" : "none"}} />
          <div style={{position: "absolute", left: 58, top: node.kind === "major" ? -39 : -27, width: 450, opacity: isActive ? 1 : complete ? 0.68 : 0.34}}>
            <div style={{fontSize: node.kind === "major" ? 52 : 29, lineHeight: 1, fontWeight: 900, color: isActive ? "#dcebf0" : "#aeb9bd"}}>{node.title}</div>
            <div style={{fontSize: node.kind === "major" ? 27 : 21, marginTop: 13, fontWeight: 700, color: isActive ? "#ffffff" : "#aeb5b8"}}>{node.eyebrow}</div>
          </div>
        </div>;
      })}
    </div>

    <div style={{position: "absolute", left: 900, top: 245, width: 760, minHeight: 470, boxSizing: "border-box", padding: "48px 54px", background: "#f7f8f5", border: "1px solid rgba(255,255,255,.55)", borderRadius: 6, boxShadow: "0 28px 80px rgba(0,0,0,.3)", opacity: reveal, transform: `translateY(${(1 - reveal) * 22}px)`}}>
      <div style={{fontSize: 22, fontWeight: 900, color: "#ef5b2a", marginBottom: 16}}>{active.eyebrow}</div>
      <div style={{fontSize: 57, lineHeight: 1.1, fontWeight: 900, color: "#182329", marginBottom: 28}}>{active.title}</div>
      <DetailContent detail={active.detail} />
    </div>

    <div style={{position: "absolute", left: 900, bottom: 80, width: 760, borderTop: "1px solid rgba(255,255,255,.24)", paddingTop: 22}}>
      <div style={{fontSize: 25, fontWeight: 800, color: "#d9e3e6"}}>{spec.title}</div>
      <div style={{fontSize: 20, color: "#9fb0b6", marginTop: 8}}>{spec.subtitle}</div>
    </div>
  </AbsoluteFill>;
};
