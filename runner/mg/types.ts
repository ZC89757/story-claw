import type {
  CompositionNode,
  MgCompositionBundle,
  MgLayerRole,
  MgRuntimeLayer,
  MgRuntimeLayerPlacement,
} from "@story-claw/mg-templates/provider";

export type MgMode = "together" | "split";

/** Static directed-graph topology approved in the annotation HTML. */
export type DirectedGraphAnnotation = Readonly<{
  nodes: readonly string[];
  edges: readonly (readonly [number, number])[];
}>;

export type LocatedMgTag = {
  /** Public HTML structural tag supplied by the template Provider. */
  tag: string;
  group: string;
  order?: number;
  instanceKey: string;
  mode: MgMode;
  value?: number;
  values?: string[];
  graph?: DirectedGraphAnnotation;
  text: string;
  start: number;
  end: number;
  paragraphEnd: number;
  depth: number;
  parentInstance?: string;
  documentOrder: number;
};

export type MgInstanceInfo = {
  instanceKey: string;
  tag: string;
  group: string;
  order?: number;
  mode: MgMode;
  tags: LocatedMgTag[];
  paragraphEnd: number;
  depth: number;
  parentInstance?: string;
  graph?: DirectedGraphAnnotation;
};

export type RawMgFunctionCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type ResolvedMgFunctionCall = RawMgFunctionCall & {
  instanceKey: string;
  htmlTag: string;
  group: string;
  order?: number;
  at: number;
  elementAts: number[];
  layerRole: MgLayerRole;
  render: MgRuntimeLayer;
};

export type MgVideoInfo = {
  width: number;
  height: number;
  fps: number;
  duration: number;
  durationFrames: number;
};

export type MgScenePlan = MgRuntimeLayerPlacement & {
  start: number;
  end: number;
  specFile?: string;
};

export type MgRenderBundle = MgCompositionBundle & {
  version: 4;
};

export type VisualFunctionStatus =
  | "queued"
  | "preparing_reference"
  | "rendering_template"
  | "generating_video"
  | "normalizing"
  | "completed"
  | "failed";

export type VisualFunctionRecord = {
  id: string;
  taskId: string;
  /** Stable digest of the call arguments and resolved timeline window. */
  taskSignature: string;
  scopeKey: string;
  name: string;
  instanceKey: string;
  htmlTag: string;
  group: string;
  order?: number;
  arguments: Record<string, unknown>;
  status: VisualFunctionStatus;
  retries: number;
  start: number;
  end: number;
  duration: number;
  startFrame: number;
  endFrame: number;
  layerRole: MgLayerRole;
  activeWindows?: Array<{startFrame: number; endFrame: number}>;
  videoPath?: string;
  error?: string;
};

export type MgPlan = {
  version: 4;
  source: MgVideoInfo & {
    html: string;
    timeline: string;
    audio: string;
  };
  instances: Array<{
    instanceKey: string;
    group: string;
    tag: string;
    order?: number;
    mode: MgMode;
    tagCount: number;
    starts: number[];
  }>;
  functionCalls: VisualFunctionRecord[];
  nodes: CompositionNode[];
};

export type MgCompositionNode = CompositionNode;
