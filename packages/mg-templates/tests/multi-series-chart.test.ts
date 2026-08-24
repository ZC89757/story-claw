import test from "node:test";
import assert from "node:assert/strict";
import {evaluateChartDatum} from "../src/multi-series-chart/evaluate";
import {assertMultiSeriesChartSpec, validateMultiSeriesChartSpec} from "../src/multi-series-chart/validate";

const input = {
  chartType: "bar", title: "模型能力", xAxis: {label: "维度", categories: ["推理", "代码"]},
  yAxis: {min: 0, max: 100, label: "评分", unit: "分", ticks: 6},
  series: [{name: "Gemini", data: [{at: 2, value: 87}, {at: 4, value: 84}]}, {name: "GPT", data: [{at: 2.5, value: 94}, {at: 4.5, value: 96}]}],
};
const spec = assertMultiSeriesChartSpec(input);

test("datum animation starts at rather than before its timestamp", () => {
  assert.equal(evaluateChartDatum(spec.series[0].data[0], 1.999), 0);
  assert.equal(evaluateChartDatum(spec.series[0].data[0], 2), 0);
  assert.ok(evaluateChartDatum(spec.series[0].data[0], 2.3) > 0);
});

test("bar and line use the same schema", () => {
  assert.deepEqual(validateMultiSeriesChartSpec({...input, chartType: "line"}), []);
});

test("every series must match the category count", () => {
  const invalid = structuredClone(input);
  invalid.series[0].data.pop();
  assert.ok(validateMultiSeriesChartSpec(invalid).some((error) => error.includes("match categories")));
});
