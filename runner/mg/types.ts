import type {MgLayerRole, MgRuntimeEpisodeInput, MgRuntimeLayer, MgRuntimeLayerPlacement} from "@story-claw/mg-templates/provider";

export type MgMode = "together" | "split";

export type LocatedMgTag = {
  /** Public HTML structural tag supplied by the template Provider. */
  tag: string;
  group: string;
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
  tag: string;
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

export type MgRenderBundle = MgRuntimeEpisodeInput & {
  version: 3;
};

export type MgPlan = {
  version: 3;
  source: MgVideoInfo & {
    rawVideo: string;
    sha256: string;
    html: string;
    timeline: string;
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
  functionCalls: Array<{
    id: string;
    name: string;
    instanceKey: string;
    htmlTag: string;
    group: string;
    order?: number;
    at: number;
    arguments: Record<string, unknown>;
    specFile: string;
  }>;
  scenes: Array<Omit<MgScenePlan, "render"> & {
    render: Omit<MgRuntimeLayer, "spec"> & {specFile: string};
  }>;
};
