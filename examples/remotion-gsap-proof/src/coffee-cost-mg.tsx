import {gsap} from "gsap";
import {
  CSSProperties,
  useLayoutEffect,
  useRef,
} from "react";
import {
  AbsoluteFill,
  Easing,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

const COLORS = {
  ink: "#181816",
  paper: "#f4f0e7",
  muted: "#77736b",
  green: "#16836c",
  blue: "#2f6fe4",
  coral: "#e85e4d",
  yellow: "#f3be3e",
};

const GSAP_START_FRAME = 27;

const costItems = [
  {
    label: "咖啡豆与杯子",
    detail: "原料成本",
    amount: 3.6,
    share: 12,
    color: COLORS.green,
  },
  {
    label: "门店与人工",
    detail: "日常运营",
    amount: 13.5,
    share: 45,
    color: COLORS.blue,
  },
  {
    label: "租金、营销与利润",
    detail: "品牌溢价",
    amount: 12.9,
    share: 43,
    color: COLORS.coral,
  },
] as const;

const clamp = {
  extrapolateLeft: "clamp" as const,
  extrapolateRight: "clamp" as const,
};

const cardPositions: CSSProperties[] = [
  {top: 8, right: 0},
  {top: 202, right: 0},
  {top: 396, right: 0},
];

const connectorPaths = [
  "M 630 304 C 760 304, 760 88, 950 88",
  "M 630 304 C 770 304, 790 282, 950 282",
  "M 630 304 C 760 304, 760 476, 950 476",
];

type AnimationEngine = "remotion" | "gsap";

const PriceBreakdown = ({engine}: {engine: AnimationEngine}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const rootRef = useRef<HTMLDivElement>(null);
  const centerRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<Array<HTMLDivElement | null>>([]);
  const lineRefs = useRef<Array<SVGPathElement | null>>([]);
  const barRefs = useRef<Array<HTMLDivElement | null>>([]);
  const amountRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const timelineRef = useRef<gsap.core.Timeline | null>(null);
  const localFrame = Math.max(0, frame - GSAP_START_FRAME);

  const centerProgress = spring({
    frame: localFrame,
    fps,
    durationInFrames: 16,
    config: {damping: 13, stiffness: 170},
  });
  const lineProgresses = costItems.map((_, index) =>
    interpolate(localFrame, [8 + index * 3, 27 + index * 3], [0, 1], {
      ...clamp,
      easing: Easing.out(Easing.cubic),
    }),
  );
  const cardProgresses = costItems.map((_, index) =>
    spring({
      frame: Math.max(0, localFrame - (16 + index * 4)),
      fps,
      durationInFrames: 16,
      config: {damping: 14, stiffness: 185},
    }),
  );
  const barProgresses = costItems.map((_, index) =>
    interpolate(localFrame, [25 + index * 3, 47 + index * 3], [0, 1], {
      ...clamp,
      easing: Easing.out(Easing.cubic),
    }),
  );
  const amountProgresses = costItems.map((_, index) =>
    interpolate(localFrame, [23 + index * 4, 46 + index * 4], [0, 1], {
      ...clamp,
      easing: Easing.out(Easing.quad),
    }),
  );
  const isRemotion = engine === "remotion";

  useLayoutEffect(() => {
    if (engine !== "gsap") {
      return;
    }

    const counters = costItems.map(() => ({value: 0}));
    const context = gsap.context(() => {
      const timeline = gsap.timeline({paused: true});

      timeline
        .to(
          centerRef.current,
          {
            opacity: 1,
            scale: 1,
            duration: 0.52,
            ease: "back.out(1.7)",
          },
          0,
        )
        .to(
          lineRefs.current,
          {
            opacity: 1,
            strokeDashoffset: 0,
            duration: 0.62,
            stagger: 0.1,
            ease: "power2.out",
          },
          0.28,
        )
        .to(
          cardRefs.current,
          {
            opacity: 1,
            y: 0,
            scale: 1,
            duration: 0.5,
            stagger: 0.12,
            ease: "back.out(1.35)",
          },
          0.54,
        )
        .to(
          barRefs.current,
          {
            scaleX: 1,
            duration: 0.72,
            stagger: 0.1,
            ease: "power3.out",
          },
          0.82,
        );

      counters.forEach((counter, index) => {
        timeline.to(
          counter,
          {
            value: costItems[index].amount,
            duration: 0.75,
            ease: "power2.out",
            onUpdate: () => {
              const element = amountRefs.current[index];
              if (element) {
                element.textContent = `¥${counter.value.toFixed(1)}`;
              }
            },
          },
          0.78 + index * 0.12,
        );
      });

      timelineRef.current = timeline;
    }, rootRef);

    return () => {
      timelineRef.current = null;
      context.revert();
    };
  }, [engine]);

  useLayoutEffect(() => {
    if (engine !== "gsap") {
      return;
    }

    const localSeconds = Math.max(0, frame - GSAP_START_FRAME) / fps;
    timelineRef.current?.seek(localSeconds, false);
  }, [engine, fps, frame]);

  return (
    <div
      ref={rootRef}
      style={{
        position: "relative",
        width: 1660,
        height: 570,
      }}
    >
      <svg
        viewBox="0 0 1660 570"
        style={{position: "absolute", inset: 0, overflow: "visible"}}
      >
        {connectorPaths.map((path, index) => (
          <path
            key={path}
            ref={(element) => {
              lineRefs.current[index] = element;
            }}
            d={path}
            pathLength={1}
            fill="none"
            stroke={costItems[index].color}
            strokeWidth={5}
            strokeLinecap="round"
            strokeDasharray={1}
            strokeDashoffset={isRemotion ? 1 - lineProgresses[index] : 1}
            opacity={isRemotion ? lineProgresses[index] : 0}
          />
        ))}
      </svg>

      <div
        ref={centerRef}
        style={{
          position: "absolute",
          left: 286,
          top: 121,
          width: 344,
          height: 344,
          borderRadius: "50%",
          backgroundColor: COLORS.ink,
          color: "#fff",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          opacity: isRemotion ? Math.min(1, centerProgress) : 0,
          transform: `scale(${isRemotion ? 0.62 + centerProgress * 0.38 : 0.62})`,
          boxShadow: "0 30px 80px rgba(24, 24, 22, 0.18)",
        }}
      >
        <span style={{fontSize: 30, color: "#cbc7bd"}}>一杯售价</span>
        <strong style={{fontSize: 112, lineHeight: 1, marginTop: 12}}>¥30</strong>
        <span
          style={{
            marginTop: 24,
            padding: "9px 18px",
            border: "1px solid rgba(255,255,255,0.22)",
            borderRadius: 4,
            fontSize: 24,
          }}
        >
          100%
        </span>
      </div>

      {costItems.map((item, index) => (
        <div
          key={item.label}
          ref={(element) => {
            cardRefs.current[index] = element;
          }}
          style={{
            position: "absolute",
            ...cardPositions[index],
            width: 710,
            height: 170,
            padding: "26px 34px",
            boxSizing: "border-box",
            backgroundColor: "rgba(255, 255, 255, 0.84)",
            border: "1px solid rgba(24, 24, 22, 0.12)",
            borderLeft: `10px solid ${item.color}`,
            borderRadius: 6,
            opacity: isRemotion ? Math.min(1, cardProgresses[index]) : 0,
            transform: isRemotion
              ? `translateY(${38 * (1 - cardProgresses[index])}px) scale(${0.94 + cardProgresses[index] * 0.06})`
              : "translateY(38px) scale(0.94)",
            boxShadow: "0 18px 48px rgba(24, 24, 22, 0.08)",
          }}
        >
          <div style={{display: "flex", justifyContent: "space-between"}}>
            <div>
              <div style={{fontSize: 34, fontWeight: 800, color: COLORS.ink}}>
                {item.label}
              </div>
              <div style={{fontSize: 23, marginTop: 5, color: COLORS.muted}}>
                {item.detail}
              </div>
            </div>
            <div style={{textAlign: "right"}}>
              <span
                ref={(element) => {
                  amountRefs.current[index] = element;
                }}
                style={{fontSize: 40, fontWeight: 850, color: item.color}}
              >
                {isRemotion
                  ? `¥${(item.amount * amountProgresses[index]).toFixed(1)}`
                  : "¥0.0"}
              </span>
              <div style={{fontSize: 23, color: COLORS.muted}}>{item.share}%</div>
            </div>
          </div>
          <div
            style={{
              position: "absolute",
              left: 34,
              right: 34,
              bottom: 20,
              height: 10,
              backgroundColor: "#e8e3d9",
              borderRadius: 2,
              overflow: "hidden",
            }}
          >
            <div
              ref={(element) => {
                barRefs.current[index] = element;
              }}
              style={{
                width: `${item.share}%`,
                height: "100%",
                backgroundColor: item.color,
                transform: `scaleX(${isRemotion ? barProgresses[index] : 0})`,
                transformOrigin: "left center",
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
};

export const CoffeeCostMG = ({engine}: {engine: AnimationEngine}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const titleProgress = spring({
    frame,
    fps,
    durationInFrames: 22,
    config: {damping: 18, stiffness: 150},
  });
  const titleY = interpolate(titleProgress, [0, 1], [58, 0]);

  const cameraScale = interpolate(frame, [122, 179], [1, 1.035], {
    ...clamp,
    easing: Easing.inOut(Easing.cubic),
  });
  const cameraX = interpolate(frame, [122, 179], [0, -18], clamp);

  const conclusionProgress = spring({
    frame: frame - 122,
    fps,
    durationInFrames: 24,
    config: {damping: 16, stiffness: 170},
  });
  const conclusionY = interpolate(conclusionProgress, [0, 1], [48, 0]);

  const timelineProgress = interpolate(frame, [0, 179], [0, 1], clamp);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: COLORS.paper,
        color: COLORS.ink,
        fontFamily: '"Microsoft YaHei", "Noto Sans SC", Arial, sans-serif',
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 92,
          right: 92,
          top: 66,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          opacity: titleProgress,
          transform: `translateY(${titleY}px)`,
        }}
      >
        <div>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 14,
              color: COLORS.coral,
              fontSize: 24,
              fontWeight: 800,
            }}
          >
            <span
              style={{
                width: 42,
                height: 8,
                backgroundColor: COLORS.coral,
                display: "inline-block",
              }}
            />
            价格拆解
          </div>
          <h1
            style={{
              fontSize: 68,
              lineHeight: 1.1,
              margin: "15px 0 0",
              letterSpacing: 0,
              fontWeight: 900,
            }}
          >
            30 元咖啡，钱去哪了？
          </h1>
        </div>
        <div
          style={{
            marginTop: 23,
            fontSize: 24,
            color: COLORS.muted,
            borderBottom: `4px solid ${COLORS.yellow}`,
            paddingBottom: 7,
          }}
        >
          {engine === "remotion" ? "Remotion 原生" : "GSAP seek()"}
        </div>
      </div>

      <div
        style={{
          position: "absolute",
          left: 108,
          top: 368,
          transform: `translateX(${cameraX}px) scale(${cameraScale})`,
          transformOrigin: "center center",
        }}
      >
        <PriceBreakdown engine={engine} />
      </div>

      <div
        style={{
          position: "absolute",
          left: 130,
          bottom: 92,
          width: 610,
          padding: "25px 32px 27px",
          boxSizing: "border-box",
          backgroundColor: COLORS.yellow,
          border: `3px solid ${COLORS.ink}`,
          borderRadius: 5,
          boxShadow: `12px 12px 0 ${COLORS.ink}`,
          opacity: conclusionProgress,
          transform: `translateY(${conclusionY}px)`,
        }}
      >
        <div style={{fontSize: 25, fontWeight: 700}}>真正进入杯子的原料</div>
        <div style={{fontSize: 49, marginTop: 5, fontWeight: 900}}>
          只占售价的 12%
        </div>
      </div>

      <div
        style={{
          position: "absolute",
          left: 0,
          bottom: 0,
          width: `${timelineProgress * 100}%`,
          height: 10,
          backgroundColor: COLORS.coral,
        }}
      />
    </AbsoluteFill>
  );
};

export const CoffeeCostRemotion = () => <CoffeeCostMG engine="remotion" />;

export const CoffeeCostGsap = () => <CoffeeCostMG engine="gsap" />;
