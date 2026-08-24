import {TimedTableCell} from "./types";

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

export const evaluateTimedTableCell = (cell: TimedTableCell, seconds: number) => {
  const progress = clamp01((seconds - cell.at) / 0.42);
  return {
    visible: seconds >= cell.at,
    opacity: 1 - Math.pow(1 - progress, 3),
    translateY: (1 - progress) * 16,
  };
};
