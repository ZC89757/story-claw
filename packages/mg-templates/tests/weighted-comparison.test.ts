import test from "node:test";
import assert from "node:assert/strict";
import specJson from "../examples/model-api-comparison.spec.json";
import {evaluateWeightedComparisonEvent} from "../src/weighted-comparison/evaluate";
import {assertWeightedComparisonSpec, validateWeightedComparisonSpec} from "../src/weighted-comparison/validate";

const spec = assertWeightedComparisonSpec(specJson);

test("comparison point starts exactly at its timestamp", () => {
  const event = spec.events[0];
  assert.equal(evaluateWeightedComparisonEvent(event, event.at).progress, 0);
  assert.ok(evaluateWeightedComparisonEvent(event, event.at + 0.2).progress > 0);
});

test("validator requires points on both sides", () => {
  const invalid = {title: "A", leftLabel: "L", rightLabel: "R", events: [{at: 1, action: "add", side: "left", text: "x", weight: 2}, {at: 2, action: "add", side: "left", text: "y", weight: 3}]};
  assert.ok(validateWeightedComparisonSpec(invalid).some((error) => error.includes("each side")));
});

test("validator rejects out-of-range semantic weight", () => {
  const invalid = {title: "A", leftLabel: "L", rightLabel: "R", events: [{at: 1, action: "add", side: "left", text: "x", weight: 8}, {at: 2, action: "add", side: "right", text: "y", weight: 3}]};
  assert.ok(validateWeightedComparisonSpec(invalid).some((error) => error.includes("between 1 and 5")));
});

test("validator rejects highlighting an empty side", () => {
  const invalid = {title: "A", leftLabel: "L", rightLabel: "R", events: [{at: 1, action: "add", side: "left", text: "x", weight: 2}, {at: 2, action: "highlight", side: "right"}, {at: 3, action: "add", side: "right", text: "y", weight: 3}]};
  assert.ok(validateWeightedComparisonSpec(invalid).some((error) => error.includes("already have")));
});
