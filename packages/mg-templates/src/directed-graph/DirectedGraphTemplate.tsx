import dagre from "@dagrejs/dagre";
import {CSSProperties, useMemo} from "react";
import {AbsoluteFill, Audio, useCurrentFrame, useVideoConfig} from "remotion";
import {evaluateDirectedGraphEdge} from "./evaluate";
import {DirectedGraphSpec} from "./types";

type Props = {spec: DirectedGraphSpec; audioSrc?: string; style?: CSSProperties};
type Point = {x: number; y: number};
type LayoutNode = Point & {id: string; width: number; height: number};

const NODE_WIDTH = 184;
const NODE_HEIGHT = 184;
const SCENE_WIDTH = 1920;
const SCENE_HEIGHT = 1080;

const intersection = (from: LayoutNode, to: LayoutNode) => {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.max(1, Math.hypot(dx, dy));
  return {x: from.x + (dx / length) * (from.width / 2), y: from.y + (dy / length) * (from.height / 2)};
};

const makeLayout = (spec: DirectedGraphSpec) => {
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({rankdir: "LR", ranksep: 155, nodesep: 48, marginx: 70, marginy: 70});
  graph.setDefaultEdgeLabel(() => ({}));
  const ids = [...new Set(spec.edges.flatMap((edge) => [edge.from, edge.to]))];
  ids.forEach((id) => graph.setNode(id, {width: NODE_WIDTH, height: NODE_HEIGHT}));
  spec.edges.forEach((edge, index) => graph.setEdge(edge.from, edge.to, {index}));
  dagre.layout(graph);
  const nodes = new Map<string, LayoutNode>();
  const root = spec.edges[0].from;
  const isStar = spec.edges.every((edge) => edge.from === root) && !spec.edges.some((edge) => edge.to === root);
  const isLongChain = spec.edges.length >= 4 && spec.edges.every((edge, index) => index === 0 || edge.from === spec.edges[index - 1].to);
  if (isLongChain) {
    ids.forEach((id, index) => {
      const angle = -Math.PI + (index / ids.length) * Math.PI * 2;
      nodes.set(id, {id, x: 800 + Math.cos(angle) * 610, y: 450 + Math.sin(angle) * 310, width: NODE_WIDTH, height: NODE_HEIGHT});
    });
  } else if (isStar && ids.length > 3) {
    nodes.set(root, {id: root, x: 800, y: 450, width: NODE_WIDTH, height: NODE_HEIGHT});
    ids.filter((id) => id !== root).forEach((id, index, outer) => {
      const angle = -Math.PI / 2 + (index / outer.length) * Math.PI * 2;
      nodes.set(id, {id, x: 800 + Math.cos(angle) * 650, y: 450 + Math.sin(angle) * 350, width: NODE_WIDTH, height: NODE_HEIGHT});
    });
  } else {
    ids.forEach((id) => {
      const node = graph.node(id);
      nodes.set(id, {id, x: node.x, y: node.y, width: NODE_WIDTH, height: NODE_HEIGHT});
    });
  }
  const width = isStar || isLongChain ? 1600 : Math.max(graph.graph().width ?? 1, 1);
  const height = isStar || isLongChain ? 900 : Math.max(graph.graph().height ?? 1, 1);
  const scale = Math.min(1.25, (SCENE_WIDTH - 170) / width, (SCENE_HEIGHT - 210) / height);
  return {nodes, width, height, scale};
};

export const DirectedGraphTemplate = ({spec, audioSrc, style}: Props) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const seconds = frame / fps;
  const layout = useMemo(() => makeLayout(spec), [spec]);
  const edgeStates = spec.edges.map((edge) => evaluateDirectedGraphEdge(edge, seconds));
  const nodeProgress = new Map<string, number>([[spec.edges[0].from, 1]]);
  spec.edges.forEach((edge, index) => {
    nodeProgress.set(edge.to, Math.max(nodeProgress.get(edge.to) ?? 0, edgeStates[index].nodeProgress));
  });
  const offsetX = (SCENE_WIDTH - layout.width * layout.scale) / 2;
  const offsetY = 120 + (SCENE_HEIGHT - 160 - layout.height * layout.scale) / 2;

  return <AbsoluteFill style={{background: "#191d21", color: "#edf2f3", fontFamily: '"Microsoft YaHei", Arial, sans-serif', overflow: "hidden", ...style}}>
    {audioSrc ? <Audio src={audioSrc} /> : null}
    {spec.title ? <div style={{position: "absolute", left: 70, top: 42, zIndex: 2, fontSize: 42, fontWeight: 900}}>{spec.title}</div> : null}
    <div style={{position: "absolute", right: 70, top: 48, fontSize: 22, fontWeight: 800, color: "#ef6334"}}>{spec.edges.filter((edge) => edge.at <= seconds).length} / {spec.edges.length}</div>

    <svg width={SCENE_WIDTH} height={SCENE_HEIGHT} viewBox={`0 0 ${SCENE_WIDTH} ${SCENE_HEIGHT}`}>
      <g transform={`translate(${offsetX} ${offsetY}) scale(${layout.scale})`}>
        {spec.edges.map((edge, index) => {
          const from = layout.nodes.get(edge.from)!;
          const to = layout.nodes.get(edge.to)!;
          const start = intersection(from, to);
          const end = intersection(to, from);
          const state = edgeStates[index];
          const dx = end.x - start.x;
          const dy = end.y - start.y;
          const tip = {x: start.x + dx * state.lineProgress, y: start.y + dy * state.lineProgress};
          const angle = Math.atan2(dy, dx);
          const arrowSize = 17;
          const arrowPoints = [
            tip,
            {x: tip.x - arrowSize * Math.cos(angle - 0.55), y: tip.y - arrowSize * Math.sin(angle - 0.55)},
            {x: tip.x - arrowSize * Math.cos(angle + 0.55), y: tip.y - arrowSize * Math.sin(angle + 0.55)},
          ].map((point) => `${point.x},${point.y}`).join(" ");
          const labelX = start.x + dx * 0.5;
          const labelY = start.y + dy * 0.5;
          const length = Math.max(1, Math.hypot(dx, dy));
          const normalX = -dy / length;
          const normalY = dx / length;
          const relationX = labelX + normalX * 58;
          const relationY = labelY + normalY * 58;
          const labelWidth = Math.min(310, Math.max(120, edge.relation.length * 22 + 30));
          return <g key={`${edge.from}-${edge.to}-${index}`} opacity={state.lineProgress > 0 ? 1 : 0}>
            <line x1={start.x} y1={start.y} x2={end.x} y2={end.y} pathLength={1} stroke="#ef6334" strokeWidth={4} strokeDasharray={1} strokeDashoffset={1 - state.lineProgress} />
            <polygon points={arrowPoints} fill="#ef6334" opacity={state.lineProgress > 0.9 ? (state.lineProgress - 0.9) * 10 : 0} />
            <g opacity={Math.max(0, (state.lineProgress - 0.35) / 0.65)} transform={`translate(${relationX} ${relationY})`}>
              <rect x={-labelWidth / 2} y={-34} width={labelWidth} height={68} rx={4} fill="#191d21" stroke="#6c7479" strokeWidth={2} />
              <foreignObject x={-labelWidth / 2 + 8} y={-30} width={labelWidth - 16} height={60}>
                <div style={{width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "#f2b092", fontSize: 20, lineHeight: 1.12, fontWeight: 800, textAlign: "center", overflowWrap: "anywhere"}}>{edge.relation}</div>
              </foreignObject>
            </g>
          </g>;
        })}

        {[...layout.nodes.values()].map((node) => {
          const progress = nodeProgress.get(node.id) ?? 0;
          const fontSize = node.id.length > 8 ? 21 : node.id.length > 5 ? 25 : 30;
          return <g key={node.id} opacity={progress} transform={`translate(${node.x} ${node.y}) scale(${0.72 + progress * 0.28})`}>
            <circle r={node.width / 2} fill="#eef1ef" stroke={progress < 1 ? "#ef6334" : "#b8c2c5"} strokeWidth={4} />
            <foreignObject x={-node.width / 2 + 12} y={-node.height / 2 + 8} width={node.width - 24} height={node.height - 16}>
              <div style={{width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center", color: "#1e292e", fontSize, lineHeight: 1.15, fontWeight: 900, overflowWrap: "anywhere"}}>{node.id}</div>
            </foreignObject>
          </g>;
        })}
      </g>
    </svg>
  </AbsoluteFill>;
};
