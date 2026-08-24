import {ProgressTimelineSpec} from "./types";
import {PROGRESS_MOVE_DURATION} from "./evaluate";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const validateProgressTimelineSpec = (input: unknown): string[] => {
  if (!isRecord(input)) return ["spec must be an object"];
  const errors: string[] = [];
  if (typeof input.title !== "string" || !input.title.trim()) errors.push("title is required");
  if (typeof input.subtitle !== "string") errors.push("subtitle must be a string");
  if (typeof input.followViewport !== "boolean") errors.push("followViewport must be a boolean");
  if (!Array.isArray(input.nodes) || input.nodes.length < 2) return [...errors, "nodes must contain at least two items"];
  if (input.nodes.length > 60) errors.push("nodes may contain at most 60 items");

  let previousAt = -1;
  let previousProgress = -1;
  let previousMotion = "instant";
  const ids = new Set<string>();
  input.nodes.forEach((raw, index) => {
    if (!isRecord(raw)) {
      errors.push(`nodes[${index}] must be an object`);
      return;
    }
    if (typeof raw.id !== "string" || !raw.id.trim()) errors.push(`nodes[${index}].id is required`);
    if (typeof raw.id === "string" && ids.has(raw.id)) errors.push(`nodes[${index}].id must be unique`);
    if (typeof raw.id === "string") ids.add(raw.id);
    if (typeof raw.at !== "number" || !Number.isFinite(raw.at) || raw.at <= previousAt) errors.push(`nodes[${index}].at must increase`);
    if (typeof raw.at === "number" && previousMotion === "ease" && raw.at < previousAt + PROGRESS_MOVE_DURATION) {
      errors.push(`nodes[${index}].at must leave ${PROGRESS_MOVE_DURATION}s for the previous movement`);
    }
    if (typeof raw.progress !== "number" || raw.progress < 0 || raw.progress > 100 || raw.progress <= previousProgress) errors.push(`nodes[${index}].progress must increase within 0..100`);
    if (raw.kind !== "major" && raw.kind !== "minor") errors.push(`nodes[${index}].kind is invalid`);
    if (raw.motion !== "ease" && raw.motion !== "instant") errors.push(`nodes[${index}].motion is invalid`);
    if (typeof raw.title !== "string" || !raw.title.trim()) errors.push(`nodes[${index}].title is required`);
    if (typeof raw.eyebrow !== "string") errors.push(`nodes[${index}].eyebrow must be a string`);
    if (!isRecord(raw.detail) || !["text", "image", "video"].includes(String(raw.detail.type))) errors.push(`nodes[${index}].detail is invalid`);
    previousAt = typeof raw.at === "number" ? raw.at : previousAt;
    previousMotion = typeof raw.motion === "string" ? raw.motion : previousMotion;
    previousProgress = typeof raw.progress === "number" ? raw.progress : previousProgress;
  });
  const first = input.nodes[0] as Record<string, unknown>;
  if (first.at !== 0) errors.push("nodes[0].at must equal 0");
  if (first.progress !== 0) errors.push("nodes[0].progress must equal 0");
  if (!input.nodes.some((node) => isRecord(node) && node.kind === "major")) errors.push("at least one major node is required");
  return errors;
};

export const assertProgressTimelineSpec = (input: unknown): ProgressTimelineSpec => {
  const errors = validateProgressTimelineSpec(input);
  if (errors.length) throw new Error(`Invalid ProgressTimelineSpec:\n- ${errors.join("\n- ")}`);
  return input as ProgressTimelineSpec;
};
