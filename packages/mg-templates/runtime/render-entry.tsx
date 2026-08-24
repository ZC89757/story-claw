import type {ReactNode} from "react";
import {
  AbsoluteFill,
  Composition,
  getInputProps,
  OffthreadVideo,
  registerRoot,
  Sequence,
  staticFile,
  useVideoConfig,
} from "remotion";
import {ProgressTimelineTemplate} from "../src/progress-timeline";
import {TimedTableTemplate} from "../src/timed-table";
import {DirectedGraphTemplate} from "../src/directed-graph";
import {FadeTitleTemplate} from "../src/title";
import {EmphasisTextTemplate} from "../src/emphasis";
import {XYChartTemplate} from "../src/xy-chart";
import {MultiSeriesChartTemplate} from "../src/multi-series-chart";
import {ContainmentTemplate} from "../src/containment";
import {DecompositionTemplate} from "../src/decomposition";
import {BalanceComparisonTemplate, SideBySideComparisonTemplate} from "../src/weighted-comparison";
import {CollageNetworkTemplate} from "../src/collage-network";
import type {
  MgOverlayTemplateName,
  MgRenderInput,
  MgRuntimeOverlay,
  MgRuntimeScene,
} from "../src/runtime";

const ScaledCanvas = ({children, full = false}: {children: ReactNode; full?: boolean}) => {
  const {width, height} = useVideoConfig();
  const fit = Math.min(width / 1920, height / 1080);
  const scale = fit * (full ? 1 : width >= height ? 0.86 : 0.96);
  return <div style={{
    position: "absolute",
    left: (width - 1920 * scale) / 2,
    top: (height - 1080 * scale) / 2,
    width: 1920,
    height: 1080,
    transform: `scale(${scale})`,
    transformOrigin: "top left",
  }}>{children}</div>;
};

const MainTemplate = ({scene}: {scene: MgRuntimeScene}) => {
  const spec = scene.spec as never;
  switch (scene.template) {
    case "progress-timeline": return <ProgressTimelineTemplate spec={spec} />;
    case "timed-table": return <TimedTableTemplate spec={spec} />;
    case "directed-graph": return <DirectedGraphTemplate spec={spec} />;
    case "xy-chart": return <XYChartTemplate spec={spec} />;
    case "multi-series-chart": return <MultiSeriesChartTemplate spec={spec} />;
    case "containment": return <ContainmentTemplate spec={spec} />;
    case "decomposition": return <DecompositionTemplate spec={spec} />;
    case "weighted-comparison": return <BalanceComparisonTemplate spec={spec} />;
    case "side-by-side-comparison": return <SideBySideComparisonTemplate spec={spec} />;
    case "collage-network": return <CollageNetworkTemplate spec={spec} />;
    default: throw new Error(`Unsupported replacement template: ${scene.template}`);
  }
};

const OverlayTemplate = ({template, spec}: {template: MgOverlayTemplateName; spec: unknown}) => {
  if (template === "title") return <FadeTitleTemplate spec={spec as never} />;
  return <EmphasisTextTemplate spec={spec as never} />;
};

const Overlay = ({overlay}: {overlay: MgRuntimeOverlay}) => <Sequence
  from={overlay.fromFrame}
  durationInFrames={overlay.durationFrames}
  premountFor={Math.min(15, overlay.fromFrame)}
>
  <AbsoluteFill style={{background: "rgba(8, 12, 14, 0.28)"}}>
    <ScaledCanvas full>
      <Sequence from={-overlay.timelineOffsetFrames} layout="none">
        <OverlayTemplate template={overlay.template} spec={overlay.spec} />
      </Sequence>
    </ScaledCanvas>
  </AbsoluteFill>
</Sequence>;

const GeneratedScene = ({scene}: {scene: MgRuntimeScene}) => {
  if (scene.renderMode === "overlay") {
    if (!scene.baseFile) throw new Error(`Overlay scene ${scene.id} is missing baseFile`);
    return <AbsoluteFill style={{background: "#111"}}>
      <OffthreadVideo
        src={staticFile(scene.baseFile)}
        muted
        style={{width: "100%", height: "100%", objectFit: "cover"}}
      />
      {scene.overlays.map((overlay) => <Overlay key={`${overlay.group}-${overlay.fromFrame}`} overlay={overlay} />)}
    </AbsoluteFill>;
  }

  return <AbsoluteFill style={{background: scene.background, overflow: "hidden"}}>
    <ScaledCanvas>
      <Sequence from={-scene.timelineOffsetFrames} layout="none">
        <MainTemplate scene={scene} />
      </Sequence>
    </ScaledCanvas>
    {scene.overlays.map((overlay) => <Overlay key={`${overlay.group}-${overlay.fromFrame}`} overlay={overlay} />)}
  </AbsoluteFill>;
};

const Root = () => {
  const supplied = getInputProps() as Partial<MgRenderInput>;
  const scene = supplied.scene ?? {
    id: "preview",
    group: "preview",
    template: "raw-overlay",
    renderMode: "overlay",
    durationFrames: 1,
    timelineOffsetFrames: 0,
    background: "#111",
    baseFile: "preview.mp4",
    overlays: [],
  } satisfies MgRuntimeScene;
  const input: MgRenderInput = {
    width: supplied.width ?? 1280,
    height: supplied.height ?? 720,
    fps: supplied.fps ?? 25,
    scene,
  };

  return <Composition
    id="StoryClawMgScene"
    component={GeneratedScene}
    defaultProps={{scene: input.scene}}
    width={input.width}
    height={input.height}
    fps={input.fps}
    durationInFrames={Math.max(1, input.scene.durationFrames)}
  />;
};

registerRoot(Root);
