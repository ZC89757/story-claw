import type {MgRuntimeScene, MgTemplateName} from "@story-claw/mg-templates";

export type MgMode = "together" | "split";

export type LocatedMgTag = {
  tag: MgTemplateName;
  /** Renderer style selected for this structural tag. */
  group: string;
  /** Repeated instance number for this tag type; omitted when the type is used once. */
  order?: number;
  instanceKey: string;
  mode: MgMode;
  value: number;
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
  tag: MgTemplateName;
  group: string;
  order?: number;
  mode: MgMode;
  tags: LocatedMgTag[];
  paragraphEnd: number;
  depth: number;
  parentInstance?: string;
};

export type RawMgFunctionCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type ResolvedMgFunctionCall = RawMgFunctionCall & {
  instanceKey: string;
  group: string;
  order?: number;
  at: number;
  template: MgTemplateName;
  spec: unknown;
};

export type MgVideoInfo = {
  width: number;
  height: number;
  fps: number;
  duration: number;
  durationFrames: number;
};

export type MgScenePlan = MgRuntimeScene & {
  start: number;
  end: number;
  startFrame: number;
  endFrame: number;
  sourceText: string;
  specFile?: string;
  clipFile: string;
};

export type MgRenderBundle = {
  version: 2;
  width: number;
  height: number;
  fps: number;
  scenes: MgScenePlan[];
};

export type MgPlan = {
  version: 2;
  source: MgVideoInfo & {
    rawVideo: string;
    sha256: string;
    html: string;
    timeline: string;
  };
  instances: Array<{
    instanceKey: string;
    group: string;
    tag: MgTemplateName;
    order?: number;
    mode: MgMode;
    tagCount: number;
    starts: number[];
  }>;
  functionCalls: Array<{
    id: string;
    name: string;
    instanceKey: string;
    group: string;
    order?: number;
    at: number;
    arguments: Record<string, unknown>;
    specFile: string;
  }>;
  scenes: Array<Omit<MgScenePlan, "spec" | "overlays"> & {
    overlays: Array<Omit<MgScenePlan["overlays"][number], "spec"> & {specFile: string}>;
  }>;
};
