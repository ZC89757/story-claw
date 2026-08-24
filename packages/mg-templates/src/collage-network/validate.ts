import {CollageNetworkSpec} from "./types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown, max: number) => typeof value === "string" && value.trim().length > 0 && value.length <= max;
const isTimestamp = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 3600;

export const validateCollageNetworkSpec = (input: unknown): string[] => {
  if (!isRecord(input)) return ["spec must be an object"];
  const errors: string[] = [];
  if (!isText(input.title, 80)) errors.push("title must be 1-80 characters");
  if (!isText(input.subtitle, 120)) errors.push("subtitle must be 1-120 characters");
  if (!Array.isArray(input.nodes) || input.nodes.length < 2 || input.nodes.length > 10) {
    errors.push("nodes must contain 2-10 items");
  }
  if (!Array.isArray(input.edges) || input.edges.length < 1 || input.edges.length > 30) {
    errors.push("edges must contain 1-30 items");
  }
  if (!Array.isArray(input.nodes) || !Array.isArray(input.edges)) return errors;

  const nodes = input.nodes;
  const edges = input.edges;
  const ids = new Set<string>();
  let previousNodeAt = -1;
  nodes.forEach((raw, index) => {
    if (!isRecord(raw)) {
      errors.push(`nodes[${index}] must be an object`);
      return;
    }
    const id = typeof raw.id === "string" ? raw.id : "";
    if (!/^[A-Za-z0-9_-]+$/.test(id) || id.length > 40) errors.push(`nodes[${index}].id must be a short ASCII identifier`);
    if (ids.has(id)) errors.push(`nodes[${index}].id must be unique`);
    ids.add(id);
    if (!isText(raw.label, 80)) errors.push(`nodes[${index}].label is required`);
    if (!isTimestamp(raw.at) || (typeof raw.at === "number" && raw.at < previousNodeAt)) {
      errors.push(`nodes[${index}].at must be a non-negative, non-decreasing number`);
    } else if (typeof raw.at === "number") previousNodeAt = raw.at;
    if (raw.assetSrc !== undefined && !isText(raw.assetSrc, 500)) errors.push(`nodes[${index}].assetSrc must be a non-empty path when supplied`);
    if (!isText(raw.role, 80)) errors.push(`nodes[${index}].role is required`);
    if (!(["model", "cloud", "chip"] as unknown[]).includes(raw.kind)) errors.push(`nodes[${index}].kind is invalid`);
  });

  let previousEdgeAt = -1;
  edges.forEach((raw, index) => {
    if (!isRecord(raw)) {
      errors.push(`edges[${index}] must be an object`);
      return;
    }
    if (!isTimestamp(raw.at) || (typeof raw.at === "number" && raw.at < previousEdgeAt)) {
      errors.push(`edges[${index}].at must be a non-negative, non-decreasing number`);
    } else if (typeof raw.at === "number") previousEdgeAt = raw.at;
    if (typeof raw.from !== "string" || !ids.has(raw.from)) errors.push(`edges[${index}].from must reference a node`);
    if (typeof raw.to !== "string" || !ids.has(raw.to)) errors.push(`edges[${index}].to must reference a node`);
    if (raw.from === raw.to) errors.push(`edges[${index}] cannot connect a node to itself`);
    if (!isText(raw.relation, 80)) errors.push(`edges[${index}].relation is required`);
    if (!(["investment", "cloud", "supply", "competition"] as unknown[]).includes(raw.type)) errors.push(`edges[${index}].type is invalid`);
    const fromNode = nodes.find((node) => isRecord(node) && node.id === raw.from);
    const toNode = nodes.find((node) => isRecord(node) && node.id === raw.to);
    if (typeof raw.at === "number" && ((isRecord(fromNode) && typeof fromNode.at === "number" && fromNode.at > raw.at) || (isRecord(toNode) && typeof toNode.at === "number" && toNode.at > raw.at))) {
      errors.push(`edges[${index}] cannot appear before its nodes`);
    }
  });
  return errors;
};

export const assertCollageNetworkSpec = (input: unknown): CollageNetworkSpec => {
  const errors = validateCollageNetworkSpec(input);
  if (errors.length) throw new Error(`Invalid CollageNetworkSpec:\n- ${errors.join("\n- ")}`);
  return input as CollageNetworkSpec;
};
