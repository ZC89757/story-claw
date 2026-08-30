import "@xyflow/react/dist/style.css";

import {Card, ConfigProvider, Table, Tag} from "antd";
import {CSSProperties} from "react";
import {AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig} from "remotion";
import {Background, Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps} from "@xyflow/react";
import {Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis} from "recharts";

const COLORS = {
  ink: "#14212b",
  paper: "#f5f4ef",
  blue: "#2d6cdf",
  cyan: "#21a7b8",
  green: "#27965d",
  yellow: "#efb33b",
  coral: "#e8665a",
  violet: "#7458d7",
  softBlue: "#edf4ff",
  softGreen: "#edf8f1",
  softGold: "#fff7e7",
  softCoral: "#fff0ee",
};

const clamp = {extrapolateLeft: "clamp" as const, extrapolateRight: "clamp" as const};
const SCENE_DURATION = 75;

type TableVisual = {type: "table"; headers: string[]; rows: string[][]; accent?: string};
type CardVisual = {type: "card"; value: string; accent?: string};
type ChartVisual = {type: "chart"; items: Array<{name: string; value: number}>};
type FlowVisual = {type: "flow"; nodes: Array<{id: string; label: string; x: number; y: number; color?: string}>; edges: Array<[string, string]>};
type Visual = TableVisual | CardVisual | ChartVisual | FlowVisual;

type Scene = {
  title: string;
  source: string;
  visual: Visual;
};

const scenes: Scene[] = [
  {
    title: "营收加速：经营进入增长阶段",
    source: "2023 年、2024 年和 2025 年营业收入分别为 1.59 亿元、3.93 亿元和 16.99 亿元；同期净利润分别为亏损 1114.51 万元、盈利 9547.47 万元和 2.78 亿元。",
    visual: {type: "table", headers: ["年份", "营业收入（亿元）", "净利润（亿元）"], rows: [["2023年", "1.59", "-0.111451"], ["2024年", "3.93", "0.954747"], ["2025年", "16.99", "2.78"]], accent: COLORS.blue},
  },
  {title: "收入扩大超十倍：盈利完成转折", source: "三年间收入扩大超过十倍，同时从亏损转为盈利，构成了支撑 IPO 定价的第一组数据。", visual: {type: "card", value: "收入规模 10x+", accent: COLORS.green}},
  {title: "收入增长，不等于经营风险消失", source: "但增长并没有让经营风险消失。", visual: {type: "card", value: "增长 != 风险消失", accent: COLORS.coral}},
  {
    title: "收入增长与利润质量",
    source: "2026 年第一季度，公司实现营业收入约 4.23 亿元，同比增长 68.49%；由于研发、销售等期间费用增加，扣除非经常性损益后的净利润却同比下降。",
    visual: {type: "table", headers: ["指标", "数值 / 变化"], rows: [["营业收入", "约 4.23 亿元"], ["营业收入同比", "+68.49%"], ["研发、销售等期间费用", "增加"], ["扣非净利润", "同比下降"]], accent: COLORS.coral},
  },
  {
    title: "上半年收入预测",
    source: "公司预计上半年收入为 10.52 亿至 11.28 亿元，同比增长 35.62% 至 45.41%，后续利润质量和费用效率需要继续观察。",
    visual: {type: "table", headers: ["预测项目", "数值"], rows: [["上半年收入下限", "10.52 亿元"], ["上半年收入上限", "11.28 亿元"], ["同比增速", "+35.62% 至 +45.41%"], ["后续观察项", "利润质量、费用效率"]], accent: COLORS.yellow},
  },
  {
    title: "IPO 定价与市值",
    source: "宇树科技 8 月 10 日启动科创板申购，发行价定为 150.80 元/股，对应发行后市值约 609.93 亿元。",
    visual: {type: "table", headers: ["IPO 项目", "数值"], rows: [["申购时间", "8 月 10 日"], ["发行价", "150.80 元 / 股"], ["发行后市值", "约 609.93 亿元"]], accent: COLORS.violet},
  },
  {
    title: "公开发行规模",
    source: "本次公开发行 4044.64 万股，占发行后总股本 10%，预计募集资金总额约 60.99 亿元。",
    visual: {type: "table", headers: ["IPO 项目", "数值"], rows: [["公开发行股份", "4044.64 万股"], ["占发行后总股本", "10%"], ["预计募资总额", "约 60.99 亿元"], ["业务特征", "人形机器人"]], accent: COLORS.cyan},
  },
  {
    title: "估值与业绩之间的距离",
    source: "宇树科技发行市盈率为 219.23 倍，明显高于行业平均的 38.56 倍。",
    visual: {type: "chart", items: [{name: "宇树科技", value: 219.23}, {name: "行业平均", value: 38.56}]},
  },
  {
    title: "高估值需要持续兑现",
    source: "高估值意味着市场提前计入了机器人行业的增长预期，上市之后，企业不仅要证明产品能卖，还要证明收入、利润和研发投入能够持续兑现。",
    visual: {type: "flow", nodes: linearNodes(["高估值", "产品能卖", "收入持续增长", "利润与研发持续兑现"]), edges: linearEdges(4)},
  },
  {title: "募资不止为了扩大现有产品销售", source: "募资用途显示，宇树并不满足于扩大现有产品销售。", visual: {type: "card", value: "资金投向下一代能力", accent: COLORS.blue}},
  {
    title: "募资用途",
    source: "资金将投向智能机器人模型研发、机器人本体研发、新型智能机器人产品和智能机器人制造基地，其中模型研发预计投入 20.22 亿元，占募资总额约 48.13%。",
    visual: {type: "table", headers: ["募资方向", "金额 / 比例"], rows: [["智能机器人模型研发", "20.22亿元，约 48.13%"], ["机器人本体研发", "未单独披露"], ["新型智能机器人产品", "未单独披露"], ["智能机器人制造基地", "未单独披露"]], accent: COLORS.blue},
  },
  {
    title: "同一套增长计划",
    source: "公司正在把硬件交付、模型能力和制造扩张放进同一套增长计划。",
    visual: {type: "flow", nodes: convergeNodes(["硬件交付", "模型能力", "制造扩张"], "同一套增长计划"), edges: [["a", "target"], ["b", "target"], ["c", "target"]]},
  },
  {title: "人形机器人商业化的真正难点", source: "这种资金配置也暴露出人形机器人商业化的真正难点。", visual: {type: "card", value: "硬件交付 + 模型能力", accent: COLORS.coral}},
  {
    title: "硬件与模型的双重考验",
    source: "硬件需要精密关节、整机设计和稳定交付，模型则要解决环境理解、任务规划和异常恢复；前者决定机器人能否被买到，后者决定它能否在真实工作中持续产生价值。",
    visual: {type: "flow", nodes: [{id: "hardware", label: "硬件：精密关节、整机设计、稳定交付", x: 90, y: 80, color: COLORS.coral}, {id: "buy", label: "机器人能否被买到", x: 700, y: 80, color: COLORS.yellow}, {id: "model", label: "模型：环境理解、任务规划、异常恢复", x: 90, y: 270, color: COLORS.blue}, {id: "value", label: "真实工作中持续产生价值", x: 700, y: 270, color: COLORS.green}], edges: [["hardware", "buy"], ["model", "value"]]},
  },
  {
    title: "从演示到可重复任务",
    source: "研发资金投向模型，说明企业需要把一次性演示转化为可重复任务能力。",
    visual: {type: "flow", nodes: linearNodes(["一次性演示", "可重复任务能力"]), edges: linearEdges(2)},
  },
  {
    title: "战略配售带来观察样本",
    source: "战略配售中包括社保基金、深度求索和中国石油集团等机构，公开市场因此获得了一个观察人形机器人产业化的样本。",
    visual: {type: "table", headers: ["项目", "内容"], rows: [["战略配售机构", "社保基金、深度求索、中国石油集团等"], ["公开市场获得的内容", "观察人形机器人产业化的样本"]], accent: COLORS.green},
  },
  {
    title: "客户验证不可替代",
    source: "战略投资者的参与能够提供资金和合作预期，却不能替代客户对可靠性、维护成本、任务成功率和回报周期的验证。",
    visual: {type: "flow", nodes: [{id: "a", label: "战略投资者参与", x: 25, y: 165}, {id: "b", label: "资金与合作预期", x: 280, y: 165, color: COLORS.green}, {id: "c", label: "不能替代客户验证", x: 545, y: 165, color: COLORS.coral}, {id: "d", label: "可靠性", x: 865, y: 30}, {id: "e", label: "维护成本", x: 865, y: 125}, {id: "f", label: "任务成功率", x: 865, y: 220}, {id: "g", label: "回报周期", x: 865, y: 315}], edges: [["a", "b"], ["b", "c"], ["c", "d"], ["c", "e"], ["c", "f"], ["c", "g"]]},
  },
  {title: "IPO只是商业化考核的起点", source: "对宇树科技而言，IPO 只是商业化考核的起点。", visual: {type: "card", value: "上市不是终点", accent: COLORS.violet}},
  {
    title: "上市后的经营要求",
    source: "高发行市盈率要求公司持续扩大收入，同时保持利润和现金投入之间的平衡；模型研发、产品开发和制造基地也必须形成相互反馈。",
    visual: {type: "table", headers: ["要求", "内容"], rows: [["收入", "持续扩大收入"], ["资金平衡", "利润和现金投入之间的平衡"], ["研发、产品与制造", "形成相互反馈"]], accent: COLORS.violet},
  },
  {
    title: "可计费场景验证",
    source: "未来更有说服力的指标，将是机器人在可计费场景中的稳定运行，以及这些场景能否带来重复采购。",
    visual: {type: "flow", nodes: linearNodes(["可计费场景", "稳定运行", "重复采购"]), edges: linearEdges(3)},
  },
  {title: "从技术展示到财务报表与公开估值", source: "这次申购把人形机器人从技术展示推到了财务报表和公开估值面前。", visual: {type: "card", value: "技术展示 -> 可持续生意", accent: COLORS.yellow}},
  {
    title: "可持续生意的连接",
    source: "市场接下来要检验的不是机器人能做出多少动作，而是宇树能否把制造规模、模型研发和真实客户需求连接成一门可持续的生意。",
    visual: {type: "flow", nodes: convergeNodes(["制造规模", "模型研发", "真实客户需求"], "可持续的生意"), edges: [["a", "target"], ["b", "target"], ["c", "target"]]},
  },
];

function linearNodes(labels: string[]) {
  // The React Flow viewport is 1400px wide and every node occupies 220px.
  // Keep the final node within that viewport, including its own width.
  const gap = 1120 / Math.max(labels.length - 1, 1);
  return labels.map((label, index) => ({id: `n${index}`, label, x: 45 + index * gap, y: 170, color: [COLORS.blue, COLORS.cyan, COLORS.green, COLORS.violet][index % 4]}));
}

function linearEdges(count: number): Array<[string, string]> {
  return Array.from({length: count - 1}, (_, index) => [`n${index}`, `n${index + 1}`]);
}

function convergeNodes(labels: string[], target: string) {
  return [
    ...labels.map((label, index) => ({id: String.fromCharCode(97 + index), label, x: 80, y: 25 + index * 145, color: [COLORS.blue, COLORS.cyan, COLORS.yellow][index]})),
    {id: "target", label: target, x: 800, y: 160, color: COLORS.violet},
  ];
}

const sceneBackgrounds = [COLORS.softBlue, COLORS.softGreen, COLORS.softGold, COLORS.softCoral];

const appear = (frame: number, start: number, duration = 12) => interpolate(frame, [start, start + duration], [0, 1], clamp);

const SourceLine = ({source, frame}: {source: string; frame: number}) => {
  const opacity = appear(frame, 2);
  return <div style={{position: "absolute", left: 146, top: 222, width: 1628, color: "#53616c", fontSize: 25, lineHeight: 1.5, opacity, transform: `translateY(${interpolate(opacity, [0, 1], [16, 0])}px)`}}>{source}</div>;
};

const MetricCard = ({value, accent, frame}: {value: string; accent: string; frame: number}) => {
  const progress = spring({frame: Math.max(0, frame - 12), fps: 30, config: {damping: 15, stiffness: 130}});
  return <Card bordered={false} style={{position: "absolute", left: 400, top: 440, width: 1120, height: 290, background: "#fff", borderLeft: `15px solid ${accent}`, boxShadow: "0 26px 60px rgba(20,33,43,0.14)", opacity: progress, transform: `translateY(${interpolate(progress, [0, 1], [45, 0])}px) scale(${interpolate(progress, [0, 1], [0.94, 1])})`}} styles={{body: {padding: "58px 70px"}}}>
    <div style={{fontSize: 27, fontWeight: 800, color: accent, letterSpacing: 1.5}}>KEY TAKEAWAY</div>
    <div style={{fontSize: 68, fontWeight: 900, color: COLORS.ink, marginTop: 28}}>{value}</div>
  </Card>;
};

const DataTable = ({headers, rows, accent, frame}: TableVisual & {frame: number}) => {
  const scale = interpolate(appear(frame, 10), [0, 1], [0.94, 1]);
  const columns = headers.map((header, index) => ({title: header, dataIndex: `c${index}`, key: `c${index}`, align: index === 0 ? "left" as const : "center" as const}));
  const data = rows.map((row, rowIndex) => Object.fromEntries(row.map((cell, index) => [`c${index}`, cell]).concat([["key", String(rowIndex)]])));
  return <div style={{position: "absolute", left: 260, top: 380, width: 1400, opacity: appear(frame, 10), transform: `scale(${scale})`, transformOrigin: "top center", borderTop: `10px solid ${accent ?? COLORS.blue}`, boxShadow: "0 20px 46px rgba(20,33,43,0.11)"}}>
    <Table columns={columns} dataSource={data} pagination={false} bordered size="large" tableLayout="fixed" />
  </div>;
};

const PeChart = ({items, frame}: ChartVisual & {frame: number}) => {
  const reveal = appear(frame, 10, 24);
  return <div style={{position: "absolute", left: 255, top: 350, width: 1410, height: 550, background: "#fff", padding: "34px 40px", boxSizing: "border-box", boxShadow: "0 20px 46px rgba(20,33,43,0.11)", opacity: reveal, clipPath: `inset(0 ${interpolate(reveal, [0, 1], [100, 0])}% 0 0)`}}>
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={items} margin={{top: 35, right: 70, left: 30, bottom: 20}}>
        <CartesianGrid vertical={false} stroke="#dce4ee" strokeDasharray="5 6" />
        <XAxis dataKey="name" tick={{fontSize: 28, fontWeight: 800, fill: COLORS.ink}} axisLine={{stroke: COLORS.ink, strokeWidth: 2}} tickLine={false} />
        <YAxis domain={[0, 240]} tick={{fontSize: 20, fill: "#5f6d77"}} label={{value: "市盈率（倍）", angle: -90, position: "insideLeft", style: {fill: "#5f6d77", fontSize: 22}}} axisLine={false} tickLine={false} />
        <Tooltip />
        <Bar dataKey="value" radius={[10, 10, 0, 0]} fill={COLORS.coral} isAnimationActive={false}>
          <LabelList dataKey="value" position="top" formatter={(value) => `${value}x`} style={{fill: COLORS.ink, fontSize: 30, fontWeight: 900}} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  </div>;
};

type FlowNodeData = {label: string; color: string; progress: number};

const FlowNode = ({data}: NodeProps<Node<FlowNodeData>>) => <div style={{width: 220, opacity: data.progress, transform: `translateY(${interpolate(data.progress, [0, 1], [24, 0])}px) scale(${interpolate(data.progress, [0, 1], [0.86, 1])})`}}>
  <Handle type="target" position={Position.Left} style={{opacity: 0}} />
  <Card size="small" style={{height: 92, border: `4px solid ${data.color}`, boxShadow: "0 12px 28px rgba(20,33,43,0.11)", background: "#fff"}} styles={{body: {height: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: "12px 16px", textAlign: "center"}}}>
    <span style={{fontSize: 20, lineHeight: 1.25, fontWeight: 900, color: COLORS.ink}}>{data.label}</span>
  </Card>
  <Handle type="source" position={Position.Right} style={{opacity: 0}} />
</div>;

const flowNodeTypes = {unitree: FlowNode};

const ProcessFlow = ({nodes, edges, frame}: FlowVisual & {frame: number}) => {
  const flowNodes: Array<Node<FlowNodeData>> = nodes.map((node, index) => ({id: node.id, type: "unitree", position: {x: node.x, y: node.y}, data: {label: node.label, color: node.color ?? [COLORS.blue, COLORS.cyan, COLORS.green, COLORS.violet][index % 4], progress: appear(frame, 10 + index * 5)}}));
  const flowEdges: Edge[] = edges.map(([source, target], index) => ({id: `${source}-${target}`, source, target, type: "smoothstep", markerEnd: {type: MarkerType.ArrowClosed, color: COLORS.ink}, style: {stroke: COLORS.ink, strokeWidth: 4, opacity: appear(frame, 18 + index * 5)}}));
  return <div style={{position: "absolute", left: 260, top: 375, width: 1400, height: 500, border: "1px solid #e2e8ed", background: "rgba(255,255,255,0.8)", opacity: appear(frame, 8)}}>
    <ReactFlow nodes={flowNodes} edges={flowEdges} nodeTypes={flowNodeTypes} defaultViewport={{x: 0, y: 0, zoom: 1}} nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} panOnDrag={false} zoomOnScroll={false} zoomOnPinch={false} zoomOnDoubleClick={false} proOptions={{hideAttribution: true}}>
      <Background color="#e5ebee" gap={22} size={1} />
    </ReactFlow>
  </div>;
};

const SceneVisual = ({visual, frame}: {visual: Visual; frame: number}) => {
  if (visual.type === "table") return <DataTable {...visual} frame={frame} />;
  if (visual.type === "card") return <MetricCard {...visual} accent={visual.accent ?? COLORS.blue} frame={frame} />;
  if (visual.type === "chart") return <PeChart {...visual} frame={frame} />;
  return <ProcessFlow {...visual} frame={frame} />;
};

const ScenePage = ({scene, sceneIndex, localFrame}: {scene: Scene; sceneIndex: number; localFrame: number}) => {
  const background = sceneBackgrounds[sceneIndex % sceneBackgrounds.length];
  const titleProgress = appear(localFrame, 0);
  return <AbsoluteFill style={{background, overflow: "hidden", color: COLORS.ink}}>
    <div style={{position: "absolute", left: 146, top: 76, color: COLORS.coral, fontSize: 20, fontWeight: 900, letterSpacing: 2}}>宇树科技 IPO / {String(sceneIndex + 1).padStart(2, "0")}</div>
    <div style={{position: "absolute", left: 146, top: 116, width: 1628, fontSize: 54, lineHeight: 1.16, fontWeight: 900, opacity: titleProgress, transform: `translateY(${interpolate(titleProgress, [0, 1], [26, 0])}px)`}}>{scene.title}</div>
    <SourceLine source={scene.source} frame={localFrame} />
    <SceneVisual visual={scene.visual} frame={localFrame} />
    <div style={{position: "absolute", left: 146, bottom: 62, height: 5, width: 1628, background: "rgba(20,33,43,0.12)"}}><div style={{height: "100%", width: `${interpolate(localFrame, [0, SCENE_DURATION], [0, 100], clamp)}%`, background: COLORS.coral}} /></div>
  </AbsoluteFill>;
};

export const UNITREE_IPO_DURATION_IN_FRAMES = scenes.length * SCENE_DURATION;

export const UnitreeIpoMg = () => {
  const frame = useCurrentFrame();
  const sceneIndex = Math.min(Math.floor(frame / SCENE_DURATION), scenes.length - 1);
  return <ConfigProvider theme={{token: {fontFamily: 'Inter, "Microsoft YaHei", Arial, sans-serif', colorPrimary: COLORS.blue, borderRadius: 10}}}>
    <ScenePage scene={scenes[sceneIndex]} sceneIndex={sceneIndex} localFrame={frame - sceneIndex * SCENE_DURATION} />
  </ConfigProvider>;
};
