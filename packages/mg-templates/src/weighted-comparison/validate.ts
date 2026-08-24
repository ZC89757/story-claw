import {SideBySideComparisonSpec, WeightedComparisonSpec} from "./types";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const validateComparisonSpec = (input: unknown, weighted: boolean): string[] => {
  if (!isRecord(input)) return ["spec must be an object"];
  const errors: string[] = [];
  for (const field of ["title", "leftLabel", "rightLabel"] as const) {
    if (typeof input[field] !== "string" || !input[field].trim()) errors.push(`${field} is required`);
  }
  if (!Array.isArray(input.events) || input.events.length < 2) return [...errors, "events must contain at least two items"];
  if (input.events.length > 24) errors.push("events may contain at most 24 items");
  let previousAt = -1;
  const addCount = {left: 0, right: 0};
  input.events.forEach((raw, index) => {
    if (!isRecord(raw)) {
      errors.push(`events[${index}] must be an object`);
      return;
    }
    if (typeof raw.at !== "number" || !Number.isFinite(raw.at) || raw.at < 0 || raw.at < previousAt) errors.push(`events[${index}].at must be a non-negative, non-decreasing number`);
    else previousAt = raw.at;
    const side = raw.side === "left" || raw.side === "right" ? raw.side : undefined;
    if (!side) errors.push(`events[${index}].side must be left or right`);
    if (raw.action === "add") {
      if (typeof raw.text !== "string" || !raw.text.trim()) errors.push(`events[${index}].text is required`);
      if (weighted && (typeof raw.weight !== "number" || !Number.isFinite(raw.weight) || raw.weight < 1 || raw.weight > 5)) errors.push(`events[${index}].weight must be between 1 and 5`);
      if (!weighted && raw.weight !== undefined) errors.push(`events[${index}].weight is not allowed in an ordinary side-by-side comparison`);
      if (side) addCount[side]++;
    } else if (raw.action === "highlight") {
      if (side && addCount[side] === 0) errors.push(`events[${index}].side must already have an added point`);
    } else errors.push(`events[${index}].action must be add or highlight`);
  });
  if (addCount.left === 0 || addCount.right === 0) errors.push("events must add at least one point to each side");
  if (addCount.left > 6 || addCount.right > 6) errors.push("each side may contain at most six points");
  return errors;
};

export const validateWeightedComparisonSpec = (input: unknown): string[] => validateComparisonSpec(input, true);
export const validateSideBySideComparisonSpec = (input: unknown): string[] => validateComparisonSpec(input, false);

export const assertWeightedComparisonSpec = (input: unknown): WeightedComparisonSpec => {
  const errors = validateWeightedComparisonSpec(input);
  if (errors.length) throw new Error(`Invalid WeightedComparisonSpec:\n- ${errors.join("\n- ")}`);
  return input as WeightedComparisonSpec;
};

export const assertSideBySideComparisonSpec = (input: unknown): SideBySideComparisonSpec => {
  const errors = validateSideBySideComparisonSpec(input);
  if (errors.length) throw new Error(`Invalid SideBySideComparisonSpec:\n- ${errors.join("\n- ")}`);
  return input as SideBySideComparisonSpec;
};
