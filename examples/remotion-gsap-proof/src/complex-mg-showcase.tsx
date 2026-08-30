import {gsap} from "gsap";
import {CSSProperties, ReactNode, useLayoutEffect, useRef} from "react";
import {
  AbsoluteFill,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

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
  mist: "#e9eef5",
};

const FPS = 30;
const clamp = {
  extrapolateLeft: "clamp" as const,
  extrapolateRight: "clamp" as const,
};

const useTimelineSeek = (
  rootRef: React.RefObject<HTMLDivElement>,
  buildTimeline: () => gsap.core.Timeline,
  startFrame: number,
) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const timelineRef = useRef<gsap.core.Timeline | null>(null);
  const buildTimelineRef = useRef(buildTimeline);
  buildTimelineRef.current = buildTimeline;

  useLayoutEffect(() => {
    const context = gsap.context(() => {
      timelineRef.current = buildTimelineRef.current();
    }, rootRef.current ?? undefined);

    return () => {
      timelineRef.current = null;
      context.revert();
    };
  }, [rootRef]);

  useLayoutEffect(() => {
    const localSeconds = Math.max(0, frame - startFrame) / fps;
    timelineRef.current?.seek(localSeconds, false);
  }, [fps, frame, startFrame]);
};

const Header = ({index, title, kicker}: {index: string; title: string; kicker: string}) => (
  <div style={{position: "absolute", left: 96, top: 76, zIndex: 4}}>
    <div
      style={{
        color: COLORS.coral,
        fontSize: 22,
        fontWeight: 800,
        letterSpacing: 1.5,
        textTransform: "uppercase",
      }}
    >
      {index} / {kicker}
    </div>
    <div style={{fontSize: 58, fontWeight: 900, marginTop: 14, color: COLORS.ink}}>
      {title}
    </div>
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
        .to(leftCard.current, {
          x: 0,
          rotation: 0,
          opacity: 1,
          duration: 0.95,
          ease: "power4.out",
        })
        .to(
          rightCard.current,
          {x: 0, rotation: 0, opacity: 1, duration: 0.95, ease: "power4.out"},
          0.12,
        )
        .to(badge.current, {y: 0, opacity: 1, duration: 0.48, ease: "back.out(1.7)"}, 0.88)
        .to(leftCard.current, {y: -14, duration: 0.46, yoyo: true, repeat: 1, ease: "sine.inOut"}, 1.45)
        .to(rightCard.current, {y: 14, duration: 0.46, yoyo: true, repeat: 1, ease: "sine.inOut"}, 1.52);
      return timeline;
    },
    startFrame,
  );

  const cardStyle: CSSProperties = {
    position: "absolute",
    top: 342,
    width: 490,
    height: 340,
    padding: 42,
    boxSizing: "border-box",
    borderRadius: 18,
    boxShadow: "0 34px 80px rgba(23, 33, 43, 0.18)",
  };

  return (
    <AbsoluteFill ref={rootRef} style={{backgroundColor: "#fffaf0", overflow: "hidden"}}>
      <Header index="01" kicker="Two inputs" title="Two cards meet in the center" />
      <div
        ref={leftCard}
        style={{
          ...cardStyle,
          left: 390,
          color: "#fff",
          backgroundColor: COLORS.navy,
        }}
      >
        <div style={{fontSize: 22, opacity: 0.75, letterSpacing: 1}}>SOURCE A</div>
        <div style={{fontSize: 46, fontWeight: 900, marginTop: 30}}>Customer signal</div>
        <div style={{fontSize: 26, lineHeight: 1.45, marginTop: 24, color: "#c8ddff"}}>
          Intent, profile, and recent activity
        </div>
        <div style={{position: "absolute", left: 42, right: 42, bottom: 38, height: 8, backgroundColor: COLORS.cyan}} />
      </div>
      <div
        ref={rightCard}
        style={{
          ...cardStyle,
          left: 1040,
          color: COLORS.ink,
          backgroundColor: COLORS.yellow,
        }}
      >
        <div style={{fontSize: 22, opacity: 0.65, letterSpacing: 1}}>SOURCE B</div>
        <div style={{fontSize: 46, fontWeight: 900, marginTop: 30}}>Business context</div>
        <div style={{fontSize: 26, lineHeight: 1.45, marginTop: 24, color: "#5e4a16"}}>
          Goals, constraints, and opportunity
        </div>
        <div style={{position: "absolute", left: 42, right: 42, bottom: 38, height: 8, backgroundColor: COLORS.coral}} />
      </div>
      <div
        ref={badge}
        style={{
          position: "absolute",
          left: 766,
          top: 746,
          width: 390,
          padding: "19px 0",
          borderRadius: 999,
          color: "#fff",
          backgroundColor: COLORS.green,
          fontWeight: 900,
          fontSize: 28,
          textAlign: "center",
          boxShadow: "0 14px 30px rgba(45, 166, 106, 0.3)",
        }}
      >
        One clear decision
      </div>
    </AbsoluteFill>
  );
};

const TableStage = ({startFrame}: {startFrame: number}) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const cells = useRef<Array<HTMLDivElement | null>>([]);
  const title = useRef<HTMLDivElement>(null);
  const summary = useRef<HTMLDivElement>(null);
  const values = [
    ["Q1", "62", "71", "84", "91"],
    ["Q2", "68", "76", "88", "94"],
    ["Q3", "73", "81", "90", "97"],
    ["Q4", "79", "86", "95", "102"],
    ["Q5", "85", "93", "101", "110"],
  ];

  useTimelineSeek(
    rootRef,
    () => {
      const timeline = gsap.timeline({paused: true});
      gsap.set(cells.current, {opacity: 0, scale: 0.78, y: 22});
      gsap.set([title.current, summary.current], {opacity: 0, y: 28});
      timeline
        .to(title.current, {opacity: 1, y: 0, duration: 0.45, ease: "power3.out"})
        .to(
          cells.current,
          {
            opacity: 1,
            scale: 1,
            y: 0,
            duration: 0.28,
            ease: "back.out(1.5)",
            stagger: {each: 0.06, grid: [5, 5], from: "start"},
          },
          0.2,
        )
        .to(summary.current, {opacity: 1, y: 0, duration: 0.5, ease: "back.out(1.4)"}, 1.95);
      return timeline;
    },
    startFrame,
  );

  return (
    <AbsoluteFill ref={rootRef} style={{backgroundColor: "#f4f8ff", overflow: "hidden"}}>
      <Header index="02" kicker="Progressive table" title="Cells render from top-left to bottom-right" />
      <div
        ref={title}
        style={{
          position: "absolute",
          left: 314,
          top: 270,
          padding: "18px 26px",
          borderRadius: 12,
          backgroundColor: COLORS.navy,
          color: "#fff",
          fontSize: 28,
          fontWeight: 800,
        }}
      >
        Growth signal by segment
      </div>
      <div
        style={{
          position: "absolute",
          left: 314,
          top: 355,
          display: "grid",
          gridTemplateColumns: "repeat(5, 208px)",
          gap: 10,
        }}
      >
        {values.flatMap((row, rowIndex) =>
          row.map((value, columnIndex) => {
            const isHeader = rowIndex === 0 || columnIndex === 0;
            const isPeak = rowIndex >= 3 && columnIndex >= 3;
            const position = rowIndex * 5 + columnIndex;
            return (
              <div
                key={`${rowIndex}-${columnIndex}`}
                ref={(element) => {
                  cells.current[position] = element;
                }}
                style={{
                  height: 94,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: 10,
                  color: isHeader ? "#fff" : COLORS.ink,
                  backgroundColor: isHeader ? COLORS.navy : isPeak ? "#d7f5dc" : "#fff",
                  border: `1px solid ${isHeader ? COLORS.navy : "#d9e2ef"}`,
                  fontSize: isHeader ? 27 : 34,
                  fontWeight: isHeader ? 800 : 900,
                  boxShadow: isHeader ? "none" : "0 8px 20px rgba(23, 58, 94, 0.07)",
                }}
              >
                {value}
              </div>
            );
          }),
        )}
      </div>
      <div
        ref={summary}
        style={{
          position: "absolute",
          left: 1064,
          top: 845,
          width: 330,
          padding: "18px 24px",
          borderLeft: `8px solid ${COLORS.green}`,
          backgroundColor: "#fff",
          color: COLORS.ink,
          fontSize: 25,
          fontWeight: 800,
          boxShadow: "0 14px 32px rgba(23, 58, 94, 0.1)",
        }}
      >
        Best segment: +110
      </div>
    </AbsoluteFill>
  );
};

const chartPaths = [
  {d: "M 0 440 C 130 410, 170 330, 300 342 S 460 245, 590 270 S 760 135, 940 150", color: COLORS.blue},
  {d: "M 0 470 C 125 444, 208 420, 300 392 S 486 345, 585 305 S 775 266, 940 218", color: COLORS.green},
  {d: "M 0 510 C 118 450, 208 484, 310 430 S 475 448, 580 392 S 750 366, 940 300", color: COLORS.coral},
  {d: "M 0 536 C 116 515, 190 475, 296 486 S 463 420, 585 438 S 750 387, 940 360", color: COLORS.lavender},
];

const ChartStage = ({startFrame}: {startFrame: number}) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const axes = useRef<HTMLDivElement>(null);
  const paths = useRef<Array<SVGPathElement | null>>([]);
  const legend = useRef<Array<HTMLDivElement | null>>([]);

  useTimelineSeek(
    rootRef,
    () => {
      const timeline = gsap.timeline({paused: true});
      gsap.set(axes.current, {opacity: 0, y: 24});
      gsap.set(paths.current, {strokeDashoffset: 1, opacity: 0});
      gsap.set(legend.current, {opacity: 0, x: 22});
      timeline
        .to(axes.current, {opacity: 1, y: 0, duration: 0.45, ease: "power2.out"})
        .to(paths.current, {strokeDashoffset: 0, opacity: 1, duration: 1.35, stagger: 0.28, ease: "power2.inOut"}, 0.2)
        .to(legend.current, {opacity: 1, x: 0, duration: 0.36, stagger: 0.12, ease: "power3.out"}, 0.92);
      return timeline;
    },
    startFrame,
  );

  return (
    <AbsoluteFill ref={rootRef} style={{backgroundColor: "#fbf8ff", overflow: "hidden"}}>
      <Header index="03" kicker="Four trajectories" title="Lines extend slowly across the chart" />
      <div ref={axes} style={{position: "absolute", left: 358, top: 290, width: 1010, height: 600}}>
        <div style={{position: "absolute", left: 0, right: 0, bottom: 0, height: 4, backgroundColor: COLORS.ink}} />
        <div style={{position: "absolute", left: 0, top: 0, bottom: 0, width: 4, backgroundColor: COLORS.ink}} />
        {[1, 2, 3, 4].map((index) => (
          <div
            key={index}
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: index * 116,
              borderTop: "2px dashed #dce3ed",
            }}
          />
        ))}
        <svg viewBox="0 0 940 560" style={{position: "absolute", left: 34, top: 0, width: 940, height: 560, overflow: "visible"}}>
          {chartPaths.map((path, index) => (
            <path
              key={path.color}
              ref={(element) => {
                paths.current[index] = element;
              }}
              d={path.d}
              pathLength={1}
              fill="none"
              stroke={path.color}
              strokeWidth={10}
              strokeLinecap="round"
              strokeDasharray={1}
              strokeDashoffset={1}
            />
          ))}
        </svg>
        <div style={{position: "absolute", left: -105, top: 250, fontSize: 23, color: "#6e7786", transform: "rotate(-90deg)"}}>Momentum</div>
        <div style={{position: "absolute", right: -28, bottom: -62, fontSize: 23, color: "#6e7786"}}>Weeks</div>
      </div>
      <div style={{position: "absolute", left: 1430, top: 370, width: 330}}>
        {chartPaths.map((item, index) => (
          <div
            key={item.color}
            ref={(element) => {
              legend.current[index] = element;
            }}
            style={{display: "flex", alignItems: "center", gap: 18, marginBottom: 28, fontSize: 28, color: COLORS.ink, fontWeight: 800}}
          >
            <span style={{width: 48, height: 10, borderRadius: 8, backgroundColor: item.color}} />
            {`Track ${String.fromCharCode(65 + index)}`}
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
};

type FlowNode = {label: string; detail: string; x: number; y: number; color: string};

const flowNodes: FlowNode[] = [
  {label: "Intake", detail: "request", x: 170, y: 460, color: COLORS.navy},
  {label: "Context", detail: "normalize", x: 470, y: 460, color: COLORS.blue},
  {label: "Risk", detail: "score", x: 790, y: 260, color: COLORS.coral},
  {label: "Enrich", detail: "signals", x: 790, y: 650, color: COLORS.cyan},
  {label: "Decision", detail: "combine", x: 1120, y: 460, color: COLORS.lavender},
  {label: "Approve", detail: "fast lane", x: 1480, y: 250, color: COLORS.green},
  {label: "Review", detail: "human loop", x: 1480, y: 650, color: COLORS.yellow},
];

const flowPaths = [
  "M 390 510 L 470 510",
  "M 690 510 C 740 510, 730 310, 790 310",
  "M 690 510 C 740 510, 730 700, 790 700",
  "M 1010 310 C 1070 310, 1050 510, 1120 510",
  "M 1010 700 C 1070 700, 1050 510, 1120 510",
  "M 1340 510 C 1410 510, 1402 300, 1480 300",
  "M 1340 510 C 1410 510, 1402 700, 1480 700",
];

const FlowStage = ({startFrame}: {startFrame: number}) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const nodes = useRef<Array<HTMLDivElement | null>>([]);
  const paths = useRef<Array<SVGPathElement | null>>([]);
  const callout = useRef<HTMLDivElement>(null);

  useTimelineSeek(
    rootRef,
    () => {
      const timeline = gsap.timeline({paused: true});
      gsap.set(nodes.current, {opacity: 0, scale: 0.72, y: 24});
      gsap.set(paths.current, {opacity: 0, strokeDashoffset: 1});
      gsap.set(callout.current, {opacity: 0, y: 20});
      timeline
        .to(nodes.current[0], {opacity: 1, scale: 1, y: 0, duration: 0.42, ease: "back.out(1.8)"}, 0.1)
        .to(paths.current[0], {opacity: 1, strokeDashoffset: 0, duration: 0.36, ease: "power2.inOut"}, 0.46)
        .to(nodes.current[1], {opacity: 1, scale: 1, y: 0, duration: 0.42, ease: "back.out(1.8)"}, 0.72)
        .to(paths.current.slice(1, 3), {opacity: 1, strokeDashoffset: 0, duration: 0.42, stagger: 0.14, ease: "power2.inOut"}, 1.05)
        .to(nodes.current.slice(2, 4), {opacity: 1, scale: 1, y: 0, duration: 0.4, stagger: 0.14, ease: "back.out(1.8)"}, 1.32)
        .to(paths.current.slice(3, 5), {opacity: 1, strokeDashoffset: 0, duration: 0.42, stagger: 0.14, ease: "power2.inOut"}, 1.72)
        .to(nodes.current[4], {opacity: 1, scale: 1, y: 0, duration: 0.42, ease: "back.out(1.8)"}, 2.04)
        .to(paths.current.slice(5), {opacity: 1, strokeDashoffset: 0, duration: 0.42, stagger: 0.14, ease: "power2.inOut"}, 2.38)
        .to(nodes.current.slice(5), {opacity: 1, scale: 1, y: 0, duration: 0.42, stagger: 0.16, ease: "back.out(1.8)"}, 2.67)
        .to(callout.current, {opacity: 1, y: 0, duration: 0.42, ease: "power3.out"}, 3.22);
      return timeline;
    },
    startFrame,
  );

  return (
    <AbsoluteFill ref={rootRef} style={{backgroundColor: "#f8fbf8", overflow: "hidden"}}>
      <Header index="04" kicker="Decision orchestration" title="A process map builds its route, node by node" />
      <svg viewBox="0 0 1920 1080" style={{position: "absolute", inset: 0, overflow: "visible"}}>
        <defs>
          <marker id="flow-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="10" markerHeight="10" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill={COLORS.ink} />
          </marker>
        </defs>
        {flowPaths.map((path, index) => (
          <path
            key={path}
            ref={(element) => {
              paths.current[index] = element;
            }}
            d={path}
            pathLength={1}
            fill="none"
            stroke={COLORS.ink}
            strokeWidth={7}
            strokeLinecap="round"
            strokeDasharray={1}
            strokeDashoffset={1}
            markerEnd="url(#flow-arrow)"
          />
        ))}
      </svg>
      {flowNodes.map((node, index) => (
        <div
          key={node.label}
          ref={(element) => {
            nodes.current[index] = element;
          }}
          style={{
            position: "absolute",
            left: node.x,
            top: node.y,
            width: 220,
            height: 100,
            padding: "20px 24px",
            boxSizing: "border-box",
            borderRadius: 14,
            color: COLORS.ink,
            backgroundColor: "#fff",
            border: `4px solid ${node.color}`,
            boxShadow: "0 16px 36px rgba(23, 33, 43, 0.12)",
          }}
        >
          <div style={{fontSize: 27, fontWeight: 900}}>{node.label}</div>
          <div style={{fontSize: 19, color: "#67737e", marginTop: 5}}>{node.detail}</div>
        </div>
      ))}
      <div
        ref={callout}
        style={{
          position: "absolute",
          left: 715,
          top: 882,
          padding: "17px 28px",
          borderRadius: 999,
          color: "#fff",
          backgroundColor: COLORS.ink,
          fontSize: 25,
          fontWeight: 800,
        }}
      >
        Parallel checks, one downstream decision
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
    <div
      style={{
        position: "absolute",
        left,
        top,
        width: 1920,
        height: 1080,
        opacity: appear,
        transform: `scale(${scale})`,
        transformOrigin: "top left",
        overflow: "hidden",
        borderRadius: shrink > 0.01 ? 18 : 0,
        boxShadow: shrink > 0.01 ? "0 12px 28px rgba(23, 33, 43, 0.16)" : "none",
        zIndex: shrink < 1 ? 20 + zIndex : zIndex,
      }}
    >
      {children}
      {shrink > 0.01 ? (
        <div
          style={{
            position: "absolute",
            left: 48,
            bottom: 42,
            padding: "11px 18px",
            borderRadius: 999,
            color: "#fff",
            backgroundColor: "rgba(23, 33, 43, 0.82)",
            fontSize: 24,
            fontWeight: 800,
          }}
        >
          {label}
        </div>
      ) : null}
    </div>
  );
};

export const COMPLEX_MG_DURATION_IN_FRAMES = 840;

export const ComplexMotionShowcase = () => {
  const frame = useCurrentFrame();
  const finalReveal = interpolate(frame, [795, 830], [0, 1], clamp);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: COLORS.paper,
        color: COLORS.ink,
        fontFamily: 'Inter, "Microsoft YaHei", Arial, sans-serif',
        overflow: "hidden",
      }}
    >
      <StageShell start={0} shrinkStart={120} miniX={58} miniY={74} label="01 Cards" zIndex={1}>
        <CardStage startFrame={0} />
      </StageShell>
      <StageShell start={150} shrinkStart={270} miniX={468} miniY={74} label="02 Table" zIndex={2}>
        <TableStage startFrame={150} />
      </StageShell>
      <StageShell start={300} shrinkStart={435} miniX={58} miniY={308} label="03 Chart" zIndex={3}>
        <ChartStage startFrame={300} />
      </StageShell>
      <StageShell start={465} shrinkStart={720} miniX={468} miniY={308} label="04 Flow" zIndex={4}>
        <FlowStage startFrame={465} />
      </StageShell>
      <div
        style={{
          position: "absolute",
          left: 88,
          top: 605,
          width: 760,
          opacity: finalReveal,
          transform: `translateY(${interpolate(finalReveal, [0, 1], [28, 0])}px)`,
          zIndex: 10,
        }}
      >
        <div style={{fontSize: 22, letterSpacing: 2, fontWeight: 800, color: COLORS.coral}}>REMOTION + GSAP</div>
        <div style={{fontSize: 45, lineHeight: 1.08, fontWeight: 900, marginTop: 12}}>One frame clock.<br />Four local timelines.</div>
        <div style={{fontSize: 23, color: "#68737b", marginTop: 18, lineHeight: 1.45}}>Each scene is independently choreographed, then precisely archived into the final layout.</div>
      </div>
    </AbsoluteFill>
  );
};
