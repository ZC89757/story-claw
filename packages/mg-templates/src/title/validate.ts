import {TitleSpec} from "./types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const validateTitleSpec = (input: unknown): string[] => {
  if (!isRecord(input)) return ["spec must be an object"];
  const errors: string[] = [];
  if (typeof input.text !== "string" || !input.text.trim()) errors.push("text is required");
  if (typeof input.text === "string" && input.text.length > 80) errors.push("text may contain at most 80 characters");
  if (typeof input.at !== "number" || !Number.isFinite(input.at) || input.at < 0) errors.push("at must be a non-negative number");
  if (input.sequence !== undefined && (!Number.isInteger(input.sequence) || (input.sequence as number) < 1 || (input.sequence as number) > 999)) errors.push("sequence must be an integer within 1..999");
  return errors;
};

export const assertTitleSpec = (input: unknown): TitleSpec => {
  const errors = validateTitleSpec(input);
  if (errors.length) throw new Error(`Invalid TitleSpec:\n- ${errors.join("\n- ")}`);
  return input as TitleSpec;
};
