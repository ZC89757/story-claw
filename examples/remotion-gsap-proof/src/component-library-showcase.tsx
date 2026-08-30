import "@xyflow/react/dist/style.css";

import dagre from "@dagrejs/dagre";
import {Card, ConfigProvider, Table, type TableProps, Tag} from "antd";
import {gsap} from "gsap";
import {ReactNode, useCallback, useLayoutEffect, useRef, useState} from "react";
import {
  AbsoluteFill,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import {
  Background,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const COLORS = {
  ink: "#17212b",
  paper: "#f7f5ef",
  navy: "#173a5e",
  blue: "#2674e8",
  cyan: "#32bfc7",
  green: "#2da66a",
  yellow: "#f2bd45",
  coral: "#ed6c5c",
  lavender: "#7467d8",
};

const clamp = {
  extrapolateLeft: "clamp" as const,
  extrapolateRight: "clamp" as const,
};

const useTimelineSeek = (
  rootRef: React.RefObject<HTMLDivElement>,
  buildTimeline: () => gsap.core.Timeline,
  startFrame: number,
  ready = true,
) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const timelineRef = useRef<gsap.core.Timeline | null>(null);
  const buildTimelineRef = useRef(buildTimeline);
  buildTimelineRef.current = buildTimeline;

  useLayoutEffect(() => {
    if (!ready) {
      return;
    }

    const context = gsap.context(() => {
      timelineRef.current = buildTimelineRef.current();
    }, rootRef.current ?? undefined);

    return () => {
      timelineRef.current = null;
      context.revert();
    };
  }, [ready, rootRef]);

  useLayoutEffect(() => {
    if (!ready) {
      return;
    }

    timelineRef.current?.seek(Math.max(0, frame - startFrame) / fps, false);
  }, [fps, frame, ready, startFrame]);
};

const Header = ({index, kicker, title}: {index: string; kicker: string; title: string}) => (
  <div style={{position: "absolute", left: 96, top: 76, zIndex: 6}}>
    <div style={{color: COLORS.coral, fontSize: 22, fontWeight: 800, letterSpacing: 1.5}}>
      {index} / {kicker}
    </div>
    <div style={{fontSize: 58, fontWeight: 900, marginTop: 14, color: COLORS.ink}}>{title}</div>
  </div>
);

const CardStage = ({startFrame}: {startFrame: number}) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const leftCard = useRef<HTMLDivElement>(null);
  const rightCard = useRef<HTMLDivElement>(null);
  const badge = useRef<HTMLDivElement>(null);

  useTimelineSeek(
    rootRef,
    () => {
      const timeline = gsap.timeline({paused: true});
      gsap.set(leftCard.current, {x: -940, rotation: -8, opacity: 0});
      gsap.set(rightCard.current, {x: 940, rotation: 8, opacity: 0});
      gsap.set(badge.current, {y: 26, opacity: 0});
      timeline
        .to(leftCard.current, {x: 0, rotation: 0, opacity: 1, duration: 0.95, ease: "power4.out"})
        .to(rightCard.current, {x: 0, rotation: 0, opacity: 1, duration: 0.95, ease: "power4.out"}, 0.12)
        .to(badge.current, {y: 0, opacity: 1, duration: 0.48, ease: "back.out(1.7)"}, 0.88)
        .to(leftCard.current, {y: -14, duration: 0.46, yoyo: true, repeat: 1, ease: "sine.inOut"}, 1.45)
        .to(rightCard.current, {y: 14, duration: 0.46, yoyo: true, repeat: 1, ease: "sine.inOut"}, 1.52);
      return timeline;
    },
    startFrame,
  );

  const makeCard = (title: string, copy: string, accent: string, dark = false) => (
    <Card
      bordered={false}
      style={{width: 490, height: 340, overflow: "hidden", background: dark ? COLORS.navy : COLORS.yellow, boxShadow: "0 34px 80px rgba(23, 33, 43, 0.18)"}}
      styles={{body: {height: "100%", padding: 42, boxSizing: "border-box"}}}
    >
      <Tag color={dark ? "processing" : "gold"} style={{margin: 0, fontSize: 16, fontWeight: 800, border: "none"}}>
        {dark ? "SOURCE A" : "SOURCE B"}
      </Tag>
      <div style={{fontSize: 46, fontWeight: 900, marginTop: 26, color: dark ? "#fff" : COLORS.ink}}>{title}</div>
      <div style={{fontSize: 26, lineHeight: 1.45, marginTop: 22, color: dark ? "#c8ddff" : "#5e4a16"}}>{copy}</div>
      <div style={{position: "absolute", left: 42, right: 42, bottom: 38, height: 8, background: accent}} />
    </Card>
  );

  return (
    <AbsoluteFill ref={rootRef} style={{background: "#fffaf0", overflow: "hidden"}}>
      <Header index="01" kicker="Ant Design Card" title="Two cards meet in the center" />
      <div ref={leftCard} style={{position: "absolute", left: 390, top: 342}}>
        {makeCard("Customer signal", "Intent, profile, and recent activity", COLORS.cyan, true)}
      </div>
      <div ref={rightCard} style={{position: "absolute", left: 1040, top: 342}}>
        {makeCard("Business context", "Goals, constraints, and opportunity", COLORS.coral)}
      </div>
      <div ref={badge} style={{position: "absolute", left: 766, top: 746}}>
        <Tag color="success" style={{borderRadius: 999, padding: "15px 34px", fontSize: 28, fontWeight: 900, boxShadow: "0 14px 30px rgba(45, 166, 106, 0.3)"}}>
          One clear decision
        </Tag>
      </div>
    </AbsoluteFill>
  );
};

type SegmentRow = {segment: string; north: number; central: number; south: number; total: number};

const tableData: SegmentRow[] = [
  {segment: "Q1", north: 62, central: 71, south: 84, total: 91},
  {segment: "Q2", north: 68, central: 76, south: 88, total: 94},
  {segment: "Q3", north: 73, central: 81, south: 90, total: 97},
  {segment: "Q4", north: 79, central: 86, south: 95, total: 102},
  {segment: "Q5", north: 85, central: 93, south: 101, total: 110},
];

const tableColumns: TableProps<SegmentRow>["columns"] = [
  {title: "Segment", dataIndex: "segment", key: "segment", width: 190},
  {title: "North", dataIndex: "north", key: "north", width: 190},
  {title: "Central", dataIndex: "central", key: "central", width: 190},
  {title: "South", dataIndex: "south", key: "south", width: 190},
  {title: "Total", dataIndex: "total", key: "total", width: 190},
];

const TableStage = ({startFrame}: {startFrame: number}) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLDivElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);

  useTimelineSeek(
    rootRef,
    () => {
      const cells = Array.from(tableRef.current?.querySelectorAll<HTMLElement>(".ant-table-cell") ?? []);
      const timeline = gsap.timeline({paused: true});
      gsap.set(cells, {opacity: 0, scale: 0.78, y: 22});
      gsap.set([titleRef.current, summaryRef.current], {opacity: 0, y: 28});
      timeline
        .to(titleRef.current, {opacity: 1, y: 0, duration: 0.45, ease: "power3.out"})
        .to(cells, {opacity: 1, scale: 1, y: 0, duration: 0.28, ease: "back.out(1.5)", stagger: 0.06}, 0.2)
        .to(summaryRef.current, {opacity: 1, y: 0, duration: 0.5, ease: "back.out(1.4)"}, 2.15);
      return timeline;
    },
    startFrame,
  );

  return (
    <AbsoluteFill ref={rootRef} style={{background: "#f4f8ff", overflow: "hidden"}}>
      <Header index="02" kicker="Ant Design Table" title="Cells render from top-left to bottom-right" />
      <div ref={titleRef} style={{position: "absolute", left: 314, top: 270}}>
        <Tag color="blue" style={{fontSize: 26, fontWeight: 800, padding: "13px 22px", borderRadius: 10}}>
          Growth signal by segment
        </Tag>
      </div>
      <div ref={tableRef} style={{position: "absolute", left: 314, top: 356, width: 1010}}>
        <Table<SegmentRow>
          bordered
          columns={tableColumns}
          dataSource={tableData}
          rowKey="segment"
          pagination={false}
          size="large"
          rowClassName={(row) => row.total >= 102 ? "highlight-row" : ""}
        />
      </div>
      <div ref={summaryRef} style={{position: "absolute", left: 1064, top: 875}}>
        <Card size="small" style={{width: 330, borderLeft: `8px solid ${COLORS.green}`, boxShadow: "0 14px 32px rgba(23, 58, 94, 0.1)"}} styles={{body: {fontSize: 22, fontWeight: 800}}}>
          Best segment: +110
        </Card>
      </div>
    </AbsoluteFill>
  );
};

const chartData = [
  {week: "W1", alpha: 14, beta: 11, gamma: 8, delta: 5},
  {week: "W2", alpha: 21, beta: 15, gamma: 12, delta: 8},
  {week: "W3", alpha: 29, beta: 20, gamma: 15, delta: 11},
  {week: "W4", alpha: 27, beta: 25, gamma: 20, delta: 17},
  {week: "W5", alpha: 38, beta: 31, gamma: 18, delta: 16},
  {week: "W6", alpha: 47, beta: 35, gamma: 26, delta: 23},
  {week: "W7", alpha: 44, beta: 39, gamma: 30, delta: 21},
  {week: "W8", alpha: 55, beta: 43, gamma: 35, delta: 28},
];

const ChartStage = ({startFrame}: {startFrame: number}) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<HTMLDivElement>(null);
  const [isChartReady, setIsChartReady] = useState(false);

  useLayoutEffect(() => {
    // Recharts creates SVG paths after its first layout pass. Build the GSAP
    // timeline only after that pass so every render worker sees the paths.
    const animationFrame = requestAnimationFrame(() => setIsChartReady(true));
    return () => cancelAnimationFrame(animationFrame);
  }, []);

  useTimelineSeek(
    rootRef,
    () => {
      const linePaths = Array.from(chartRef.current?.querySelectorAll<SVGPathElement>(".recharts-line-curve") ?? []);
      const legend = Array.from(chartRef.current?.querySelectorAll<HTMLElement>(".recharts-default-legend .recharts-legend-item") ?? []);
      const axes = Array.from(chartRef.current?.querySelectorAll<SVGElement>(".recharts-cartesian-axis, .recharts-cartesian-grid") ?? []);
      const timeline = gsap.timeline({paused: true});
      gsap.set(axes, {opacity: 0, y: 24});
      gsap.set(linePaths, {opacity: 1, strokeDasharray: 2200, strokeDashoffset: 2200});
      gsap.set(legend, {opacity: 0, x: 22});
      timeline
        .to(axes, {opacity: 1, y: 0, duration: 0.45, ease: "power2.out"})
        .to(linePaths, {strokeDashoffset: 0, duration: 1.35, stagger: 0.28, ease: "power2.inOut"}, 0.2)
        .to(legend, {opacity: 1, x: 0, duration: 0.36, stagger: 0.12, ease: "power3.out"}, 0.92);
      return timeline;
    },
    startFrame,
    isChartReady,
  );

  return (
    <AbsoluteFill ref={rootRef} style={{background: "#fbf8ff", overflow: "hidden"}}>
      <Header index="03" kicker="Recharts LineChart" title="Lines extend slowly across the chart" />
      <div ref={chartRef} style={{position: "absolute", left: 300, top: 270}}>
        <LineChart width={1320} height={650} data={chartData} margin={{top: 25, right: 180, bottom: 30, left: 32}}>
          <CartesianGrid stroke="#dce3ed" strokeDasharray="5 6" />
          <XAxis dataKey="week" tickLine={false} axisLine={{stroke: COLORS.ink, strokeWidth: 3}} />
          <YAxis tickLine={false} axisLine={{stroke: COLORS.ink, strokeWidth: 3}} label={{value: "Momentum", angle: -90, position: "insideLeft", style: {fill: "#6e7786", fontSize: 19}}} />
          <Tooltip />
          <Legend verticalAlign="middle" align="right" layout="vertical" wrapperStyle={{fontSize: 23, fontWeight: 800, lineHeight: "2.3"}} />
          <Line type="monotone" dataKey="alpha" name="Track A" stroke={COLORS.blue} strokeWidth={8} dot={false} isAnimationActive={false} />
          <Line type="monotone" dataKey="beta" name="Track B" stroke={COLORS.green} strokeWidth={8} dot={false} isAnimationActive={false} />
          <Line type="monotone" dataKey="gamma" name="Track C" stroke={COLORS.coral} strokeWidth={8} dot={false} isAnimationActive={false} />
          <Line type="monotone" dataKey="delta" name="Track D" stroke={COLORS.lavender} strokeWidth={8} dot={false} isAnimationActive={false} />
        </LineChart>
      </div>
    </AbsoluteFill>
  );
};

type FlowData = {label: string; detail: string; color: string};

const flowBaseNodes: Array<Node<FlowData>> = [
  {id: "intake", type: "showcase", position: {x: 0, y: 0}, data: {label: "Intake", detail: "request", color: COLORS.navy}},
  {id: "context", type: "showcase", position: {x: 0, y: 0}, data: {label: "Context", detail: "normalize", color: COLORS.blue}},
  {id: "risk", type: "showcase", position: {x: 0, y: 0}, data: {label: "Risk", detail: "score", color: COLORS.coral}},
  {id: "enrich", type: "showcase", position: {x: 0, y: 0}, data: {label: "Enrich", detail: "signals", color: COLORS.cyan}},
  {id: "decision", type: "showcase", position: {x: 0, y: 0}, data: {label: "Decision", detail: "combine", color: COLORS.lavender}},
  {id: "approve", type: "showcase", position: {x: 0, y: 0}, data: {label: "Approve", detail: "fast lane", color: COLORS.green}},
  {id: "review", type: "showcase", position: {x: 0, y: 0}, data: {label: "Review", detail: "human loop", color: COLORS.yellow}},
];

const flowBaseEdges: Array<Edge> = [
  {id: "intake-context", source: "intake", target: "context"},
  {id: "context-risk", source: "context", target: "risk"},
  {id: "context-enrich", source: "context", target: "enrich"},
  {id: "risk-decision", source: "risk", target: "decision"},
  {id: "enrich-decision", source: "enrich", target: "decision"},
  {id: "decision-approve", source: "decision", target: "approve"},
  {id: "decision-review", source: "decision", target: "review"},
];

const flowLayout = () => {
  const graph = new dagre.graphlib.Graph();
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({rankdir: "LR", ranksep: 100, nodesep: 90, marginx: 18, marginy: 18});
  flowBaseNodes.forEach((node) => graph.setNode(node.id, {width: 200, height: 96}));
  flowBaseEdges.forEach((edge) => graph.setEdge(edge.source, edge.target));
  dagre.layout(graph);

  const rawNodes = flowBaseNodes.map((node) => ({node, position: graph.node(node.id)}));
  const minX = Math.min(...rawNodes.map(({position}) => position.x - 100));
  const minY = Math.min(...rawNodes.map(({position}) => position.y - 48));
  const nodes = rawNodes.map(({node, position}) => ({
    ...node,
    position: {x: position.x - 100 - minX + 28, y: position.y - 48 - minY + 24},
  }));
  const edges = flowBaseEdges.map((edge) => ({
    ...edge,
    type: "smoothstep",
    animated: false,
    markerEnd: {type: MarkerType.ArrowClosed, color: COLORS.ink},
    style: {stroke: COLORS.ink, strokeWidth: 4},
  }));
  return {nodes, edges};
};

const FlowCardNode = ({data}: NodeProps<Node<FlowData>>) => (
  <div style={{width: 200}}>
    <Handle type="target" position={Position.Left} style={{opacity: 0}} />
    <Card size="small" style={{border: `4px solid ${data.color}`, boxShadow: "0 16px 36px rgba(23, 33, 43, 0.12)"}} styles={{body: {padding: "14px 18px"}}}>
      <div style={{fontSize: 24, fontWeight: 900, color: COLORS.ink}}>{data.label}</div>
      <div style={{fontSize: 16, color: "#67737e", marginTop: 3}}>{data.detail}</div>
    </Card>
    <Handle type="source" position={Position.Right} style={{opacity: 0}} />
  </div>
);

const flowNodeTypes = {showcase: FlowCardNode};
const layoutedFlow = flowLayout();

const FlowStage = ({startFrame}: {startFrame: number}) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const flowRef = useRef<HTMLDivElement>(null);
  const calloutRef = useRef<HTMLDivElement>(null);
  const [isReady, setIsReady] = useState(false);
  const onInit = useCallback(() => {
    // React Flow calls onInit before its node wrappers are guaranteed to be in
    // the DOM. Waiting one paint gives GSAP stable edge and node targets.
    requestAnimationFrame(() => setIsReady(true));
  }, []);

  useTimelineSeek(
    rootRef,
    () => {
      // React Flow owns the outer node transform for dagre's x/y coordinates.
      // GSAP animates the node's inner content so those coordinates stay intact.
      const nodeBodies = Array.from(flowRef.current?.querySelectorAll<HTMLElement>(".react-flow__node > div") ?? []);
      const edges = Array.from(flowRef.current?.querySelectorAll<SVGPathElement>(".react-flow__edge-path") ?? []);
      const timeline = gsap.timeline({paused: true});
      gsap.set(nodeBodies, {opacity: 0, scale: 0.72, y: 24});
      gsap.set(edges, {opacity: 0, strokeDasharray: 1400, strokeDashoffset: 1400});
      gsap.set(calloutRef.current, {opacity: 0, y: 20});
      timeline
        .to(nodeBodies[0], {opacity: 1, scale: 1, y: 0, duration: 0.42, ease: "back.out(1.8)"}, 0.1)
        .to(edges[0], {opacity: 1, strokeDashoffset: 0, duration: 0.36, ease: "power2.inOut"}, 0.46)
        .to(nodeBodies[1], {opacity: 1, scale: 1, y: 0, duration: 0.42, ease: "back.out(1.8)"}, 0.72)
        .to(edges.slice(1, 3), {opacity: 1, strokeDashoffset: 0, duration: 0.42, stagger: 0.14, ease: "power2.inOut"}, 1.05)
        .to(nodeBodies.slice(2, 4), {opacity: 1, scale: 1, y: 0, duration: 0.4, stagger: 0.14, ease: "back.out(1.8)"}, 1.32)
        .to(edges.slice(3, 5), {opacity: 1, strokeDashoffset: 0, duration: 0.42, stagger: 0.14, ease: "power2.inOut"}, 1.72)
        .to(nodeBodies[4], {opacity: 1, scale: 1, y: 0, duration: 0.42, ease: "back.out(1.8)"}, 2.04)
        .to(edges.slice(5), {opacity: 1, strokeDashoffset: 0, duration: 0.42, stagger: 0.14, ease: "power2.inOut"}, 2.38)
        .to(nodeBodies.slice(5), {opacity: 1, scale: 1, y: 0, duration: 0.42, stagger: 0.16, ease: "back.out(1.8)"}, 2.67)
        .to(calloutRef.current, {opacity: 1, y: 0, duration: 0.42, ease: "power3.out"}, 3.22);
      return timeline;
    },
    startFrame,
    isReady,
  );

  return (
    <AbsoluteFill ref={rootRef} style={{background: "#f8fbf8", overflow: "hidden"}}>
      <Header index="04" kicker="React Flow + dagre" title="A process map builds its route, node by node" />
      <div ref={flowRef} style={{position: "absolute", left: 180, top: 280, width: 1560, height: 540, borderRadius: 18, background: "rgba(255,255,255,0.64)"}}>
        <ReactFlow
          nodes={layoutedFlow.nodes}
          edges={layoutedFlow.edges}
          nodeTypes={flowNodeTypes}
          defaultViewport={{x: 0, y: 0, zoom: 1}}
          onInit={onInit}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          panOnDrag={false}
          zoomOnScroll={false}
          zoomOnPinch={false}
          zoomOnDoubleClick={false}
          proOptions={{hideAttribution: true}}
        >
          <Background color="#e4ebe6" gap={22} size={1} />
        </ReactFlow>
      </div>
      <div ref={calloutRef} style={{position: "absolute", left: 696, top: 868}}>
        <Tag color="default" style={{borderRadius: 999, padding: "14px 28px", background: COLORS.ink, border: "none", color: "#fff", fontSize: 24, fontWeight: 800}}>
          Parallel checks, one downstream decision
        </Tag>
      </div>
    </AbsoluteFill>
  );
};

type StageShellProps = {
  start: number;
  shrinkStart: number;
  miniX: number;
  miniY: number;
  label: string;
  zIndex: number;
  children: ReactNode;
};

const StageShell = ({start, shrinkStart, miniX, miniY, label, zIndex, children}: StageShellProps) => {
  const frame = useCurrentFrame();
  const appear = interpolate(frame, [start, start + 8], [0, 1], clamp);
  const shrink = interpolate(frame, [shrinkStart, shrinkStart + 30], [0, 1], {
    ...clamp,
    easing: (value) => 1 - (1 - value) * (1 - value),
  });
  const scale = interpolate(shrink, [0, 1], [1, 0.205]);
  const left = interpolate(shrink, [0, 1], [0, miniX]);
  const top = interpolate(shrink, [0, 1], [0, miniY]);

  if (frame < start) {
    return null;
  }

  return (
    <div style={{position: "absolute", left, top, width: 1920, height: 1080, opacity: appear, transform: `scale(${scale})`, transformOrigin: "top left", overflow: "hidden", borderRadius: shrink > 0.01 ? 18 : 0, boxShadow: shrink > 0.01 ? "0 12px 28px rgba(23, 33, 43, 0.16)" : "none", zIndex: shrink < 1 ? 20 + zIndex : zIndex}}>
      {children}
      {shrink > 0.01 ? (
        <Tag color="default" style={{position: "absolute", left: 48, bottom: 42, borderRadius: 999, padding: "10px 17px", border: "none", color: "#fff", background: "rgba(23,33,43,0.82)", fontSize: 24, fontWeight: 800}}>
          {label}
        </Tag>
      ) : null}
    </div>
  );
};

export const COMPONENT_LIBRARY_DURATION_IN_FRAMES = 840;

export const ComponentLibraryShowcase = () => {
  const frame = useCurrentFrame();
  const finalReveal = interpolate(frame, [795, 830], [0, 1], clamp);

  return (
    <ConfigProvider theme={{token: {fontFamily: 'Inter, "Microsoft YaHei", Arial, sans-serif', colorPrimary: COLORS.blue, borderRadius: 12}}}>
      <AbsoluteFill style={{background: COLORS.paper, color: COLORS.ink, fontFamily: 'Inter, "Microsoft YaHei", Arial, sans-serif', overflow: "hidden"}}>
        <StageShell start={0} shrinkStart={120} miniX={58} miniY={74} label="01 Cards" zIndex={1}><CardStage startFrame={0} /></StageShell>
        <StageShell start={150} shrinkStart={270} miniX={468} miniY={74} label="02 Table" zIndex={2}><TableStage startFrame={150} /></StageShell>
        <StageShell start={300} shrinkStart={435} miniX={58} miniY={308} label="03 Chart" zIndex={3}><ChartStage startFrame={300} /></StageShell>
        <StageShell start={465} shrinkStart={720} miniX={468} miniY={308} label="04 Flow" zIndex={4}><FlowStage startFrame={465} /></StageShell>
        <div style={{position: "absolute", left: 88, top: 605, width: 760, opacity: finalReveal, transform: `translateY(${interpolate(finalReveal, [0, 1], [28, 0])}px)`, zIndex: 10}}>
          <div style={{fontSize: 22, letterSpacing: 2, fontWeight: 800, color: COLORS.coral}}>COMPONENT LIBRARIES + GSAP</div>
          <div style={{fontSize: 45, lineHeight: 1.08, fontWeight: 900, marginTop: 12}}>One frame clock.<br />Four local timelines.</div>
          <div style={{fontSize: 23, color: "#68737b", marginTop: 18, lineHeight: 1.45}}>Ant Design, Recharts, and React Flow provide the structure. GSAP supplies the choreography.</div>
        </div>
      </AbsoluteFill>
    </ConfigProvider>
  );
};
