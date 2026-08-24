export type CollageNetworkNodeKind = "model" | "cloud" | "chip";
export type CollageNetworkEdgeType = "investment" | "cloud" | "supply" | "competition";

export type CollageNetworkNode = {
  id: string;
  label: string;
  at: number;
  /** Filled by an asset resolver after Function Calling; absent uses a text monogram. */
  assetSrc?: string;
  role: string;
  kind: CollageNetworkNodeKind;
};

export type CollageNetworkEdge = {
  at: number;
  from: string;
  to: string;
  relation: string;
  type: CollageNetworkEdgeType;
};

export type CollageNetworkSpec = {
  title: string;
  subtitle: string;
  nodes: CollageNetworkNode[];
  edges: CollageNetworkEdge[];
};

export type CollageNetworkNodeState = {
  progress: number;
};

export type CollageNetworkEdgeState = {
  lineProgress: number;
  labelProgress: number;
  focusProgress: number;
};
