import assert from "node:assert/strict";
import test from "node:test";
import {evaluateXYChart} from "../src/xy-chart/evaluate";
import {XYChartSpec} from "../src/xy-chart/types";
import {validateXYChartSpec} from "../src/xy-chart/validate";

const baseSpec: XYChartSpec = {
  title: "Test",
  axes: {
    x: {min: 0, max: 10, label: "x", unit: "", ticks: 3},
    y: {min: 0, max: 100, label: "y", unit: "", ticks: 3},
  },
  keyframes: [
    {at: 0, x: 0, y: 0, label: "start", motion: "instant"},
    {at: 2, x: 10, y: 100, label: "end", motion: "ease"},
  ],
};

test("ease reaches the exact target coordinate at its keyframe", () => {
  assert.deepEqual(evaluateXYChart(baseSpec, 2), {x: 10, y: 100, label: "end"});
  const middle = evaluateXYChart(baseSpec, 1);
  assert.equal(middle.x, 5);
  assert.equal(middle.y, 50);
});

test("instant holds the previous coordinate before its target time", () => {
  const instant: XYChartSpec = {...baseSpec, keyframes: [baseSpec.keyframes[0], {...baseSpec.keyframes[1], motion: "instant"}]};
  assert.deepEqual(evaluateXYChart(instant, 1.99), {x: 0, y: 0, label: "start"});
  assert.deepEqual(evaluateXYChart(instant, 2), {x: 10, y: 100, label: "end"});
});

test("validator rejects out-of-range coordinates and non-increasing time", () => {
  const invalid = {...baseSpec, keyframes: [baseSpec.keyframes[0], {...baseSpec.keyframes[1], at: 0, x: 99}]};
  const errors = validateXYChartSpec(invalid);
  assert.ok(errors.some((error) => error.includes("outside axes.x range")));
  assert.ok(errors.some((error) => error.includes("greater than the previous")));
});
