import test from "node:test";
import assert from "node:assert/strict";
import specJson from "../examples/product-decomposition.spec.json";
import {evaluateDecompositionEvent} from "../src/decomposition/evaluate";
import {assertDecompositionSpec, validateDecompositionSpec} from "../src/decomposition/validate";

const spec = assertDecompositionSpec(specJson);

test("part extraction starts exactly at its timestamp", () => {
  const event = spec.events[0];
  assert.equal(evaluateDecompositionEvent(event, event.at).progress, 0);
});

test("part extraction remains hidden before its timestamp", () => {
  const event = spec.events[1];
  assert.equal(evaluateDecompositionEvent(event, event.at - 0.01).progress, 0);
  assert.ok(evaluateDecompositionEvent(event, event.at + 0.2).progress > 0);
});

test("validator rejects highlighting a part before extraction", () => {
  const invalid = {whole: "A", events: [{at: 1, action: "highlight", target: "B"}, {at: 2, action: "extract", part: "B"}]};
  assert.ok(validateDecompositionSpec(invalid).some((error) => error.includes("must already be extracted")));
});

test("validator requires at least two extracted parts", () => {
  const invalid = {whole: "A", events: [{at: 1, action: "extract", part: "B"}, {at: 2, action: "highlight", target: "B"}]};
  assert.ok(validateDecompositionSpec(invalid).some((error) => error.includes("two extract")));
});

test("validator rejects the removed detail field", () => {
  const invalid = {
    whole: "A",
    events: [
      {at: 1, action: "extract", part: "B", detail: "legacy"},
      {at: 2, action: "extract", part: "C"},
    ],
  };
  assert.ok(validateDecompositionSpec(invalid).some((error) => error.includes("detail is not supported")));
});
