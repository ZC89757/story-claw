import {ContainmentSpec} from "./types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const validateContainmentSpec = (input: unknown): string[] => {
  if (!isRecord(input)) return ["spec must be an object"];
  if (!Array.isArray(input.events) || input.events.length === 0) return ["events must contain at least one item"];
  const errors: string[] = [];
  if (input.title !== undefined && (typeof input.title !== "string" || !input.title.trim())) errors.push("title must be a non-empty string");
  if (input.root !== undefined && (typeof input.root !== "string" || !input.root.trim())) errors.push("root must be a non-empty string");
  if (input.events.length > 40) errors.push("events may contain at most 40 items");
  const visible = new Set<string>();
  if (typeof input.root === "string" && input.root.trim()) visible.add(input.root.trim());
  const parents = new Map<string, string>();
  let previousAt = -1;

  input.events.forEach((raw, index) => {
    if (!isRecord(raw)) {
      errors.push(`events[${index}] must be an object`);
      return;
    }
    if (typeof raw.at !== "number" || !Number.isFinite(raw.at) || raw.at < 0 || raw.at < previousAt) {
      errors.push(`events[${index}].at must be a non-negative, non-decreasing number`);
    } else previousAt = raw.at;

    if (raw.action === "contain") {
      const parent = typeof raw.parent === "string" ? raw.parent.trim() : "";
      const child = typeof raw.child === "string" ? raw.child.trim() : "";
      if (!parent) errors.push(`events[${index}].parent is required`);
      if (!child) errors.push(`events[${index}].child is required`);
      if (parent && parent === child) errors.push(`events[${index}] cannot contain itself`);
      if (visible.size === 0 && parent) visible.add(parent);
      if (parent && !visible.has(parent)) errors.push(`events[${index}].parent must already be visible`);
      if (child && visible.has(child)) errors.push(`events[${index}].child must be new`);
      if (child && parents.has(child)) errors.push(`events[${index}].child already has a parent`);
      if (parent && child) {
        parents.set(child, parent);
        visible.add(child);
      }
    } else if (raw.action === "highlight") {
      const target = typeof raw.target === "string" ? raw.target.trim() : "";
      if (!target) errors.push(`events[${index}].target is required`);
      if (target && !visible.has(target)) errors.push(`events[${index}].target must already be visible`);
    } else errors.push(`events[${index}].action must be contain or highlight`);
  });
  if (!input.events.some((event) => isRecord(event) && event.action === "contain")) errors.push("events must contain at least one contain action");
  return errors;
};

export const assertContainmentSpec = (input: unknown): ContainmentSpec => {
  const errors = validateContainmentSpec(input);
  if (errors.length) throw new Error(`Invalid ContainmentSpec:\n- ${errors.join("\n- ")}`);
  return input as ContainmentSpec;
};
