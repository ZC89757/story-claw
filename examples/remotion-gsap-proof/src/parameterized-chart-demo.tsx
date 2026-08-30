import {AbsoluteFill, Audio, staticFile, useCurrentFrame, useVideoConfig} from "remotion";
import rawSpec from "./chart-motion-spec.json";
import {
  ChartMotionSpec,
  MovementMode,
  RisingChartTemplate,
  evaluateChartPoint,
  sampleChartTrail,
  validateChartMotionSpec,
} from "./chart-motion-template";

export const PARAMETERIZED_CHART_FPS = 60;
export const PARAMETERIZED_CHART_DURATION_IN_FRAMES = 348;

const speechSegments = [
  {start: 0.316, end: 1.723, text: "OpenAI同期公布"},
  {start: 2.11, end: 3.434, text: "两项API设置"},
  {start: 3.651, end: 5.446, text: "可显著提升模型性价比"},
];

const makeSpec = (movement: MovementMode): ChartMotionSpec => ({
  ...(rawSpec as ChartMotionSpec),
  movement,
});

const ParameterizedChartDemo = ({movement}: {movement: MovementMode}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const seconds = frame / fps;
  const spec = makeSpec(movement);
  validateChartMotionSpec(spec);
  const point = evaluateChartPoint(spec, seconds);
  const trail = sampleChartTrail(spec, seconds, fps);
  const activeSpeech = speechSegments.find(({start, end}) => seconds >= start && seconds <= end)?.text ?? "语音停顿";

  return (
    <AbsoluteFill style={{background: "#f2efe8", color: "#1d211f", fontFamily: '"Microsoft YaHei", Arial, sans-serif'}}>
      <Audio src={staticFile("audio/openai-api-settings-tts.wav")} />
      <div style={{position: "absolute", left: 72, right: 72, top: 48, display: "flex", justifyContent: "space-between", alignItems: "baseline", borderBottom: "2px solid #cec9bf", paddingBottom: 18}}>
        <div>
          <div style={{fontSize: 22, fontWeight: 800, color: "#d94e3f"}}>PARAMETER-DRIVEN MG TEMPLATE</div>
          <div style={{fontSize: 42, fontWeight: 900, marginTop: 7}}>大模型只输出参数，模板负责稳定渲染</div>
        </div>
        <div style={{fontFamily: "Consolas, monospace", fontSize: 23}}>
          movement: <strong style={{color: movement === "ease" ? "#2869d8" : "#d94e3f"}}>{movement}</strong>
        </div>
      </div>

      <div style={{position: "absolute", left: 72, top: 175, width: 485, height: 716, background: "#1d211f", color: "#fff", padding: "30px 34px", boxSizing: "border-box"}}>
        <div style={{fontSize: 20, color: "#f1b84b", fontWeight: 800, marginBottom: 20}}>模型输出 / 已通过校验</div>
        <pre style={{margin: 0, whiteSpace: "pre-wrap", fontFamily: "Consolas, monospace", fontSize: 18, lineHeight: 1.55, color: "#e9ece8"}}>{`{
  axes: {
    x: [0, 2], "设置数量/项",
    y: [0, 100], "性价比/示意值"
  },
  keyframes: {
    "0.000": [0, 32],
    "1.723": [0, 32],
    "3.434": [2, 32],
    "5.446": [2, 82]
  },
  movement: "${movement}"
}`}</pre>
        <div style={{position: "absolute", left: 34, right: 34, bottom: 30, borderTop: "1px solid #555b56", paddingTop: 20}}>
          <div style={{fontSize: 18, color: "#aeb5af"}}>当前模板输入</div>
          <div style={{fontFamily: "Consolas, monospace", fontSize: 27, marginTop: 8}}>t = {seconds.toFixed(3)}s</div>
          <div style={{fontFamily: "Consolas, monospace", fontSize: 25, marginTop: 6, color: "#f1b84b"}}>p = ({point.x.toFixed(2)}, {point.y.toFixed(2)})</div>
        </div>
      </div>

      <RisingChartTemplate axes={spec.axes} point={point} trail={trail} style={{position: "absolute", left: 615, top: 175}} />

      <div style={{position: "absolute", left: 615, top: 815, width: 1180}}>
        <div style={{fontSize: 20, color: "#777b76"}}>当前 TTS 语义段</div>
        <div style={{fontSize: 34, fontWeight: 900, marginTop: 6}}>{activeSpeech}</div>
        <div style={{height: 5, marginTop: 18, background: "#d5d1c8"}}>
          <div style={{height: "100%", width: `${Math.min(100, seconds / 5.8 * 100)}%`, background: "#d94e3f"}} />
        </div>
      </div>

      <div style={{position: "absolute", left: 72, right: 72, bottom: 44, display: "flex", justifyContent: "space-between", fontSize: 19, color: "#747872"}}>
        <span>时间点语义：在该时刻到达目标坐标</span>
        <span>指数为动画架构演示值，不代表 OpenAI 官方数据</span>
      </div>
    </AbsoluteFill>
  );
};

export const ParameterizedChartEase = () => <ParameterizedChartDemo movement="ease" />;
export const ParameterizedChartInstant = () => <ParameterizedChartDemo movement="instant" />;
