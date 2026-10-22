import type {DirectedGraphAnnotation} from "./types.js";

const record = (value: unknown): Record<string, any> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};

/** Infer the common node/edge contract from the Provider's actual function schema. */
export const requiresReviewedTopology = (parameters: unknown, group: string): boolean => {
  const schema = record(parameters);
  const properties = record(schema.properties);
  const groups = record(properties.group).enum;
  if (Array.isArray(groups) && !groups.includes(group)) return false;
  const required = Array.isArray(schema.required) ? schema.required : [];
  const nodes = record(properties.nodes);
  const edges = record(properties.edges);
  const nodeFields = record(record(nodes.items).properties);
  const edgeFields = record(record(edges.items).properties);
  return required.includes("nodes") && required.includes("edges")
    && nodes.type === "array" && edges.type === "array"
    && record(nodeFields.id).type === "string" && record(nodeFields.label).type === "string"
    && record(edgeFields.from).type === "string" && record(edgeFields.to).type === "string";
};

export const reviewedNodeId = (index: number): string => `n${index}`;

export const formatReviewedTopology = (graph: DirectedGraphAnnotation): string => JSON.stringify({
  nodes: graph.nodes.map((label, index) => ({id: reviewedNodeId(index), label})),
  edges: graph.edges.map(([from, to]) => ({from: reviewedNodeId(from), to: reviewedNodeId(to)})),
}, null, 2);

/** This comparison is independent of tag names and additional node properties. */
export const reviewedTopologyErrors = (args: Record<string, unknown>, graph: DirectedGraphAnnotation | undefined): string[] => {
  if (!graph) return [];
  const errors: string[] = [];
  if (!Array.isArray(args.nodes) || args.nodes.length !== graph.nodes.length) {
    errors.push(`Function Call 的 nodes 数量必须为 ${graph.nodes.length}`);
  } else {
    args.nodes.forEach((raw, index) => {
      const node = record(raw);
      if (node.id !== reviewedNodeId(index)) errors.push(`nodes[${index}].id 必须保持为 ${reviewedNodeId(index)}`);
      if (node.label !== graph.nodes[index]) errors.push(`nodes[${index}].label 不得修改 HTML 拓扑文字`);
    });
  }
  if (!Array.isArray(args.edges) || args.edges.length !== graph.edges.length) {
    errors.push(`Function Call 的 edges 数量必须为 ${graph.edges.length}`);
  } else {
    args.edges.forEach((raw, index) => {
      const edge = record(raw);
      const [from, to] = graph.edges[index];
      if (edge.from !== reviewedNodeId(from) || edge.to !== reviewedNodeId(to)) {
        errors.push(`edges[${index}] 必须保持 HTML 中的 ${reviewedNodeId(from)} -> ${reviewedNodeId(to)}`);
      }
    });
  }
  return errors;
};
