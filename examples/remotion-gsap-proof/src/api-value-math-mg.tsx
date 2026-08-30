import {gsap} from "gsap";
import React, {useLayoutEffect, useMemo, useRef} from "react";
import {
  AbsoluteFill,
  Audio,
  Easing,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import envelope from "./audio-envelope.json";

const COLORS = {
  paper: "#f4f0e7",
  ink: "#171916",
  muted: "#77766f",
  blue: "#2869d8",
  red: "#dd4b3e",
  green: "#258768",
  rule: "#d5d0c5",
  white: "#fffdf8",
};

const CUES = {
  speechStart: 0.316,
  announcementEnd: 1.723,
  settingsStart: 2.11,
  settingsEnd: 3.434,
  resultStart: 3.651,
  resultEnd: 5.446,
  audioEnd: 5.8,
};

const phrases = [
  {text: "OpenAI同期公布", start: CUES.speechStart, end: CUES.announcementEnd},
  {text: "两项API设置", start: CUES.settingsStart, end: CUES.settingsEnd},
  {text: "可显著提升模型性价比", start: CUES.resultStart, end: CUES.resultEnd},
] as const;

const clamp = {extrapolateLeft: "clamp", extrapolateRight: "clamp"} as const;

const useEnergy = (frame: number) => {
  const sourceFrame = Math.max(0, frame - 3);
  const sample = envelope.frames[Math.min(sourceFrame, envelope.frames.length - 1)];
  return sample?.rms ?? 0;
};

const activePhraseAt = (seconds: number) =>
  phrases.findIndex(({start, end}) => seconds >= start && seconds <= end);

const MathStage = ({seconds}: {seconds: number}) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const announcementRef = useRef<HTMLDivElement>(null);
  const openAiRef = useRef<HTMLDivElement>(null);
  const announcementRuleRef = useRef<HTMLDivElement>(null);
  const sourceNoteRef = useRef<HTMLDivElement>(null);
  const settingsRef = useRef<HTMLDivElement>(null);
  const variableRefs = useRef<Array<HTMLDivElement | null>>([]);
  const matrixRefs = useRef<Array<HTMLDivElement | null>>([]);
  const matrixArrowRef = useRef<SVGPathElement>(null);
  const modelRef = useRef<HTMLDivElement>(null);
  const definitionRef = useRef<HTMLDivElement>(null);
  const comparisonRefs = useRef<Array<HTMLDivElement | null>>([]);
  const graphLineRef = useRef<SVGPathElement>(null);
  const graphDotRef = useRef<SVGCircleElement>(null);
  const deltaRef = useRef<HTMLDivElement>(null);
  const conclusionRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<gsap.core.Timeline | null>(null);

  useLayoutEffect(() => {
    const context = gsap.context(() => {
      const timeline = gsap.timeline({paused: true});
      const matrixTiles = matrixRefs.current.filter(Boolean);
      const variables = variableRefs.current.filter(Boolean);
      const comparisons = comparisonRefs.current.filter(Boolean);

      timeline
        .set([announcementRef.current, settingsRef.current, modelRef.current, conclusionRef.current], {
          autoAlpha: 0,
        })
        .set(announcementRef.current, {autoAlpha: 1}, 0)
        .fromTo(openAiRef.current, {y: 44, autoAlpha: 0}, {y: 0, autoAlpha: 1, duration: 0.55, ease: "power3.out"}, CUES.speechStart)
        .fromTo(announcementRuleRef.current, {scaleX: 0}, {scaleX: 1, duration: 0.72, ease: "power2.inOut"}, 0.58)
        .fromTo(sourceNoteRef.current, {x: 42, autoAlpha: 0}, {x: 0, autoAlpha: 1, duration: 0.48, ease: "power2.out"}, 0.92)
        .to(announcementRef.current, {y: -54, scale: 0.88, autoAlpha: 0, duration: 0.33, ease: "power2.in"}, CUES.announcementEnd)
        .set(settingsRef.current, {autoAlpha: 1}, 1.87)
        .fromTo(variables, {y: 65, autoAlpha: 0}, {y: 0, autoAlpha: 1, stagger: 0.18, duration: 0.48, ease: "back.out(1.25)"}, CUES.settingsStart)
        .fromTo(matrixTiles, {scale: 0.86, autoAlpha: 0}, {scale: 1, autoAlpha: 1, stagger: 0.09, duration: 0.38, ease: "power2.out"}, 2.38)
        .fromTo(matrixArrowRef.current, {strokeDashoffset: 520}, {strokeDashoffset: 0, duration: 0.75, ease: "power2.inOut"}, 2.62)
        .to(matrixTiles.slice(0, 3), {opacity: 0.34, duration: 0.25}, 3.14)
        .to(matrixTiles[3], {scale: 1.045, borderColor: COLORS.red, duration: 0.28, ease: "back.out(1.5)"}, 3.14)
        .to(settingsRef.current, {x: -220, scale: 0.82, autoAlpha: 0, duration: 0.38, ease: "power3.inOut"}, CUES.resultStart)
        .set(modelRef.current, {autoAlpha: 1}, CUES.resultStart)
        .fromTo(definitionRef.current, {x: 70, autoAlpha: 0}, {x: 0, autoAlpha: 1, duration: 0.55, ease: "power3.out"}, CUES.resultStart)
        .fromTo(comparisons, {y: 35, autoAlpha: 0}, {y: 0, autoAlpha: 1, stagger: 0.13, duration: 0.42, ease: "power2.out"}, 4.0)
        .fromTo(graphLineRef.current, {strokeDashoffset: 640}, {strokeDashoffset: 0, duration: 0.78, ease: "power2.inOut"}, 4.18)
        .fromTo(graphDotRef.current, {attr: {cx: 92, cy: 215}}, {attr: {cx: 476, cy: 70}, duration: 0.78, ease: "power2.inOut"}, 4.18)
        .fromTo(deltaRef.current, {scale: 0.82, autoAlpha: 0}, {scale: 1, autoAlpha: 1, duration: 0.42, ease: "back.out(1.35)"}, 4.62)
        .to([settingsRef.current, modelRef.current], {autoAlpha: 0, duration: 0.26}, 5.12)
        .set(conclusionRef.current, {autoAlpha: 1}, 5.12)
        .fromTo(conclusionRef.current, {y: 24}, {y: 0, duration: 0.34, ease: "power2.out"}, 5.12);

      timelineRef.current = timeline;
    }, rootRef);

    return () => {
      timelineRef.current = null;
      context.revert();
    };
  }, []);

  useLayoutEffect(() => {
    timelineRef.current?.seek(seconds, false);
  }, [seconds]);

  return (
    <div ref={rootRef} style={{position: "absolute", inset: 0}}>
      <div ref={announcementRef} style={{position: "absolute", inset: "120px 130px 170px"}}>
        <div style={{fontSize: 24, color: COLORS.red, fontWeight: 700, marginBottom: 42}}>信息来源 / 同期公告</div>
        <div ref={openAiRef} style={{fontSize: 156, lineHeight: 0.88, fontWeight: 800, letterSpacing: 0}}>OpenAI</div>
        <div ref={announcementRuleRef} style={{height: 5, width: 900, background: COLORS.ink, transformOrigin: "left", margin: "38px 0"}} />
        <div ref={sourceNoteRef} style={{display: "flex", alignItems: "baseline", gap: 30}}>
          <span style={{fontSize: 72, fontWeight: 760}}>同期公布</span>
          <span style={{fontSize: 30, color: COLORS.muted}}>两项与 API 使用方式相关的设置</span>
        </div>
      </div>

      <div ref={settingsRef} style={{position: "absolute", left: 185, top: 165, width: 1550, height: 690}}>
        <div style={{display: "grid", gridTemplateColumns: "610px 1fr", gap: 92, height: "100%"}}>
          <div>
            <div style={{fontSize: 25, color: COLORS.muted, marginBottom: 18}}>两项 API 设置，形式化为两个二元变量</div>
            <div style={{fontFamily: "Georgia, serif", fontSize: 68, fontWeight: 700, marginBottom: 38}}>
              s₁, s₂ ∈ {'{0, 1}'}
            </div>
            {["s₁", "s₂"].map((label, index) => (
              <div
                key={label}
                ref={(element) => {variableRefs.current[index] = element;}}
                style={{display: "grid", gridTemplateColumns: "92px 1fr 92px", alignItems: "center", borderTop: `2px solid ${COLORS.rule}`, padding: "28px 0"}}
              >
                <div style={{fontFamily: "Georgia, serif", fontSize: 54, fontWeight: 700}}>{label}</div>
                <div style={{height: 12, background: COLORS.rule, position: "relative"}}>
                  <div style={{position: "absolute", left: 0, top: 0, bottom: 0, width: "100%", background: index === 0 ? COLORS.blue : COLORS.red}} />
                  <div style={{position: "absolute", right: -2, top: -15, width: 42, height: 42, borderRadius: "50%", background: COLORS.ink, border: `8px solid ${COLORS.paper}`}} />
                </div>
                <div style={{fontFamily: "Georgia, serif", fontSize: 46, textAlign: "right"}}>1</div>
              </div>
            ))}
          </div>

          <div style={{position: "relative"}}>
            <div style={{fontSize: 25, color: COLORS.muted, marginBottom: 20}}>配置状态空间</div>
            <div style={{display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, width: 650}}>
              {["(0, 0)  默认", "(1, 0)", "(0, 1)", "(1, 1)  两项启用"].map((label, index) => (
                <div
                  key={label}
                  ref={(element) => {matrixRefs.current[index] = element;}}
                  style={{height: 155, background: COLORS.white, border: `3px solid ${index === 0 ? COLORS.blue : COLORS.rule}`, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "Georgia, serif", fontSize: index === 3 ? 31 : 36, fontWeight: index === 0 || index === 3 ? 700 : 500}}
                >
                  {label}
                </div>
              ))}
            </div>
            <svg width="650" height="120" viewBox="0 0 650 120" style={{position: "absolute", left: 0, top: 390, overflow: "visible"}}>
              <path ref={matrixArrowRef} d="M 18 22 C 190 108, 430 108, 625 22" fill="none" stroke={COLORS.red} strokeWidth="5" strokeDasharray="520" strokeDashoffset="520" />
              <path d="M 607 10 L 630 22 L 607 36" fill="none" stroke={COLORS.red} strokeWidth="5" />
            </svg>
            <div style={{position: "absolute", top: 515, width: 650, textAlign: "center", fontSize: 26, color: COLORS.red, fontWeight: 700}}>从默认配置到启用两项设置</div>
          </div>
        </div>
      </div>

      <div ref={modelRef} style={{position: "absolute", left: 420, top: 135, width: 1340, height: 760}}>
        <div ref={definitionRef} style={{display: "flex", alignItems: "center", gap: 34, borderBottom: `2px solid ${COLORS.rule}`, paddingBottom: 28}}>
          <span style={{fontFamily: "Georgia, serif", fontSize: 80, fontWeight: 700}}>V =</span>
          <div style={{fontSize: 34, fontWeight: 700, textAlign: "center", lineHeight: 1.25}}>
            <div style={{padding: "0 24px 12px", borderBottom: `4px solid ${COLORS.ink}`}}>有效模型产出 Q</div>
            <div style={{paddingTop: 12}}>API 总投入 C</div>
          </div>
          <div style={{fontSize: 25, lineHeight: 1.5, color: COLORS.muted}}>性价比指标<br />只表达相对关系</div>
        </div>

        <div style={{display: "grid", gridTemplateColumns: "430px 1fr", gap: 85, marginTop: 36}}>
          <div>
            {[{title: "默认配置", equation: "V₀ = V(0, 0)", color: COLORS.blue}, {title: "启用两项设置", equation: "V₁ = V(1, 1)", color: COLORS.red}].map((item, index) => (
              <div key={item.title} ref={(element) => {comparisonRefs.current[index] = element;}} style={{borderLeft: `8px solid ${item.color}`, padding: "18px 22px", marginBottom: 24, background: COLORS.white}}>
                <div style={{fontSize: 22, color: COLORS.muted, marginBottom: 8}}>{item.title}</div>
                <div style={{fontFamily: "Georgia, serif", fontSize: 38, fontWeight: 700}}>{item.equation}</div>
              </div>
            ))}
            <div ref={(element) => {comparisonRefs.current[2] = element;}} style={{fontFamily: "Georgia, serif", fontSize: 48, fontWeight: 700, paddingTop: 4}}>
              V₁ &gt; V₀
            </div>
          </div>

          <div style={{position: "relative", height: 390}}>
            <svg width="540" height="310" viewBox="0 0 540 310">
              <path d="M 58 25 L 58 260 L 515 260" fill="none" stroke={COLORS.ink} strokeWidth="3" />
              <path ref={graphLineRef} d="M 92 215 C 220 210, 300 155, 476 70" fill="none" stroke={COLORS.red} strokeWidth="7" strokeDasharray="640" strokeDashoffset="640" />
              <circle cx="92" cy="215" r="11" fill={COLORS.blue} />
              <circle ref={graphDotRef} cx="92" cy="215" r="14" fill={COLORS.red} />
              <text x="10" y="32" fontSize="24" fontWeight="700" fill={COLORS.ink}>V</text>
              <text x="50" y="292" fontSize="21" fill={COLORS.muted}>默认</text>
              <text x="408" y="292" fontSize="21" fill={COLORS.muted}>两项启用</text>
            </svg>
            <div ref={deltaRef} style={{position: "absolute", right: 15, top: 6, fontFamily: "Georgia, serif", fontSize: 43, color: COLORS.red, fontWeight: 700}}>
              ΔV = V₁ − V₀ &gt; 0
            </div>
          </div>
        </div>
      </div>

      <div ref={conclusionRef} style={{position: "absolute", left: 150, right: 150, top: 245, textAlign: "center"}}>
        <div style={{fontSize: 27, color: COLORS.muted, marginBottom: 36}}>由文案能够确认的关系</div>
        <div style={{display: "flex", alignItems: "center", justifyContent: "center", gap: 38, fontWeight: 760}}>
          <span style={{fontSize: 52}}>两项 API 设置</span>
          <span style={{fontSize: 60, color: COLORS.red}}>→</span>
          <span style={{fontFamily: "Georgia, serif", fontSize: 66}}>ΔV &gt; 0</span>
        </div>
        <div style={{fontSize: 76, fontWeight: 820, marginTop: 54}}>模型性价比显著提升</div>
      </div>
    </div>
  );
};

const DebugOverlay = ({frame, seconds, energy}: {frame: number; seconds: number; energy: number}) => {
  const active = activePhraseAt(seconds);
  return (
    <div style={{position: "absolute", left: 26, right: 26, top: 22, zIndex: 50, display: "flex", justifyContent: "space-between", color: COLORS.white, background: "rgba(23,25,22,0.91)", padding: "12px 18px", fontFamily: "Consolas, monospace", fontSize: 18}}>
      <span>FRAME {String(frame).padStart(3, "0")} / 347</span>
      <span>TIME {seconds.toFixed(3)}s</span>
      <span>CUE {active >= 0 ? phrases[active].text : "PAUSE"}</span>
      <span>RMS {energy.toFixed(3)}</span>
    </div>
  );
};

const ApiValueComposition = ({debug = false}: {debug?: boolean}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const seconds = frame / fps;
  const energy = useEnergy(frame);
  const activePhrase = activePhraseAt(seconds);
  const progress = interpolate(seconds, [0, CUES.audioEnd], [0, 1], clamp);
  const paperShift = interpolate(progress, [0, 1], [0, -18]);
  const transcript = useMemo(() => phrases.map(({text}) => text), []);

  return (
    <AbsoluteFill style={{background: COLORS.paper, color: COLORS.ink, fontFamily: '"Microsoft YaHei", "PingFang SC", Arial, sans-serif', overflow: "hidden"}}>
      <Audio src={staticFile("audio/openai-api-settings-tts.wav")} />

      <div style={{position: "absolute", inset: 0, transform: `translateX(${paperShift}px)`, backgroundImage: `linear-gradient(${COLORS.rule}66 1px, transparent 1px), linear-gradient(90deg, ${COLORS.rule}66 1px, transparent 1px)`, backgroundSize: "54px 54px", opacity: 0.38}} />
      <div style={{position: "absolute", left: 0, top: 0, bottom: 0, width: 18, background: COLORS.red}} />
      <div style={{position: "absolute", left: 70, top: 55, right: 70, display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: `2px solid ${COLORS.rule}`, paddingBottom: 18}}>
        <div style={{fontSize: 22, fontWeight: 760}}>API ECONOMICS / EXPLAINER</div>
        <div style={{fontFamily: "Georgia, serif", fontSize: 21, color: COLORS.muted}}>V = Q / C</div>
      </div>

      <MathStage seconds={seconds} />

      <div style={{position: "absolute", left: 70, right: 70, bottom: 42}}>
        <div style={{display: "flex", justifyContent: "center", gap: 12, fontSize: 29, fontWeight: 700}}>
          {transcript.map((text, index) => {
            const isActive = activePhrase === index;
            return (
              <span key={text} style={{padding: "8px 13px", color: isActive ? COLORS.ink : COLORS.muted, background: isActive ? `rgba(221,75,62,${0.11 + energy * 0.18})` : "transparent", borderBottom: `${isActive ? 3 + energy * 4 : 2}px solid ${isActive ? COLORS.red : "transparent"}`, transform: `translateY(${isActive ? -energy * 3 : 0}px)`}}>
                {text}
              </span>
            );
          })}
        </div>
        <div style={{height: 5, background: COLORS.rule, marginTop: 18, position: "relative"}}>
          <div style={{height: "100%", width: `${progress * 100}%`, background: COLORS.ink}} />
          <div style={{position: "absolute", left: `${progress * 100}%`, top: "50%", width: 14 + energy * 12, height: 14 + energy * 12, borderRadius: "50%", background: COLORS.red, transform: "translate(-50%, -50%)"}} />
        </div>
      </div>

      {debug ? <DebugOverlay frame={frame} seconds={seconds} energy={energy} /> : null}
    </AbsoluteFill>
  );
};

export const ApiValueMathMG = () => <ApiValueComposition />;
export const ApiValueMathMGDebug = () => <ApiValueComposition debug />;
