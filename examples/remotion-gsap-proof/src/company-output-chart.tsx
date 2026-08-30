import {AbsoluteFill, Audio, staticFile, useCurrentFrame, useVideoConfig} from "remotion";
import rawSpec from "./company-output-chart-spec.json";
import timestamps from "./company-output-timestamps.json";
import {
  ChartMotionSpec,
  RisingChartTemplate,
  evaluateChartPoint,
  sampleChartTrail,
  validateChartMotionSpec,
} from "./chart-motion-template";

export const COMPANY_OUTPUT_FPS = 60;
export const COMPANY_OUTPUT_DURATION_IN_FRAMES = Math.ceil(rawSpec.source.duration * COMPANY_OUTPUT_FPS);

export const CompanyOutputChart = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const seconds = frame / fps;
  const spec = rawSpec as ChartMotionSpec;
  validateChartMotionSpec(spec);
  const point = evaluateChartPoint(spec, seconds);
  const trail = sampleChartTrail(spec, seconds, fps);
  const currentWord = timestamps.words.find(({startTime, endTime}) => seconds >= startTime && seconds <= endTime)?.word ?? "";
  const activeSection = rawSpec.source.sections.find(({start, end}) => seconds >= start && seconds <= end);
  const progress = Math.min(1, seconds / rawSpec.source.duration);

  return (
    <AbsoluteFill style={{background: "#f3f0e9", color: "#19201c", fontFamily: '"Microsoft YaHei", Arial, sans-serif'}}>
      <Audio src={staticFile("audio/company-output-six-years.wav")} />
      <div style={{position: "absolute", left: 76, right: 76, top: 50, display: "flex", justifyContent: "space-between", alignItems: "flex-end", borderBottom: "2px solid #d1ccc2", paddingBottom: 18}}>
        <div>
          <div style={{fontSize: 21, color: "#d94e3f", fontWeight: 900}}>六年经营数据 / TTS时间戳驱动</div>
          <div style={{fontSize: 48, fontWeight: 900, marginTop: 7}}>公司总产值变化</div>
        </div>
        <div style={{display: "flex", gap: 48, alignItems: "baseline"}}>
          <div style={{fontSize: 20, color: "#73776f"}}>当前时间</div>
          <div style={{fontFamily: "Consolas, monospace", fontSize: 30, fontWeight: 700}}>{seconds.toFixed(3)}s</div>
        </div>
      </div>

      <div style={{position: "absolute", left: 76, top: 175, width: 440, height: 650, background: "#19201c", color: "#fff", padding: "34px 36px", boxSizing: "border-box"}}>
        <div style={{fontSize: 20, color: "#f0b541", fontWeight: 900}}>原始数据</div>
        {[
          ["第 1 年", "48 万元"],
          ["第 2 年", "96 万元"],
          ["第 3 年", "96 万元"],
          ["第 4 年", "96 万元"],
          ["第 5 年", "96 万元"],
          ["第 6 年", "近 1658 万元"],
        ].map(([year, value], index) => {
          const isCurrent = Math.round(point.x) === index + 1;
          return <div key={year} style={{display: "flex", justifyContent: "space-between", alignItems: "baseline", borderBottom: "1px solid #434a45", padding: "20px 0", color: isCurrent ? "#f0b541" : "#eef0ed"}}>
            <span style={{fontSize: 23}}>{year}</span>
            <strong style={{fontSize: 29}}>{value}</strong>
          </div>;
        })}
        <div style={{position: "absolute", left: 36, right: 36, bottom: 28, color: "#aab1ab", fontSize: 18}}>第三至第五年按96万元持平处理</div>
      </div>

      <RisingChartTemplate axes={spec.axes} point={point} trail={trail} accent="#d94e3f" style={{position: "absolute", left: 588, top: 175}} />

      <div style={{position: "absolute", left: 588, top: 815, width: 1180, display: "grid", gridTemplateColumns: "1fr 340px", gap: 30, alignItems: "end"}}>
        <div>
          <div style={{fontSize: 20, color: "#747971"}}>当前语义段</div>
          <div style={{fontSize: 34, fontWeight: 900, marginTop: 6}}>{activeSection ? `${activeSection.title} · ${activeSection.value}` : "语音停顿"}</div>
        </div>
        <div style={{display: "flex", justifyContent: "flex-end", alignItems: "baseline", gap: 18}}>
          <span style={{fontSize: 20, color: "#747971"}}>当前朗读词</span>
          <span style={{minWidth: 96, textAlign: "center", background: currentWord ? "#19201c" : "#d8d4cb", color: "#fff", padding: "9px 18px", fontSize: 31, fontWeight: 900}}>{currentWord || "—"}</span>
        </div>
        <div style={{gridColumn: "1 / -1", height: 6, background: "#d6d2c9"}}>
          <div style={{height: "100%", width: `${progress * 100}%`, background: "#d94e3f"}} />
        </div>
      </div>

      <div style={{position: "absolute", left: 76, right: 76, bottom: 44, display: "flex", justifyContent: "space-between", fontSize: 19, color: "#747971"}}>
        <span>折线位置由TTS字级时间戳自动生成</span>
        <span>单位：万元</span>
      </div>
    </AbsoluteFill>
  );
};
