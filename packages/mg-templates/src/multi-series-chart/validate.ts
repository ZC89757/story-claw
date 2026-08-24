import {MultiSeriesChartSpec} from "./types";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export const validateMultiSeriesChartSpec = (input: unknown): string[] => {
  if (!isRecord(input)) return ["spec must be an object"];
  const errors: string[] = [];
  if (input.chartType !== "bar" && input.chartType !== "line") errors.push("chartType must be bar or line");
  if (typeof input.title !== "string" || !input.title.trim()) errors.push("title is required");
  if (!isRecord(input.xAxis) || !Array.isArray(input.xAxis.categories) || input.xAxis.categories.length < 1 || input.xAxis.categories.length > 16) errors.push("xAxis.categories must contain 1..16 items");
  if (!isRecord(input.yAxis)) errors.push("yAxis must be an object");
  const categoryCount = isRecord(input.xAxis) && Array.isArray(input.xAxis.categories) ? input.xAxis.categories.length : 0;
  const yMin = isRecord(input.yAxis) ? input.yAxis.min : undefined;
  const yMax = isRecord(input.yAxis) ? input.yAxis.max : undefined;
  if (typeof yMin !== "number" || typeof yMax !== "number" || !Number.isFinite(yMin) || !Number.isFinite(yMax) || yMax <= yMin) errors.push("yAxis.max must be greater than min");
  if (isRecord(input.yAxis) && (!Number.isInteger(input.yAxis.ticks) || (input.yAxis.ticks as number) < 2 || (input.yAxis.ticks as number) > 12)) errors.push("yAxis.ticks must be within 2..12");
  if (!Array.isArray(input.series) || input.series.length < 1 || input.series.length > 8) return [...errors, "series must contain 1..8 items"];
  const names = new Set<string>();
  input.series.forEach((raw, seriesIndex) => {
    if (!isRecord(raw)) return errors.push(`series[${seriesIndex}] must be an object`);
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    if (!name) errors.push(`series[${seriesIndex}].name is required`);
    if (names.has(name)) errors.push(`series[${seriesIndex}].name must be unique`);
    names.add(name);
    if (!Array.isArray(raw.data) || raw.data.length !== categoryCount) return errors.push(`series[${seriesIndex}].data length must match categories`);
    raw.data.forEach((datum, datumIndex) => {
      if (!isRecord(datum) || typeof datum.at !== "number" || datum.at < 0 || typeof datum.value !== "number" || !Number.isFinite(datum.value)) errors.push(`series[${seriesIndex}].data[${datumIndex}] is invalid`);
      else if (typeof yMin === "number" && typeof yMax === "number" && (datum.value < yMin || datum.value > yMax)) errors.push(`series[${seriesIndex}].data[${datumIndex}].value is outside yAxis range`);
    });
  });
  return errors;
};

export const assertMultiSeriesChartSpec = (input: unknown): MultiSeriesChartSpec => {
  const errors = validateMultiSeriesChartSpec(input);
  if (errors.length) throw new Error(`Invalid MultiSeriesChartSpec:\n- ${errors.join("\n- ")}`);
  return input as MultiSeriesChartSpec;
};
