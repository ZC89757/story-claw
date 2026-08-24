import {AxisSpec, XYChartKeyframe, XYChartSpec} from "./types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const axisErrors = (axis: unknown, name: "x" | "y"): string[] => {
  if (!isRecord(axis)) return [`axes.${name} must be an object`];
  const errors: string[] = [];
  if (!isFiniteNumber(axis.min)) errors.push(`axes.${name}.min must be a finite number`);
  if (!isFiniteNumber(axis.max)) errors.push(`axes.${name}.max must be a finite number`);
  if (isFiniteNumber(axis.min) && isFiniteNumber(axis.max) && axis.max <= axis.min) {
    errors.push(`axes.${name}.max must be greater than min`);
  }
  if (typeof axis.label !== "string" || axis.label.trim().length === 0) errors.push(`axes.${name}.label is required`);
  if (typeof axis.unit !== "string") errors.push(`axes.${name}.unit must be a string`);
  if (!Number.isInteger(axis.ticks) || (axis.ticks as number) < 2 || (axis.ticks as number) > 12) {
    errors.push(`axes.${name}.ticks must be an integer between 2 and 12`);
  }
  return errors;
};

const keyframeErrors = (keyframe: unknown, index: number, axes?: {x: AxisSpec; y: AxisSpec}): string[] => {
  if (!isRecord(keyframe)) return [`keyframes[${index}] must be an object`];
  const errors: string[] = [];
  if (!isFiniteNumber(keyframe.at) || keyframe.at < 0) errors.push(`keyframes[${index}].at must be >= 0`);
  if (!isFiniteNumber(keyframe.x)) errors.push(`keyframes[${index}].x must be a finite number`);
  if (!isFiniteNumber(keyframe.y)) errors.push(`keyframes[${index}].y must be a finite number`);
  if (typeof keyframe.label !== "string" || keyframe.label.trim().length === 0) errors.push(`keyframes[${index}].label is required`);
  if (keyframe.motion !== "ease" && keyframe.motion !== "instant") errors.push(`keyframes[${index}].motion must be ease or instant`);
  if (axes && isFiniteNumber(keyframe.x) && (keyframe.x < axes.x.min || keyframe.x > axes.x.max)) {
    errors.push(`keyframes[${index}].x is outside axes.x range`);
  }
  if (axes && isFiniteNumber(keyframe.y) && (keyframe.y < axes.y.min || keyframe.y > axes.y.max)) {
    errors.push(`keyframes[${index}].y is outside axes.y range`);
  }
  return errors;
};

export const validateXYChartSpec = (input: unknown): string[] => {
  if (!isRecord(input)) return ["spec must be an object"];
  const errors: string[] = [];
  if (typeof input.title !== "string" || input.title.trim().length === 0) errors.push("title is required");
  if (!isRecord(input.axes)) {
    errors.push("axes must be an object");
    return errors;
  }
  errors.push(...axisErrors(input.axes.x, "x"), ...axisErrors(input.axes.y, "y"));
  if (!Array.isArray(input.keyframes) || input.keyframes.length === 0) {
    errors.push("keyframes must contain at least one item");
    return errors;
  }
  if (input.keyframes.length > 80) errors.push("keyframes may contain at most 80 items");

  const hasValidAxes = errors.length === 0;
  const axes = hasValidAxes ? input.axes as unknown as {x: AxisSpec; y: AxisSpec} : undefined;
  input.keyframes.forEach((keyframe, index) => errors.push(...keyframeErrors(keyframe, index, axes)));
  const typedKeyframes = input.keyframes.filter(isRecord) as unknown as XYChartKeyframe[];
  typedKeyframes.forEach((keyframe, index) => {
    if (index > 0 && isFiniteNumber(keyframe.at) && isFiniteNumber(typedKeyframes[index - 1].at) && keyframe.at <= typedKeyframes[index - 1].at) {
      errors.push(`keyframes[${index}].at must be greater than the previous keyframe time`);
    }
  });
  if (typedKeyframes[0] && isFiniteNumber(typedKeyframes[0].at) && typedKeyframes[0].at !== 0) {
    errors.push("keyframes[0].at must equal 0 so the initial state is explicit");
  }
  return errors;
};

export const assertXYChartSpec = (input: unknown): XYChartSpec => {
  const errors = validateXYChartSpec(input);
  if (errors.length > 0) throw new Error(`Invalid XYChartSpec:\n- ${errors.join("\n- ")}`);
  return input as XYChartSpec;
};
