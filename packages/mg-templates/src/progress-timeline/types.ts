export type ProgressMotion = "ease" | "instant";
export type ProgressNodeKind = "major" | "minor";

export type ProgressDetail =
  | {type: "text"; value: string}
  | {type: "image"; src: string; caption: string}
  | {type: "video"; src: string; caption: string};

export type ProgressTimelineNode = {
  id: string;
  /** Scene-local second at which movement toward this node begins. */
  at: number;
  progress: number;
  kind: ProgressNodeKind;
  title: string;
  eyebrow: string;
  detail: ProgressDetail;
  motion: ProgressMotion;
};

export type ProgressTimelineSpec = {
  title: string;
  subtitle: string;
  followViewport: boolean;
  nodes: ProgressTimelineNode[];
};

export type ProgressTimelineState = {
  progress: number;
  activeIndex: number;
};
