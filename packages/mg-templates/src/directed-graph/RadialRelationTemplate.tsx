import {CSSProperties, useMemo} from "react";
import {AbsoluteFill, Audio, useCurrentFrame, useVideoConfig} from "remotion";
import {evaluateDirectedGraphEdge} from "./evaluate";
import {DirectedGraphSpec} from "./types";

type Props = {spec: DirectedGraphSpec; audioSrc?: string; style?: CSSProperties};
type LayoutNode = {id: string; x: number; y: number; depth: number};

const WIDTH = 1920;
const HEIGHT = 1080;
const CENTER_X = WIDTH / 2;
const CENTER_Y = HEIGHT / 2 + 28;
const NODE_RADIUS = 78;
const COLORS = ["#ef6841", "#2f8f83", "#e0a43a", "#527eb5", "#8c68a9"];

const makeLayout = (spec: DirectedGraphSpec) => {
  const root = spec.edges[0].from;
  const depths = new Map<string, number>([[root, 0]]);
  spec.edges.forEach((edge) => depths.set(edge.to, Math.min(depths.get(edge.to) ?? Infinity, (depths.get(edge.from) ?? 0) + 1)));
  const rings = new Map<number, string[]>();
  [...new Set(spec.edges.flatMap((edge) => [edge.from, edge.to]))].forEach((id) => {
    const depth = depths.get(id) ?? 1;
    rings.set(depth, [...(rings.get(depth) ?? []), id]);
  });
  const nodes = new Map<string, LayoutNode>();
  nodes.set(root, {id: root, x: CENTER_X, y: CENTER_Y, depth: 0});
  [...rings.entries()].filter(([depth]) => depth > 0).forEach(([depth, ids]) => {
    const radiusX = Math.min(700, 360 + (depth - 1) * 190);
    const radiusY = Math.min(405, 260 + (depth - 1) * 105);
    ids.forEach((id, index) => {
      const angle = -Math.PI / 2 + (index / ids.length) * Math.PI * 2 + (depth % 2 ? 0 : Math.PI / Math.max(ids.length, 2));
      nodes.set(id, {id, x: CENTER_X + Math.cos(angle) * radiusX, y: CENTER_Y + Math.sin(angle) * radiusY, depth});
    });
  });
  return {root, nodes};
};

const edgePoints = (from: LayoutNode, to: LayoutNode) => {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.max(1, Math.hypot(dx, dy));
  const fromRadius = from.depth === 0 ? 104 : NODE_RADIUS;
  return {
    startX: from.x + dx / length * fromRadius,
    startY: from.y + dy / length * fromRadius,
    endX: to.x - dx / length * NODE_RADIUS,
    endY: to.y - dy / length * NODE_RADIUS,
    normalX: -dy / length,
    normalY: dx / length,
  };
};

export const RadialRelationTemplate = ({spec, audioSrc, style}: Props) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const seconds = frame / fps;
  const layout = useMemo(() => makeLayout(spec), [spec]);
  const states = spec.edges.map((edge) => evaluateDirectedGraphEdge(edge, seconds));
  const nodeProgress = new Map<string, number>([[layout.root, 1]]);
  spec.edges.forEach((edge, index) => nodeProgress.set(edge.to, Math.max(nodeProgress.get(edge.to) ?? 0, states[index].nodeProgress)));

  return <AbsoluteFill style={{background: "#f4f0e8", color: "#20292c", fontFamily: '"Microsoft YaHei", Arial, sans-serif', overflow: "hidden", ...style}}>
    {audioSrc ? <Audio src={audioSrc} /> : null}
    {spec.title ? <div style={{position: "absolute", left: 70, top: 42, zIndex: 2, fontSize: 42, fontWeight: 900}}>{spec.title}</div> : null}
    <div style={{position: "absolute", inset: 0, backgroundImage: "radial-gradient(#b9b4aa 1.2px, transparent 1.2px)", backgroundSize: "34px 34px", opacity: 0.23}} />
    <div style={{position: "absolute", left: 70, top: 54, fontSize: 18, fontWeight: 800, color: "#736f68"}}>RELATION MAP</div>
    <svg width={WIDTH} height={HEIGHT} viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
      {spec.edges.map((edge, index) => {
        const from = layout.nodes.get(edge.from)!;
        const to = layout.nodes.get(edge.to)!;
        const points = edgePoints(from, to);
        const progress = states[index].lineProgress;
        const x = points.startX + (points.endX - points.startX) * progress;
        const y = points.startY + (points.endY - points.startY) * progress;
        const labelX = (points.startX + points.endX) / 2 + points.normalX * 31;
        const labelY = (points.startY + points.endY) / 2 + points.normalY * 31;
        const labelWidth = Math.min(280, Math.max(96, edge.relation.length * 22 + 34));
        return <g key={`${edge.from}-${edge.to}-${index}`} opacity={progress > 0 ? 1 : 0}>
          <line x1={points.startX} y1={points.startY} x2={points.endX} y2={points.endY} pathLength={1} stroke="#5b6768" strokeWidth={3} strokeDasharray="8 8" strokeDashoffset={1 - progress} />
          <circle cx={x} cy={y} r={7} fill="#ef6841" />
          <g opacity={Math.max(0, (progress - 0.5) * 2)} transform={`translate(${labelX} ${labelY})`}>
            <rect x={-labelWidth / 2} y={-20} width={labelWidth} height={40} rx={4} fill="#f4f0e8" stroke="#c7c1b7" />
            <text textAnchor="middle" dominantBaseline="central" fontSize={20} fontWeight={800} fill="#445052">{edge.relation}</text>
          </g>
        </g>;
      })}
      {[...layout.nodes.values()].map((node) => {
        const progress = nodeProgress.get(node.id) ?? 0;
        const root = node.id === layout.root;
        const radius = root ? 104 : NODE_RADIUS;
        const color = COLORS[node.depth % COLORS.length];
        return <g key={node.id} opacity={progress} transform={`translate(${node.x} ${node.y}) scale(${0.68 + progress * 0.32})`}>
          <circle r={radius + 12 * (1 - progress)} fill="none" stroke={color} strokeWidth={2} opacity={0.25 * progress} />
          <circle r={radius} fill={root ? "#20292c" : "#fffdf8"} stroke={color} strokeWidth={root ? 7 : 4} />
          <foreignObject x={-radius + 12} y={-radius + 8} width={(radius - 12) * 2} height={(radius - 8) * 2}>
            <div style={{width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: 10, boxSizing: "border-box", color: root ? "#fff" : "#20292c", fontSize: root ? 28 : node.id.length > 8 ? 20 : 24, lineHeight: 1.15, fontWeight: 900, textAlign: "center", overflowWrap: "anywhere"}}>{node.id}</div>
          </foreignObject>
        </g>;
      })}
    </svg>
  </AbsoluteFill>;
};
