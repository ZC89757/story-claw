import test from "node:test";
import assert from "node:assert/strict";
import specJson from "../examples/ai-containment.spec.json";
import {evaluateContainmentEvent} from "../src/containment/evaluate";
import {assertContainmentSpec, validateContainmentSpec} from "../src/containment/validate";

const spec = assertContainmentSpec(specJson);

test("future child is completely hidden until its timestamp", () => {
  const event = spec.events[1];
  assert.equal(evaluateContainmentEvent(event, event.at - 0.001).progress, 0);
  assert.equal(evaluateContainmentEvent(event, event.at).progress, 0);
  assert.ok(evaluateContainmentEvent(event, event.at + 0.2).progress > 0);
});

test("highlight begins exactly at its timestamp", () => {
  const event = spec.events[3];
  assert.equal(evaluateContainmentEvent(event, event.at).progress, 0);
  assert.ok(evaluateContainmentEvent(event, event.at + 0.1).progress > 0);
});

test("validator rejects a child of a future concept", () => {
  const invalid = {events: [{at: 1, action: "contain", parent: "A", child: "B"}, {at: 2, action: "contain", parent: "C", child: "D"}]};
  assert.ok(validateContainmentSpec(invalid).some((error) => error.includes("parent must already be visible")));
});

test("validator rejects highlighting a future concept", () => {
  const invalid = {events: [{at: 1, action: "contain", parent: "A", child: "B"}, {at: 2, action: "highlight", target: "C"}]};
  assert.ok(validateContainmentSpec(invalid).some((error) => error.includes("target must already be visible")));
});
