import assert from "node:assert/strict";
import test from "node:test";
import {
  progressTimelineFunctionDefinition,
  resolveProgressTimelineFunctionArgs,
} from "../src/progress-timeline/schema";
import {timedTableFunctionDefinition, resolveTimedTableFunctionArgs} from "../src/timed-table/schema";
import {directedGraphFunctionDefinition} from "../src/directed-graph/schema";
import {titleFunctionDefinition} from "../src/title/schema";
import {emphasisFunctionDefinition} from "../src/emphasis/schema";
import {xyChartFunctionDefinition} from "../src/xy-chart/schema";
import {resolveXYChartFunctionArgs} from "../src/xy-chart/schema";
import {multiSeriesBarChartFunctionDefinition, multiSeriesLineChartFunctionDefinition} from "../src/multi-series-chart/schema";
import {containmentFunctionDefinition} from "../src/containment/schema";
import {decompositionFunctionDefinition, resolveDecompositionFunctionArgs} from "../src/decomposition/schema";
import {
  resolveSideBySideComparisonFunctionArgs,
  sideBySideComparisonFunctionDefinition,
  weightedComparisonFunctionDefinition,
} from "../src/weighted-comparison/schema";
import {collageNetworkFunctionDefinition, resolveCollageNetworkFunctionArgs} from "../src/collage-network/schema";

type Definition = {name: string; parameters: {properties: Record<string, unknown>; required: readonly string[]}};

const definitions: Array<[Definition, string[]]> = [
  [progressTimelineFunctionDefinition, ["group", "at", "title", "nodes"]],
  [timedTableFunctionDefinition, ["group", "at", "rows", "columns", "cells"]],
  [directedGraphFunctionDefinition, ["group", "at", "title", "edges"]],
  [titleFunctionDefinition, ["group", "at", "text"]],
  [emphasisFunctionDefinition, ["group", "at", "text"]],
  [xyChartFunctionDefinition, ["group", "at", "title", "axes", "keyframes"]],
  [multiSeriesBarChartFunctionDefinition, ["group", "at", "title", "xAxis", "yAxis", "series"]],
  [multiSeriesLineChartFunctionDefinition, ["group", "at", "title", "xAxis", "yAxis", "series"]],
  [containmentFunctionDefinition, ["group", "at", "title", "root", "relations", "highlights"]],
  [decompositionFunctionDefinition, ["group", "at", "title", "whole", "parts", "highlights"]],
  [weightedComparisonFunctionDefinition, ["group", "at", "title", "leftLabel", "rightLabel", "items", "highlights"]],
  [sideBySideComparisonFunctionDefinition, ["group", "at", "title", "leftLabel", "rightLabel", "items", "highlights"]],
  [collageNetworkFunctionDefinition, ["group", "at", "title", "subtitle", "nodes", "edges"]],
];

const exposedPropertyNames = (schema: unknown, names = new Set<string>()): Set<string> => {
  if (!schema || typeof schema !== "object") return names;
  const record = schema as Record<string, unknown>;
  if (record.properties && typeof record.properties === "object") {
    for (const [name, value] of Object.entries(record.properties as Record<string, unknown>)) {
      names.add(name);
      exposedPropertyNames(value, names);
    }
  }
  if (record.items) exposedPropertyNames(record.items, names);
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    if (Array.isArray(record[key])) record[key].forEach((item) => exposedPropertyNames(item, names));
  }
  return names;
};

test("every Function Call exposes group, absolute at and only its intended root fields", () => {
  for (const [definition, expected] of definitions) {
    assert.deepEqual(Object.keys(definition.parameters.properties), expected, definition.name);
    assert.deepEqual([...definition.parameters.required], expected, definition.name);
  }
});

test("Function Calls do not expose template-owned or pipeline-owned fields", () => {
  const forbidden = ["action", "detail", "motion", "progress", "kind", "assetSrc", "chartType", "sequence", "source", "mode"];
  for (const [definition] of definitions) {
    const names = exposedPropertyNames(definition.parameters);
    for (const field of forbidden) assert.equal(names.has(field), false, `${definition.name} exposes ${field}`);
  }
});

test("resolvers convert absolute episode timestamps to scene-local timestamps", () => {
  const progress = resolveProgressTimelineFunctionArgs({
    group: "history",
    at: 20,
    title: "发展历程",
    nodes: [{at: 20, title: "1998年创办"}, {at: 24.5, title: "2004年上市"}],
  });
  assert.deepEqual(progress.spec.nodes.map((node) => node.at), [0, 4.5]);

  const decomposition = resolveDecompositionFunctionArgs({
    group: "stack",
    at: 100,
    title: "四层能力",
    whole: "AI基础设施",
    parts: [{at: 101, part: "芯片"}, {at: 103, part: "模型"}],
    highlights: [{at: 104, target: "模型"}],
  });
  assert.deepEqual(decomposition.spec.events.map((event) => event.at), [1, 3, 4]);
  assert.equal("detail" in decomposition.spec.events[0], false);
});

test("XY year axes do not get stretched back to zero", () => {
  const resolved = resolveXYChartFunctionArgs({
    group: "capex",
    at: 10,
    title: "资本开支",
    axes: {x: {label: "年份", unit: "年"}, y: {label: "金额", unit: "亿美元"}},
    keyframes: [
      {at: 10, x: 2023, y: 323, label: "2023"},
      {at: 12, x: 2024, y: 525, label: "2024"},
    ],
  });
  assert.deepEqual({min: resolved.spec.axes.x.min, max: resolved.spec.axes.x.max, ticks: resolved.spec.axes.x.ticks}, {min: 2023, max: 2024, ticks: 2});
  assert.equal(resolved.spec.axes.y.min, 0);
});

test("timed table uses explicit coordinates rather than array order", () => {
  const resolved = resolveTimedTableFunctionArgs({
    group: "financials",
    at: 50,
    rows: 2,
    columns: 2,
    cells: [
      {row: 2, column: 2, text: "432", at: 55},
      {row: 1, column: 1, text: "业务", at: 50},
      {row: 2, column: 1, text: "云", at: 54},
      {row: 1, column: 2, text: "收入", at: 50},
    ],
  });
  assert.deepEqual(resolved.spec.cells, [
    {text: "业务", at: 0},
    {text: "收入", at: 0},
    {text: "云", at: 4},
    {text: "432", at: 5},
  ]);
});

test("ordinary side-by-side comparison remains unweighted", () => {
  const resolved = resolveSideBySideComparisonFunctionArgs({
    group: "search_change",
    at: 70,
    title: "搜索方式变化",
    leftLabel: "过去",
    rightLabel: "现在",
    items: [
      {at: 70, side: "left", text: "返回链接"},
      {at: 73, side: "right", text: "直接生成答案"},
    ],
    highlights: [],
  });
  assert.ok(resolved.spec.events.every((event) => !("weight" in event)));
});

test("collage resolver owns assets and visual classification", () => {
  const resolved = resolveCollageNetworkFunctionArgs({
    group: "rivals",
    at: 200,
    title: "AI竞争网络",
    subtitle: "合作与竞争",
    nodes: [
      {id: "microsoft", label: "微软", role: "Azure云平台", at: 200},
      {id: "openai", label: "OpenAI", role: "模型公司", at: 200},
    ],
    edges: [{at: 202, from: "microsoft", to: "openai", relation: "云端模型合作"}],
  }, {resolveAsset: (node) => node.id === "microsoft" ? "logos/microsoft.png" : undefined});
  assert.equal(resolved.spec.nodes[0].assetSrc, "logos/microsoft.png");
  assert.equal(resolved.spec.nodes[1].assetSrc, undefined);
  assert.equal(resolved.spec.nodes[0].kind, "cloud");
  assert.equal(resolved.spec.edges[0].type, "cloud");
  assert.equal(resolved.spec.edges[0].at, 2);
});
