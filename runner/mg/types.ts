import type {MgRuntimeScene, MgTemplateName} from "@story-claw/mg-templates";

export type MgMode = "together" | "split";

export type LocatedMgTag = {
  tag: MgTemplateName;
  group: string;
  mode: MgMode;
  value: number;
  text: string;
  start: number;
  end: number;
  paragraphEnd: number;
  depth: number;
  parentGroup?: string;
  documentOrder: number;
};

export type MgGroupInfo = {
  tag: MgTemplateName;
  group: string;
  mode: MgMode;
  tags: LocatedMgTag[];
  paragraphEnd: number;
  depth: number;
  parentGroup?: string;
};

export type RawMgFunctionCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type ResolvedMgFunctionCall = RawMgFunctionCall & {
  group: string;
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
  version: 1;
  width: number;
  height: number;
  fps: number;
  scenes: MgScenePlan[];
};

export type MgPlan = {
  version: 1;
  source: MgVideoInfo & {
    rawVideo: string;
    sha256: string;
    html: string;
    timeline: string;
  };
  groups: Array<{
    group: string;
    tag: MgTemplateName;
    mode: MgMode;
    tagCount: number;
    starts: number[];
  }>;
  functionCalls: Array<{
    id: string;
    name: string;
    group: string;
    at: number;
    arguments: Record<string, unknown>;
    specFile: string;
  }>;
  scenes: Array<Omit<MgScenePlan, "spec" | "overlays"> & {
    overlays: Array<Omit<MgScenePlan["overlays"][number], "spec"> & {specFile: string}>;
  }>;
};
