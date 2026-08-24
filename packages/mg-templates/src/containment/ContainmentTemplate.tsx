import {CSSProperties, useMemo} from "react";
import {AbsoluteFill, Audio, useCurrentFrame, useVideoConfig} from "remotion";
import {evaluateContainmentEvent} from "./evaluate";
import {ContainEvent, ContainmentSpec} from "./types";

type Props = {spec: ContainmentSpec; audioSrc?: string; style?: CSSProperties};
type LayoutNode = {id: string; parent?: string; x: number; y: number; radius: number; depth: number};

const WIDTH = 1920;
const HEIGHT = 1080;
const COLORS = ["#e95f37", "#e6a73c", "#56a889", "#4c86ba", "#8a6fb4", "#c55f83"];

const makeLayout = (spec: ContainmentSpec) => {
  const contains = spec.events.filter((event): event is ContainEvent => event.action === "contain");
  const root = spec.root ?? contains[0].parent;
  const children = new Map<string, string[]>();
  contains.forEach(({parent, child}) => children.set(parent, [...(children.get(parent) ?? []), child]));
  const nodes = new Map<string, LayoutNode>();

  const place = (id: string, x: number, y: number, radius: number, depth: number, parent?: string) => {
    nodes.set(id, {id, parent, x, y, radius, depth});
    const childIds = children.get(id) ?? [];
    if (childIds.length === 1) {
      place(childIds[0], x, y + radius * 0.08, radius * 0.68, depth + 1, id);
      return;
    }
    const columns = Math.ceil(Math.sqrt(childIds.length));
    const rows = Math.ceil(childIds.length / columns);
    const childRadius = Math.min(radius * 0.34, radius * 0.72 / Math.max(columns, rows));
    const gapX = childRadius * 2.25;
    const gapY = childRadius * 2.25;
    childIds.forEach((child, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      place(child, x + (column - (columns - 1) / 2) * gapX, y + (row - (rows - 1) / 2) * gapY + radius * 0.1, childRadius, depth + 1, id);
    });
  };
  place(root, WIDTH / 2, HEIGHT / 2 + 38, 425, 0);
  return {root, nodes};
};

const isRelated = (nodeId: string, target: string, nodes: Map<string, LayoutNode>) => {
  let cursor: string | undefined = nodeId;
  while (cursor) {
    if (cursor === target) return true;
    cursor = nodes.get(cursor)?.parent;
  }
  cursor = target;
  while (cursor) {
    if (cursor === nodeId) return true;
    cursor = nodes.get(cursor)?.parent;
  }
  return false;
};

export const ContainmentTemplate = ({spec, audioSrc, style}: Props) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const seconds = frame / fps;
  const layout = useMemo(() => makeLayout(spec), [spec]);
  const containEvents = spec.events.filter((event): event is ContainEvent => event.action === "contain");
  const reveal = new Map<string, number>([[layout.root, 1]]);
  containEvents.forEach((event) => reveal.set(event.child, evaluateContainmentEvent(event, seconds).progress));

  const latestVisibleChild = [...containEvents].reverse().find((event) => event.at <= seconds);
  const cameraNode = latestVisibleChild ? layout.nodes.get(latestVisibleChild.child)! : layout.nodes.get(layout.root)!;
  const cameraProgress = latestVisibleChild ? evaluateContainmentEvent(latestVisibleChild, seconds).progress : 0;
  const desiredScale = Math.min(2.15, Math.max(1, 330 / cameraNode.radius));
  const cameraScale = 1 + (desiredScale - 1) * cameraProgress;
  const cameraX = WIDTH / 2 - cameraNode.x * cameraScale;
  const cameraY = HEIGHT / 2 - cameraNode.y * cameraScale;

  const latestHighlight = [...spec.events].reverse().find((event) => event.action === "highlight" && event.at <= seconds);
  const highlightTarget = latestHighlight?.action === "highlight" ? latestHighlight.target : undefined;
  const highlightProgress = latestHighlight ? evaluateContainmentEvent(latestHighlight, seconds).progress : 0;

  return <AbsoluteFill style={{background: "#f4f1ea", color: "#1d292d", fontFamily: '"Microsoft YaHei", Arial, sans-serif', overflow: "hidden", ...style}}>
    {audioSrc ? <Audio src={audioSrc} /> : null}
    {spec.title ? <div style={{position: "absolute", left: 84, top: 54, zIndex: 3, fontSize: 42, fontWeight: 900}}>{spec.title}</div> : null}
    <div style={{position: "absolute", inset: 0, backgroundImage: "linear-gradient(#d8d5cd 1px, transparent 1px), linear-gradient(90deg, #d8d5cd 1px, transparent 1px)", backgroundSize: "48px 48px", opacity: 0.23}} />
    <div style={{position: "absolute", width: WIDTH, height: HEIGHT, transformOrigin: "0 0", transform: `translate(${cameraX}px, ${cameraY}px) scale(${cameraScale})`}}>
      {[...layout.nodes.values()].sort((a, b) => a.depth - b.depth).map((node) => {
        const progress = reveal.get(node.id) ?? 0;
        const color = COLORS[node.depth % COLORS.length];
        const dimmed = highlightTarget && !isRelated(node.id, highlightTarget, layout.nodes);
        const focused = highlightTarget === node.id;
        const enterX = node.parent ? (1 - progress) * Math.min(300, node.radius * 1.8) : 0;
        const scale = node.parent ? 0.72 + progress * 0.28 : 1;
        const emphasisScale = focused ? 1 + highlightProgress * 0.055 : 1;
        const labelSize = Math.max(16, Math.min(38, node.radius * 0.13));
        return <div key={node.id} style={{
          position: "absolute", left: node.x - node.radius, top: node.y - node.radius,
          width: node.radius * 2, height: node.radius * 2, borderRadius: "50%",
          boxSizing: "border-box", border: `${Math.max(3, node.radius * 0.014)}px solid ${color}`,
          background: `${color}18`, boxShadow: focused ? `0 0 0 ${10 * highlightProgress}px ${color}35` : "none",
          opacity: progress * (dimmed ? 1 - highlightProgress * 0.72 : 1),
          transform: `translateX(${enterX}px) scale(${scale * emphasisScale})`, transformOrigin: "center",
        }}>
          <div style={{position: "absolute", left: "50%", top: Math.max(12, node.radius * 0.07), transform: "translateX(-50%)", maxWidth: "78%", padding: "5px 14px", background: "#f4f1ea", color, fontSize: labelSize, lineHeight: 1.12, fontWeight: 900, textAlign: "center", whiteSpace: "nowrap", borderRadius: 4}}>{node.id}</div>
        </div>;
      })}
    </div>
    <div style={{position: "absolute", left: 64, top: 50, width: 8, height: 54, background: "#e95f37"}} />
  </AbsoluteFill>;
};
