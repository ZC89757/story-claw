import {
  assertFunctionEnvelope,
  functionAtSchema,
  functionGroupSchema,
  FunctionCallEnvelope,
  ResolvedFunctionCall,
  toLocalAt,
} from "../function-call";
import {TimedTableSpec} from "./types";
import {assertTimedTableSpec} from "./validate";

export type TimedTableFunctionArgs = FunctionCallEnvelope & {
  rows: number;
  columns: number;
  cells: Array<{row: number; column: number; text: string; at: number}>;
};

export const timedTableParametersSchema = {
  type: "object",
  additionalProperties: false,
  required: ["group", "at", "rows", "columns", "cells"],
  properties: {
    group: functionGroupSchema,
    at: functionAtSchema,
    rows: {type: "integer", minimum: 1, maximum: 10},
    columns: {type: "integer", minimum: 1, maximum: 8},
    cells: {
      type: "array",
      minItems: 1,
      maxItems: 80,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["row", "column", "text", "at"],
        properties: {
          row: {type: "integer", minimum: 1, maximum: 10},
          column: {type: "integer", minimum: 1, maximum: 8},
          text: {type: "string", maxLength: 160},
          at: functionAtSchema,
        },
      },
    },
  },
} as const;

export const timedTableFunctionDefinition = {
  type: "function",
  name: "create_timed_table",
  description: "为一个 <timed-table> group 创建动态表格。填写行列数及每个单元格的行、列、文字和 at；第 1 行可作为表头。",
  strict: true,
  parameters: timedTableParametersSchema,
} as const;

export const resolveTimedTableFunctionArgs = (
  input: TimedTableFunctionArgs,
): ResolvedFunctionCall<TimedTableSpec> => {
  const envelope = assertFunctionEnvelope(input);
  const slots = new Array<TimedTableSpec["cells"][number] | undefined>(input.rows * input.columns);
  for (const cell of input.cells) {
    if (!Number.isInteger(cell.row) || cell.row < 1 || cell.row > input.rows) throw new Error(`cell row ${cell.row} is outside the table`);
    if (!Number.isInteger(cell.column) || cell.column < 1 || cell.column > input.columns) throw new Error(`cell column ${cell.column} is outside the table`);
    const index = (cell.row - 1) * input.columns + cell.column - 1;
    if (slots[index]) throw new Error(`duplicate table cell at row ${cell.row}, column ${cell.column}`);
    slots[index] = {text: cell.text, at: toLocalAt(cell.at, envelope.at)};
  }
  if (slots.some((cell) => !cell)) throw new Error("every table position must be supplied exactly once");
  const spec = assertTimedTableSpec({
    size: {rows: input.rows, columns: input.columns},
    cells: slots as TimedTableSpec["cells"],
  });
  return {...envelope, spec};
};
