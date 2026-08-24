import {evaluateWeightedComparisonEvent} from "./evaluate";
import {AddComparisonPointEvent, AddSideBySidePointEvent, ComparisonSide, SideBySideComparisonSpec, WeightedComparisonSpec} from "./types";

export const getComparisonState = (spec: WeightedComparisonSpec, seconds: number) => {
  const points = spec.events.filter((event): event is AddComparisonPointEvent => event.action === "add");
  const progress = new Map(points.map((event) => [event, evaluateWeightedComparisonEvent(event, seconds).progress]));
  const total = (side: ComparisonSide) => points.filter((event) => event.side === side).reduce((sum, event) => sum + event.weight * Math.max(0, Math.min(1, progress.get(event) ?? 0)), 0);
  const highlight = [...spec.events].reverse().find((event) => event.action === "highlight" && event.at <= seconds);
  const highlightProgress = highlight ? evaluateWeightedComparisonEvent(highlight, seconds).progress : 0;
  return {points, progress, leftTotal: total("left"), rightTotal: total("right"), highlightSide: highlight?.side, highlightProgress};
};

export const getSideBySideComparisonState = (spec: SideBySideComparisonSpec, seconds: number) => {
  const points = spec.events.filter((event): event is AddSideBySidePointEvent => event.action === "add");
  const progress = new Map(points.map((event) => [event, evaluateWeightedComparisonEvent(event, seconds).progress]));
  const highlight = [...spec.events].reverse().find((event) => event.action === "highlight" && event.at <= seconds);
  const highlightProgress = highlight ? evaluateWeightedComparisonEvent(highlight, seconds).progress : 0;
  return {points, progress, highlightSide: highlight?.side, highlightProgress};
};
