import {CSSProperties} from "react";
import {AbsoluteFill, Audio, Img, OffthreadVideo, useCurrentFrame, useVideoConfig} from "remotion";
import {evaluateProgressTimeline} from "./evaluate";
import {ProgressDetail, ProgressTimelineSpec} from "./types";

type Props = {spec: ProgressTimelineSpec; audioSrc?: string; style?: CSSProperties};
const WIDTH = 1920;
const TRACK_WIDTH = 4300;
const TRACK_LEFT = 250;
const TRACK_Y = 690;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const nodeX = (progress: number) => TRACK_LEFT + (progress / 100) * (TRACK_WIDTH - TRACK_LEFT * 2);
const smooth = (value: number) => value * value * (3 - 2 * value);

const cameraForProgress = (spec: ProgressTimelineSpec, progress: number) => {
  if (!spec.followViewport) return 0;
  const majors = spec.nodes.filter((node) => node.kind === "major");
  if (majors.length < 2) return 0;
  const nextIndex = majors.findIndex((node) => node.progress >= progress);
  const rightIndex = nextIndex < 0 ? majors.length - 1 : Math.max(1, nextIndex);
  const leftIndex = rightIndex - 1;
  const left = majors[leftIndex];
  const right = majors[rightIndex];
  const pairOffset = (a: number, b: number) => clamp((nodeX(a) + nodeX(b)) / 2 - WIDTH / 2, 0, TRACK_WIDTH - WIDTH);
  const previousOffset = leftIndex > 0 ? pairOffset(majors[leftIndex - 1].progress, left.progress) : pairOffset(left.progress, right.progress);
  const nextOffset = pairOffset(left.progress, right.progress);
  const ratio = right.progress === left.progress ? 1 : clamp((progress - left.progress) / (right.progress - left.progress), 0, 1);
  return previousOffset + (nextOffset - previousOffset) * smooth(ratio);
};

const DetailContent = ({detail}: {detail: ProgressDetail}) => {
  if (detail.type === "text") return <div style={{fontSize: 34, lineHeight: 1.45, fontWeight: 700}}>{detail.value}</div>;
  const mediaStyle: CSSProperties = {width: 480, height: 230, objectFit: "cover", display: "block"};
  return <>
    {detail.type === "image" ? <Img src={detail.src} style={mediaStyle} /> : <OffthreadVideo src={detail.src} muted style={mediaStyle} />}
    <div style={{fontSize: 25, fontWeight: 700, marginTop: 14}}>{detail.caption}</div>
  </>;
};

export const ProgressTimelineTemplate = ({spec, audioSrc, style}: Props) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const seconds = frame / fps;
  const state = evaluateProgressTimeline(spec, seconds);
  const camera = cameraForProgress(spec, state.progress);
  const active = spec.nodes[state.activeIndex];
  const detailAge = Math.max(0, seconds - active.at);
  const detailReveal = smooth(clamp(detailAge / 0.45, 0, 1));

  return <AbsoluteFill style={{background: "#f4f1ea", color: "#17201b", fontFamily: '"Microsoft YaHei", Arial, sans-serif', overflow: "hidden", ...style}}>
    {audioSrc ? <Audio src={audioSrc} /> : null}
    <div style={{position: "absolute", left: 118, top: 74, zIndex: 5}}>
      <div style={{fontSize: 24, fontWeight: 800, color: "#b33b2f", marginBottom: 12}}>{Math.round(state.progress)}%</div>
      <div style={{fontSize: 58, fontWeight: 900}}>{spec.title}</div>
      <div style={{fontSize: 27, color: "#677068", marginTop: 12}}>{spec.subtitle}</div>
    </div>

    <div style={{position: "absolute", left: 118, top: 270, width: 760, minHeight: 245, padding: "34px 40px", boxSizing: "border-box", background: "#fffdfa", borderLeft: "10px solid #b33b2f", boxShadow: "0 18px 55px rgba(23,32,27,.12)", opacity: detailReveal, transform: `translateY(${(1 - detailReveal) * 24}px)`}}>
      <div style={{fontSize: 23, fontWeight: 900, color: "#b33b2f", marginBottom: 10}}>{active.eyebrow}</div>
      <div style={{fontSize: 43, fontWeight: 900, marginBottom: 16}}>{active.title}</div>
      <DetailContent detail={active.detail} />
    </div>

    <div style={{position: "absolute", left: 0, top: 0, width: TRACK_WIDTH, height: 1080, transform: `translateX(${-camera}px)`}}>
      <div style={{position: "absolute", left: TRACK_LEFT, top: TRACK_Y, width: TRACK_WIDTH - TRACK_LEFT * 2, height: 10, background: "#d4d2ca"}} />
      <div style={{position: "absolute", left: TRACK_LEFT, top: TRACK_Y, width: Math.max(0, nodeX(state.progress) - TRACK_LEFT), height: 10, background: "#b33b2f"}} />
      {spec.nodes.map((node, index) => {
        const x = nodeX(node.progress);
        const complete = state.progress >= node.progress;
        const isActive = index === state.activeIndex;
        const size = node.kind === "major" ? 54 : 28;
        return <div key={node.id} style={{position: "absolute", left: x, top: TRACK_Y + 5, transform: "translate(-50%, -50%)"}}>
          <div style={{width: size, height: size, borderRadius: "50%", background: complete ? "#b33b2f" : "#f4f1ea", border: `${node.kind === "major" ? 8 : 5}px solid ${complete ? "#b33b2f" : "#949991"}`, boxSizing: "border-box", boxShadow: isActive ? "0 0 0 15px rgba(179,59,47,.16)" : "none"}} />
          <div style={{position: "absolute", width: node.kind === "major" ? 300 : 230, left: "50%", transform: "translateX(-50%)", top: node.kind === "major" ? 62 : 42, textAlign: "center"}}>
            <div style={{fontSize: node.kind === "major" ? 34 : 23, fontWeight: 900, color: complete ? "#17201b" : "#858a83"}}>{node.title}</div>
            <div style={{fontSize: 19, marginTop: 7, color: "#7a8079"}}>{node.eyebrow}</div>
          </div>
        </div>;
      })}
      <div style={{position: "absolute", left: nodeX(state.progress), top: TRACK_Y - 60, transform: "translateX(-50%)"}}>
        <div style={{width: 3, height: 52, background: "#17201b", margin: "0 auto"}} />
        <div style={{width: 18, height: 18, borderRadius: "50%", background: "#17201b", margin: "0 auto"}} />
      </div>
    </div>
  </AbsoluteFill>;
};
