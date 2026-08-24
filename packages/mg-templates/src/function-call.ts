export type FunctionCallEnvelope = {
  group: string;
  /** Absolute second on the episode timeline. */
  at: number;
};

export type ResolvedFunctionCall<TSpec> = FunctionCallEnvelope & {
  spec: TSpec;
};

export const functionGroupSchema = {
  type: "string",
  minLength: 1,
  maxLength: 80,
  pattern: "^[A-Za-z0-9_-]+$",
} as const;

export const functionAtSchema = {
  type: "number",
  minimum: 0,
  maximum: 36000,
} as const;

export const assertFunctionEnvelope = (input: unknown): FunctionCallEnvelope => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("function arguments must be an object");
  }
  const value = input as Record<string, unknown>;
  if (typeof value.group !== "string" || !/^[A-Za-z0-9_-]+$/.test(value.group)) {
    throw new Error("group must be a non-empty ASCII identifier");
  }
  if (typeof value.at !== "number" || !Number.isFinite(value.at) || value.at < 0) {
    throw new Error("at must be a non-negative absolute timestamp");
  }
  return {group: value.group, at: value.at};
};

export const toLocalAt = (absoluteAt: number, sceneAt: number): number => {
  if (!Number.isFinite(absoluteAt) || absoluteAt < sceneAt - 0.001) {
    throw new Error(`element at ${absoluteAt} cannot precede scene at ${sceneAt}`);
  }
  return Math.round(Math.max(0, absoluteAt - sceneAt) * 1000) / 1000;
};

const niceStep = (range: number, targetTicks = 6) => {
  const rough = Math.max(Number.EPSILON, range / Math.max(1, targetTicks - 1));
  const power = Math.pow(10, Math.floor(Math.log10(rough)));
  const normalized = rough / power;
  const multiplier = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return multiplier * power;
};

export const autoAxis = (
  values: number[],
  options: {includeZero?: boolean; targetTicks?: number} = {},
) => {
  const finite = values.filter(Number.isFinite);
  if (finite.length === 0) return {min: 0, max: 1, ticks: 6};
  const includeZero = options.includeZero ?? true;
  const targetTicks = Math.max(2, Math.min(12, options.targetTicks ?? 6));
  let min = includeZero ? Math.min(0, ...finite) : Math.min(...finite);
  let max = includeZero ? Math.max(0, ...finite) : Math.max(...finite);
  if (min === max) {
    const padding = Math.max(1, Math.abs(min) * 0.2);
    min -= padding;
    max += padding;
  }
  const step = niceStep(max - min, targetTicks);
  min = Math.floor(min / step) * step;
  max = Math.ceil(max / step) * step;
  const ticks = Math.max(2, Math.min(12, Math.round((max - min) / step) + 1));
  return {min, max, ticks};
};
