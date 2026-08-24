import test from "node:test";
import assert from "node:assert/strict";
import {emphasisHasStarted, evaluateEmphasis} from "../src/emphasis/evaluate";
import {assertEmphasisSpec, validateEmphasisSpec} from "../src/emphasis/validate";

const spec = assertEmphasisSpec({text: "关键", at: 3.5});

test("emphasis remains hidden until its timestamp", () => {
  assert.equal(emphasisHasStarted(spec, 3.499), false);
  assert.equal(emphasisHasStarted(spec, 3.5), true);
});

test("emphasis starts below and settles at the center", () => {
  assert.ok(evaluateEmphasis(spec, 3.5).translateY > 0);
  assert.equal(evaluateEmphasis(spec, 4).translateY, 0);
});

test("emphasis schema exposes only text and at", () => {
  assert.deepEqual(Object.keys(spec).sort(), ["at", "text"]);
  assert.ok(validateEmphasisSpec({text: "", at: 1}).length > 0);
});
