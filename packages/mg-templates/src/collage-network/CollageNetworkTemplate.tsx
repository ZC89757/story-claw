import {CSSProperties, useMemo} from "react";
import {AbsoluteFill, Audio, staticFile, useCurrentFrame, useVideoConfig} from "remotion";
import {EDGE_FOCUS_DURATION, evaluateCollageNetworkEdge, evaluateCollageNetworkNode} from "./evaluate";
import {CollageNetworkEdgeType, CollageNetworkSpec} from "./types";

type Props = {spec: CollageNetworkSpec; audioSrc?: string; style?: CSSProperties};
type Point = {x: number; y: number};
type LayoutNode = Point & {id: string; width: number; height: number; rotation: number};

const WIDTH = 1920;
const HEIGHT = 1080;
const WORLD_CENTER = {x: 960, y: 570};

const EDGE_STYLES: Record<CollageNetworkEdgeType, {color: string; dash?: string; label: string}> = {
  investment: {color: "#d39a2c", label: "战略投资"},
  cloud: {color: "#168c87", label: "云计算合作"},
  supply: {color: "#609236", label: "算力供应"},
  competition: {color: "#c74338", dash: "13 10", label: "市场竞争"},
};

const KIND_LABEL = {model: "模型公司", cloud: "云与平台", chip: "芯片算力"} as const;
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const hash = (text: string) => [...text].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 997, 11);

const resolveAsset = (src: string) => /^(https?:|data:|blob:|\/)/.test(src) ? src : staticFile(src);

const makeLayout = (spec: CollageNetworkSpec) => {
  const count = spec.nodes.length;
  const nodeWidth = count > 7 ? 210 : 252;
  const nodeHeight = count > 7 ? 138 : 158;
  const radiusX = count > 7 ? 665 : 560;
  const radiusY = count > 7 ? 350 : 330;
  const startAngle = -Math.PI * 5 / 6;
  const nodes = new Map<string, LayoutNode>();
  spec.nodes.forEach((node, index) => {
    const angle = startAngle + (index / count) * Math.PI * 2;
    nodes.set(node.id, {
      id: node.id,
      x: WORLD_CENTER.x + Math.cos(angle) * radiusX,
      y: WORLD_CENTER.y + Math.sin(angle) * radiusY,
      width: nodeWidth,
      height: nodeHeight,
      rotation: ((hash(node.id) % 9) - 4) * 0.65,
    });
  });
  return nodes;
};

const rayRectIntersection = (center: Point, toward: Point, width: number, height: number) => {
  const dx = toward.x - center.x;
  const dy = toward.y - center.y;
  const factor = 1 / Math.max(Math.abs(dx) / (width / 2), Math.abs(dy) / (height / 2), 0.001);
  return {x: center.x + dx * factor, y: center.y + dy * factor};
};

const edgeGeometry = (from: LayoutNode, to: LayoutNode, index: number) => {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.max(1, Math.hypot(dx, dy));
  const normal = {x: -dy / length, y: dx / length};
  const bendDirection = ((hash(`${from.id}-${to.id}`) + index) % 2 === 0 ? 1 : -1);
  const bend = Math.min(88, length * 0.14) * bendDirection;
  const control = {x: (from.x + to.x) / 2 + normal.x * bend, y: (from.y + to.y) / 2 + normal.y * bend};
  const start = rayRectIntersection(from, control, from.width + 20, from.height + 20);
  const end = rayRectIntersection(to, control, to.width + 20, to.height + 20);
  return {start, end, control, normal, bendDirection};
};

const quadraticPoint = (start: Point, control: Point, end: Point, progress: number) => {
  const p = clamp01(progress);
  const inv = 1 - p;
  return {
    x: inv * inv * start.x + 2 * inv * p * control.x + p * p * end.x,
    y: inv * inv * start.y + 2 * inv * p * control.y + p * p * end.y,
  };
};

const quadraticTangent = (start: Point, control: Point, end: Point, progress: number) => ({
  x: 2 * (1 - progress) * (control.x - start.x) + 2 * progress * (end.x - control.x),
  y: 2 * (1 - progress) * (control.y - start.y) + 2 * progress * (end.y - control.y),
});

const PaperTexture = () => <>
  <div style={{position: "absolute", inset: 0, backgroundColor: "#eee9de", backgroundImage: "radial-gradient(circle, rgba(32,42,40,.13) 1.15px, transparent 1.3px)", backgroundSize: "18px 18px", opacity: 0.48}} />
  <div style={{position: "absolute", inset: 0, backgroundImage: "repeating-linear-gradient(101deg, transparent 0 31px, rgba(74,66,52,.045) 32px 33px)", opacity: 0.62}} />
  <div style={{position: "absolute", left: -70, top: 148, width: 350, height: 48, background: "#d7ccba", transform: "rotate(-8deg)", opacity: 0.7}} />
  <div style={{position: "absolute", right: -80, bottom: 120, width: 390, height: 54, background: "#d3c7b4", transform: "rotate(7deg)", opacity: 0.62}} />
  <div style={{position: "absolute", left: 82, bottom: 82, width: 92, height: 92, border: "5px solid #283b38", borderRadius: "50%", opacity: 0.16}} />
  <div style={{position: "absolute", right: 108, top: 165, color: "#b84839", fontSize: 70, fontWeight: 300, transform: "rotate(11deg)", opacity: 0.24}}>×</div>
</>;

export const CollageNetworkTemplate = ({spec, audioSrc, style}: Props) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const seconds = frame / fps;
  const layout = useMemo(() => makeLayout(spec), [spec]);
  const edgeStates = spec.edges.map((edge) => evaluateCollageNetworkEdge(edge, seconds));
  const activeEdgeIndex = spec.edges.reduce((active, edge, index) => {
    const elapsed = seconds - edge.at;
    return elapsed >= 0 && elapsed <= EDGE_FOCUS_DURATION ? index : active;
  }, -1);
  const activeEdge = activeEdgeIndex >= 0 ? spec.edges[activeEdgeIndex] : undefined;
  const focus = activeEdgeIndex >= 0 ? edgeStates[activeEdgeIndex].focusProgress : 0;
  const activeFrom = activeEdge ? layout.get(activeEdge.from)! : undefined;
  const activeTo = activeEdge ? layout.get(activeEdge.to)! : undefined;
  const focusTarget = activeFrom && activeTo
    ? {x: (activeFrom.x + activeTo.x) / 2, y: (activeFrom.y + activeTo.y) / 2}
    : WORLD_CENTER;
  const activeDistance = activeFrom && activeTo ? Math.hypot(activeTo.x - activeFrom.x, activeTo.y - activeFrom.y) : 700;
  const desiredScale = Math.min(1.18, Math.max(1.045, 760 / Math.max(activeDistance, 1)));
  const cameraScale = 1 + (desiredScale - 1) * focus;
  const targetX = WORLD_CENTER.x + (focusTarget.x - WORLD_CENTER.x) * focus * 0.34;
  const targetY = WORLD_CENTER.y + (focusTarget.y - WORLD_CENTER.y) * focus * 0.26;
  const cameraX = WORLD_CENTER.x - targetX * cameraScale;
  const cameraY = WORLD_CENTER.y - targetY * cameraScale;
  const intro = clamp01(seconds / 0.7);

  return <AbsoluteFill style={{background: "#eee9de", color: "#1e302d", fontFamily: '"Microsoft YaHei", "Noto Sans SC", Arial, sans-serif', overflow: "hidden", ...style}}>
    {audioSrc ? <Audio src={audioSrc} /> : null}
    <PaperTexture />

    <div style={{position: "absolute", left: 58, top: 42, zIndex: 10, opacity: intro, transform: `translateY(${(1 - intro) * -20}px)`}}>
      <div style={{display: "flex", alignItems: "center", gap: 16}}>
        <div style={{width: 10, height: 62, background: "#bd4437", transform: "rotate(-2deg)"}} />
        <div>
          <div style={{fontSize: 42, lineHeight: 1.05, fontWeight: 950, letterSpacing: 0}}>{spec.title}</div>
          <div style={{marginTop: 9, fontSize: 19, fontWeight: 700, color: "#6c6b61", letterSpacing: 0}}>{spec.subtitle}</div>
        </div>
      </div>
    </div>
    <div style={{position: "absolute", right: 58, top: 49, zIndex: 10, borderTop: "3px solid #273c38", paddingTop: 8, width: 198, fontSize: 15, fontWeight: 900, textAlign: "right", color: "#273c38"}}>RELATION MAP<br/><span style={{color: "#b44337"}}>EDITORIAL / 01</span></div>

    <div style={{position: "absolute", width: WIDTH, height: HEIGHT, transformOrigin: "0 0", transform: `translate(${cameraX}px, ${cameraY}px) scale(${cameraScale})`}}>
      <svg width={WIDTH} height={HEIGHT} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} style={{position: "absolute", inset: 0, overflow: "visible"}}>
        {spec.edges.map((edge, index) => {
          const from = layout.get(edge.from)!;
          const to = layout.get(edge.to)!;
          const geometry = edgeGeometry(from, to, index);
          const state = edgeStates[index];
          const visual = EDGE_STYLES[edge.type];
          const tip = quadraticPoint(geometry.start, geometry.control, geometry.end, state.lineProgress);
          const tangent = quadraticTangent(geometry.start, geometry.control, geometry.end, state.lineProgress);
          const angle = Math.atan2(tangent.y, tangent.x);
          const arrowSize = 14;
          const arrow = [
            tip,
            {x: tip.x - arrowSize * Math.cos(angle - 0.55), y: tip.y - arrowSize * Math.sin(angle - 0.55)},
            {x: tip.x - arrowSize * Math.cos(angle + 0.55), y: tip.y - arrowSize * Math.sin(angle + 0.55)},
          ].map((point) => `${point.x},${point.y}`).join(" ");
          const middle = quadraticPoint(geometry.start, geometry.control, geometry.end, 0.5);
          const labelOffset = 58 * geometry.bendDirection;
          const labelPoint = {x: middle.x + geometry.normal.x * labelOffset, y: middle.y + geometry.normal.y * labelOffset};
          const labelWidth = Math.min(280, Math.max(128, edge.relation.length * 19 + 32));
          const isActive = index === activeEdgeIndex;
          const oldEdgeOpacity = activeEdge ? (isActive ? 1 : 0.34 + 0.24 * (1 - focus)) : 0.82;
          const path = `M ${geometry.start.x} ${geometry.start.y} Q ${geometry.control.x} ${geometry.control.y} ${geometry.end.x} ${geometry.end.y}`;
          const maskId = `edge-reveal-${index}`;
          return <g key={`${edge.from}-${edge.to}-${index}`} opacity={state.lineProgress > 0 ? oldEdgeOpacity : 0}>
            <defs><mask id={maskId}><path d={path} pathLength={1} fill="none" stroke="white" strokeWidth={22} strokeDasharray={1} strokeDashoffset={1 - state.lineProgress} /></mask></defs>
            <g mask={`url(#${maskId})`}>
              <path d={path} fill="none" stroke="#f6f1e7" strokeWidth={10} />
              <path d={path} fill="none" stroke={visual.color} strokeWidth={isActive ? 6 : 4.5} strokeDasharray={visual.dash} />
            </g>
            <polygon points={arrow} fill={visual.color} opacity={state.lineProgress > 0.88 ? clamp01((state.lineProgress - 0.88) / 0.12) : 0} />
            <g opacity={state.labelProgress} transform={`translate(${labelPoint.x} ${labelPoint.y}) rotate(${geometry.bendDirection * -2}) scale(${0.82 + state.labelProgress * 0.18})`}>
              <rect x={-labelWidth / 2 + 4} y={-22 + 5} width={labelWidth} height={44} rx={2} fill="#756d6038" />
              <rect x={-labelWidth / 2} y={-22} width={labelWidth} height={44} rx={2} fill="#f8f2e7" stroke={visual.color} strokeWidth={2.5} />
              <text textAnchor="middle" dominantBaseline="central" fontSize={18} fontWeight={900} fill="#263b37">{edge.relation}</text>
            </g>
          </g>;
        })}
      </svg>

      <div style={{position: "absolute", left: WORLD_CENTER.x - 102, top: WORLD_CENTER.y - 112, width: 204, height: 224, filter: "drop-shadow(8px 10px 0 rgba(50,47,39,.16))", opacity: intro, transform: `scale(${0.82 + intro * 0.18}) rotate(-1deg)`}}>
        <div style={{position: "absolute", inset: 0, background: "#253f3a", clipPath: "polygon(50% 0, 94% 23%, 88% 78%, 50% 100%, 12% 78%, 6% 23%)"}} />
        <div style={{position: "absolute", inset: 10, background: "#e9dfcb", clipPath: "polygon(50% 0, 94% 23%, 88% 78%, 50% 100%, 12% 78%, 6% 23%)"}} />
        <div style={{position: "absolute", inset: 20, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center"}}>
          <div style={{fontSize: 15, fontWeight: 900, color: "#b94538"}}>RELATION</div>
          <div style={{marginTop: 3, fontSize: 34, lineHeight: 1.05, fontWeight: 950}}>关系<br/>网络</div>
          <div style={{width: 52, borderTop: "3px solid #b94538", marginTop: 12}} />
        </div>
      </div>

      {spec.nodes.map((node) => {
        const box = layout.get(node.id)!;
        const progress = evaluateCollageNetworkNode(node, seconds).progress;
        const isRelated = !activeEdge || activeEdge.from === node.id || activeEdge.to === node.id;
        const nodeOpacity = progress * (isRelated ? 1 : 1 - focus * 0.53);
        const relatedLift = activeEdge && isRelated ? focus * -8 : 0;
        return <div key={node.id} style={{
          position: "absolute", left: box.x - box.width / 2, top: box.y - box.height / 2,
          width: box.width, height: box.height, opacity: nodeOpacity,
          transform: `translateY(${(1 - Math.min(progress, 1)) * 52 + relatedLift}px) rotate(${box.rotation * progress}deg) scale(${0.72 + Math.min(progress, 1) * 0.28 + (isRelated ? focus * 0.025 : 0)})`,
          transformOrigin: "center", filter: "drop-shadow(10px 12px 0 rgba(55,50,40,.13))",
        }}>
          <div style={{position: "absolute", inset: "8px -7px -7px 9px", background: node.kind === "chip" ? "#b3c578" : node.kind === "cloud" ? "#8fc7bd" : "#d9b66d", clipPath: "polygon(3% 7%, 95% 1%, 100% 91%, 8% 100%)"}} />
          <div style={{position: "absolute", inset: 0, background: "#f7f1e7", border: "2px solid #30413d", clipPath: "polygon(1% 5%, 97% 0, 100% 94%, 5% 100%)"}} />
          <div style={{position: "absolute", left: box.width / 2 - 41, top: -13, width: 82, height: 25, background: "#d8caaa", opacity: 0.82, transform: "rotate(-2deg)"}} />
          <div style={{position: "absolute", left: 16, top: 22, width: 74, height: 74, borderRadius: "50%", background: "#fff", border: "3px solid #263b37", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden"}}>
            {node.assetSrc
              ? <img src={resolveAsset(node.assetSrc)} style={{display: "block", width: 52, height: 52, objectFit: "contain"}} />
              : <span style={{fontSize: 25, fontWeight: 950, color: "#263b37"}}>{Array.from(node.label)[0]}</span>}
          </div>
          <div style={{position: "absolute", left: 101, right: 16, top: 25}}>
            <div style={{fontSize: node.label.length > 10 ? 21 : 25, lineHeight: 1.05, fontWeight: 950, overflowWrap: "anywhere"}}>{node.label}</div>
            <div style={{display: "inline-block", marginTop: 9, padding: "3px 7px", background: "#263b37", color: "#f6f0e5", fontSize: 12, lineHeight: 1.1, fontWeight: 900}}>{KIND_LABEL[node.kind]}</div>
          </div>
          <div style={{position: "absolute", left: 19, right: 17, bottom: 17, borderTop: "2px solid #c9c0af", paddingTop: 8, fontSize: 15, lineHeight: 1.15, fontWeight: 800, color: "#62635d", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis"}}>{node.role}</div>
        </div>;
      })}
    </div>

    <div style={{position: "absolute", left: 62, bottom: 38, zIndex: 12, display: "flex", gap: 24, padding: "10px 15px", background: "#f5efe4dd", borderTop: "2px solid #273d38"}}>
      {(Object.keys(EDGE_STYLES) as CollageNetworkEdgeType[]).map((type) => <div key={type} style={{display: "flex", alignItems: "center", gap: 8, fontSize: 14, fontWeight: 900, color: "#444c48"}}>
        <span style={{display: "inline-block", width: 27, borderTop: `${type === "competition" ? "3px dashed" : "4px solid"} ${EDGE_STYLES[type].color}`}} />{EDGE_STYLES[type].label}
      </div>)}
    </div>
    <div style={{position: "absolute", right: 60, bottom: 43, zIndex: 12, fontSize: 15, fontWeight: 900, color: "#777268"}}>{String(spec.edges.filter((edge) => edge.at <= seconds).length).padStart(2, "0")} / {String(spec.edges.length).padStart(2, "0")}</div>
  </AbsoluteFill>;
};
