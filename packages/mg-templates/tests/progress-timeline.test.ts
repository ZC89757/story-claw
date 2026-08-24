import test from "node:test";
import assert from "node:assert/strict";
import specJson from "../examples/black-swan-progress.spec.json";
import {evaluateProgressTimeline} from "../src/progress-timeline/evaluate";
import {assertProgressTimelineSpec, validateProgressTimelineSpec} from "../src/progress-timeline/validate";

const spec = assertProgressTimelineSpec(specJson);

test("progress remains still until the node timestamp", () => {
  assert.equal(evaluateProgressTimeline(spec, 9.852).progress, 12);
  assert.equal(evaluateProgressTimeline(spec, 9.853).progress, 12);
});

test("progress reaches the target after the node duration", () => {
  assert.equal(evaluateProgressTimeline(spec, 10.553).progress, 25);
});

test("active detail changes when movement is triggered", () => {
  assert.equal(evaluateProgressTimeline(spec, 9.852).activeIndex, 1);
  assert.equal(evaluateProgressTimeline(spec, 9.853).activeIndex, 2);
});

test("validator rejects decreasing progress", () => {
  const invalid = structuredClone(specJson);
  invalid.nodes[2].progress = 5;
  assert.ok(validateProgressTimelineSpec(invalid).some((error) => error.includes("progress must increase")));
});
