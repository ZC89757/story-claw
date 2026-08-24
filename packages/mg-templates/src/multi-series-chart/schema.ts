import {
  assertFunctionEnvelope,
  autoAxis,
  functionAtSchema,
  functionGroupSchema,
  FunctionCallEnvelope,
  ResolvedFunctionCall,
  toLocalAt,
} from "../function-call";
import {MultiSeriesChartSpec, MultiSeriesChartType} from "./types";
import {assertMultiSeriesChartSpec} from "./validate";

export type MultiSeriesChartFunctionArgs = FunctionCallEnvelope & {
  title: string;
  xAxis: {label: string; categories: string[]};
  yAxis: {label: string; unit: string};
  series: Array<{
    name: string;
    data: Array<{category: string; at: number; value: number}>;
  }>;
};

export const multiSeriesChartParametersSchema = {
  type: "object",
  additionalProperties: false,
  required: ["group", "at", "title", "xAxis", "yAxis", "series"],
  properties: {
    group: functionGroupSchema,
    at: functionAtSchema,
    title: {type: "string", minLength: 1, maxLength: 80},
    xAxis: {
      type: "object",
      additionalProperties: false,
      required: ["label", "categories"],
      properties: {
        label: {type: "string", maxLength: 40},
        categories: {type: "array", minItems: 1, maxItems: 16, items: {type: "string", minLength: 1, maxLength: 30}},
      },
    },
    yAxis: {
      type: "object",
      additionalProperties: false,
      required: ["label", "unit"],
      properties: {
        label: {type: "string", maxLength: 40},
        unit: {type: "string", maxLength: 20},
      },
    },
    series: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "data"],
        properties: {
          name: {type: "string", minLength: 1, maxLength: 40},
          data: {
            type: "array",
            minItems: 1,
            maxItems: 16,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["category", "at", "value"],
              properties: {
                category: {type: "string", minLength: 1, maxLength: 30},
                at: functionAtSchema,
                value: {type: "number"},
              },
            },
          },
        },
      },
    },
  },
} as const;

const chartDefinition = (name: string, label: string) => ({
  type: "function",
  name,
  description: `为一个 <multi-series-chart> group 创建${label}。填写标题、坐标轴、系列及每项数据的 at。`,
  strict: true,
  parameters: multiSeriesChartParametersSchema,
} as const);

export const multiSeriesBarChartFunctionDefinition = chartDefinition("create_multi_series_bar_chart", "multi-series bar chart");
export const multiSeriesLineChartFunctionDefinition = chartDefinition("create_multi_series_line_chart", "multi-series line chart");
/** @deprecated Use the explicit bar or line definition. */
export const multiSeriesChartFunctionDefinition = multiSeriesBarChartFunctionDefinition;

export const resolveMultiSeriesChartFunctionArgs = (
  input: MultiSeriesChartFunctionArgs,
  chartType: MultiSeriesChartType,
): ResolvedFunctionCall<MultiSeriesChartSpec> => {
  const envelope = assertFunctionEnvelope(input);
  const categories = input.xAxis.categories;
  if (new Set(categories).size !== categories.length) throw new Error("xAxis categories must be unique");
  const allValues = input.series.flatMap((series) => series.data.map((datum) => datum.value));
  const yAxis = autoAxis(allValues);
  const spec = assertMultiSeriesChartSpec({
    chartType,
    title: input.title,
    xAxis: input.xAxis,
    yAxis: {...yAxis, ...input.yAxis},
    series: input.series.map((series) => {
      const byCategory = new Map(series.data.map((datum) => [datum.category, datum]));
      if (byCategory.size !== series.data.length) throw new Error(`series ${series.name} contains duplicate categories`);
      return {
        name: series.name,
        data: categories.map((category) => {
          const datum = byCategory.get(category);
          if (!datum) throw new Error(`series ${series.name} is missing category ${category}`);
          return {value: datum.value, at: toLocalAt(datum.at, envelope.at)};
        }),
      };
    }),
  });
  return {...envelope, spec};
};
