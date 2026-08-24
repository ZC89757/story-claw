import {DirectedGraphSpec} from "./types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const validateDirectedGraphSpec = (input: unknown): string[] => {
  if (!isRecord(input)) return ["spec must be an object"];
  if (!Array.isArray(input.edges) || input.edges.length === 0) return ["edges must contain at least one item"];
  const errors: string[] = [];
  if (input.title !== undefined && (typeof input.title !== "string" || !input.title.trim())) errors.push("title must be a non-empty string");
  if (input.edges.length > 40) errors.push("edges may contain at most 40 items");
  const knownNodes = new Set<string>();
  const edgeKeys = new Set<string>();
  let previousAt = -1;

  input.edges.forEach((raw, index) => {
    if (!isRecord(raw)) {
      errors.push(`edges[${index}] must be an object`);
      return;
    }
    const from = typeof raw.from === "string" ? raw.from.trim() : "";
    const to = typeof raw.to === "string" ? raw.to.trim() : "";
    if (!from) errors.push(`edges[${index}].from is required`);
    if (!to) errors.push(`edges[${index}].to is required`);
    if (from && from === to) errors.push(`edges[${index}] cannot point to itself`);
    if (typeof raw.relation !== "string" || !raw.relation.trim()) errors.push(`edges[${index}].relation is required`);
    if (typeof raw.at !== "number" || !Number.isFinite(raw.at) || raw.at < previousAt) errors.push(`edges[${index}].at must be non-decreasing`);
    if (index === 0 && from) knownNodes.add(from);
    if (from && !knownNodes.has(from)) errors.push(`edges[${index}].from must already be visible`);
    const edgeKey = `${from}\u0000${to}`;
    if (edgeKeys.has(edgeKey)) errors.push(`edges[${index}] duplicates an existing direction`);
    edgeKeys.add(edgeKey);
    if (to) knownNodes.add(to);
    if (typeof raw.at === "number") previousAt = raw.at;
  });
  return errors;
};

export const assertDirectedGraphSpec = (input: unknown): DirectedGraphSpec => {
  const errors = validateDirectedGraphSpec(input);
  if (errors.length) throw new Error(`Invalid DirectedGraphSpec:\n- ${errors.join("\n- ")}`);
  return input as DirectedGraphSpec;
};
