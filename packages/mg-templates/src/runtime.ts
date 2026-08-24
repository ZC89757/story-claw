export type MgTemplateName =
  | "progress-timeline"
  | "timed-table"
  | "directed-graph"
  | "title"
  | "emphasis"
  | "xy-chart"
  | "multi-series-chart"
  | "containment"
  | "decomposition"
  | "weighted-comparison"
  | "side-by-side-comparison"
  | "collage-network";

export type MgOverlayTemplateName = "title" | "emphasis";

export type MgRuntimeOverlay = {
  group: string;
  template: MgOverlayTemplateName;
  spec: unknown;
  fromFrame: number;
  durationFrames: number;
  timelineOffsetFrames: number;
};

export type MgRuntimeScene = {
  id: string;
  group: string;
  template: MgTemplateName | "raw-overlay";
  renderMode: "replace" | "overlay";
  durationFrames: number;
  timelineOffsetFrames: number;
  background: string;
  baseFile?: string;
  spec?: unknown;
  overlays: MgRuntimeOverlay[];
};

export type MgRenderInput = {
  width: number;
  height: number;
  fps: number;
  scene: MgRuntimeScene;
};
