export type ComparisonSide = "left" | "right";

export type AddComparisonPointEvent = {
  at: number;
  action: "add";
  side: ComparisonSide;
  text: string;
  weight: number;
};

export type AddSideBySidePointEvent = {
  at: number;
  action: "add";
  side: ComparisonSide;
  text: string;
};

export type HighlightComparisonSideEvent = {
  at: number;
  action: "highlight";
  side: ComparisonSide;
};

export type WeightedComparisonEvent = AddComparisonPointEvent | HighlightComparisonSideEvent;
export type SideBySideComparisonEvent = AddSideBySidePointEvent | HighlightComparisonSideEvent;

export type WeightedComparisonSpec = {
  title: string;
  leftLabel: string;
  rightLabel: string;
  events: WeightedComparisonEvent[];
};

export type SideBySideComparisonSpec = {
  title: string;
  leftLabel: string;
  rightLabel: string;
  events: SideBySideComparisonEvent[];
};

export type WeightedComparisonEventState = {progress: number};
