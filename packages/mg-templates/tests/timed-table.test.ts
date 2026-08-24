import test from "node:test";
import assert from "node:assert/strict";
import {evaluateTimedTableCell} from "../src/timed-table/evaluate";
import {assertTimedTableSpec, validateTimedTableSpec} from "../src/timed-table/validate";

const spec = assertTimedTableSpec({size: {rows: 2, columns: 2}, cells: [
  {at: 0, text: "维度"}, {at: 0, text: "模型"}, {at: 2, text: "优势"}, {at: 5, text: "多模态"},
]});

test("table cell remains empty until its timestamp", () => {
  assert.equal(evaluateTimedTableCell(spec.cells[3], 4.999).visible, false);
  assert.equal(evaluateTimedTableCell(spec.cells[3], 5).visible, true);
});

test("table requires exactly rows times columns cells", () => {
  assert.ok(validateTimedTableSpec({size: {rows: 2, columns: 2}, cells: spec.cells.slice(0, 3)}).some((error) => error.includes("rows * columns")));
});

test("cell timestamps may follow narration instead of row-major order", () => {
  const mixed = structuredClone(spec);
  mixed.cells[2].at = 8;
  mixed.cells[3].at = 3;
  assert.deepEqual(validateTimedTableSpec(mixed), []);
});
