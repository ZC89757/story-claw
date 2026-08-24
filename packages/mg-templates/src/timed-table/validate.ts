import {TimedTableSpec} from "./types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const validateTimedTableSpec = (input: unknown): string[] => {
  if (!isRecord(input)) return ["spec must be an object"];
  const errors: string[] = [];
  if (!isRecord(input.size)) return ["size must be an object"];
  const rows = input.size.rows;
  const columns = input.size.columns;
  if (!Number.isInteger(rows) || (rows as number) < 1 || (rows as number) > 10) errors.push("size.rows must be an integer within 1..10");
  if (!Number.isInteger(columns) || (columns as number) < 1 || (columns as number) > 8) errors.push("size.columns must be an integer within 1..8");
  if (!Array.isArray(input.cells)) return [...errors, "cells must be an array"];
  if (Number.isInteger(rows) && Number.isInteger(columns) && input.cells.length !== (rows as number) * (columns as number)) {
    errors.push("cells length must equal rows * columns");
  }
  input.cells.forEach((raw, index) => {
    if (!isRecord(raw)) {
      errors.push(`cells[${index}] must be an object`);
      return;
    }
    if (typeof raw.at !== "number" || !Number.isFinite(raw.at) || raw.at < 0) errors.push(`cells[${index}].at must be non-negative`);
    if (typeof raw.text !== "string") errors.push(`cells[${index}].text must be a string`);
    if (typeof raw.text === "string" && raw.text.length > 160) errors.push(`cells[${index}].text is too long`);
  });
  return errors;
};

export const assertTimedTableSpec = (input: unknown): TimedTableSpec => {
  const errors = validateTimedTableSpec(input);
  if (errors.length) throw new Error(`Invalid TimedTableSpec:\n- ${errors.join("\n- ")}`);
  return input as TimedTableSpec;
};
