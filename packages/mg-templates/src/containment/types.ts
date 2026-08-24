export type ContainEvent = {
  at: number;
  action: "contain";
  parent: string;
  child: string;
};

export type HighlightEvent = {
  at: number;
  action: "highlight";
  target: string;
};

export type ContainmentEvent = ContainEvent | HighlightEvent;

export type ContainmentSpec = {
  title?: string;
  root?: string;
  events: ContainmentEvent[];
};

export type ContainmentEventState = {
  progress: number;
};
