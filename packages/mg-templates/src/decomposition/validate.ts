import {DecompositionSpec} from "./types";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export const validateDecompositionSpec = (input: unknown): string[] => {
  if (!isRecord(input)) return ["spec must be an object"];
  const errors: string[] = [];
  if (input.title !== undefined && (typeof input.title !== "string" || !input.title.trim())) errors.push("title must be a non-empty string");
  if (typeof input.whole !== "string" || !input.whole.trim()) errors.push("whole is required");
  if (!Array.isArray(input.events) || input.events.length < 2) return [...errors, "events must contain at least two items"];
  if (input.events.length > 16) errors.push("events may contain at most 16 items");
  const extracted = new Set<string>();
  let previousAt = -1;
  let extractCount = 0;
  input.events.forEach((raw, index) => {
    if (!isRecord(raw)) {
      errors.push(`events[${index}] must be an object`);
      return;
    }
    if (typeof raw.at !== "number" || !Number.isFinite(raw.at) || raw.at < 0 || raw.at < previousAt) errors.push(`events[${index}].at must be a non-negative, non-decreasing number`);
    else previousAt = raw.at;
    if (raw.action === "extract") {
      const part = typeof raw.part === "string" ? raw.part.trim() : "";
      if (!part) errors.push(`events[${index}].part is required`);
      if (part && part === input.whole) errors.push(`events[${index}].part must differ from whole`);
      if (part && extracted.has(part)) errors.push(`events[${index}].part must be unique`);
      if (raw.detail !== undefined) errors.push(`events[${index}].detail is not supported`);
      if (part) extracted.add(part);
      extractCount++;
    } else if (raw.action === "highlight") {
      const target = typeof raw.target === "string" ? raw.target.trim() : "";
      if (!target) errors.push(`events[${index}].target is required`);
      if (target && !extracted.has(target)) errors.push(`events[${index}].target must already be extracted`);
    } else errors.push(`events[${index}].action must be extract or highlight`);
  });
  if (extractCount < 2) errors.push("events must contain at least two extract actions");
  if (extractCount > 8) errors.push("events may contain at most eight extract actions");
  return errors;
};

export const assertDecompositionSpec = (input: unknown): DecompositionSpec => {
  const errors = validateDecompositionSpec(input);
  if (errors.length) throw new Error(`Invalid DecompositionSpec:\n- ${errors.join("\n- ")}`);
  return input as DecompositionSpec;
};
