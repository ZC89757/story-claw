export type ExtractPartEvent = {
  at: number;
  action: "extract";
  part: string;
};

export type HighlightPartEvent = {
  at: number;
  action: "highlight";
  target: string;
};

export type DecompositionEvent = ExtractPartEvent | HighlightPartEvent;

export type DecompositionSpec = {
  title?: string;
  whole: string;
  events: DecompositionEvent[];
};

export type DecompositionEventState = {progress: number};
