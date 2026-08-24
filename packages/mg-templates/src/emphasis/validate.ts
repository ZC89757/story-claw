import {EmphasisSpec} from "./types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const validateEmphasisSpec = (input: unknown): string[] => {
  if (!isRecord(input)) return ["spec must be an object"];
  const errors: string[] = [];
  if (typeof input.text !== "string" || !input.text.trim()) errors.push("text is required");
  if (typeof input.text === "string" && Array.from(input.text).length > 16) errors.push("text may contain at most 16 characters");
  if (typeof input.at !== "number" || !Number.isFinite(input.at) || input.at < 0) errors.push("at must be a non-negative number");
  return errors;
};

export const assertEmphasisSpec = (input: unknown): EmphasisSpec => {
  const errors = validateEmphasisSpec(input);
  if (errors.length) throw new Error(`Invalid EmphasisSpec:\n- ${errors.join("\n- ")}`);
  return input as EmphasisSpec;
};
