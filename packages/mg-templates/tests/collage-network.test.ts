import test from "node:test";
import assert from "node:assert/strict";
import specJson from "../examples/ai-company-network.spec.json";
import {evaluateCollageNetworkEdge, evaluateCollageNetworkNode} from "../src/collage-network/evaluate";
import {assertCollageNetworkSpec, validateCollageNetworkSpec} from "../src/collage-network/validate";

const spec = assertCollageNetworkSpec(specJson);

test("collage node remains hidden until its timestamp", () => {
  const node = spec.nodes[2];
  assert.equal(evaluateCollageNetworkNode(node, node.at).progress, 0);
  assert.ok(evaluateCollageNetworkNode(node, node.at + 0.2).progress > 0);
});

test("collage edge starts drawing exactly at its timestamp", () => {
  const edge = spec.edges[1];
  assert.equal(evaluateCollageNetworkEdge(edge, edge.at).lineProgress, 0);
  assert.ok(evaluateCollageNetworkEdge(edge, edge.at + 0.2).lineProgress > 0);
});

test("validator rejects an edge before either endpoint exists", () => {
  const invalid = {
    ...specJson,
    edges: [{at: 1, from: "openai", to: "microsoft", relation: "too early", type: "cloud"}],
  };
  assert.ok(validateCollageNetworkSpec(invalid).some((error) => error.includes("before its nodes")));
});

test("validator rejects missing logo assets", () => {
  const invalid = {...specJson, nodes: specJson.nodes.map((node, index) => index === 0 ? {...node, assetSrc: ""} : node)};
  assert.ok(validateCollageNetworkSpec(invalid).some((error) => error.includes("assetSrc")));
});
