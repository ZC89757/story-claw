import {
  assertFunctionEnvelope,
  autoAxis,
  functionAtSchema,
  functionGroupSchema,
  FunctionCallEnvelope,
  ResolvedFunctionCall,
  toLocalAt,
} from "../function-call";
import {XYChartSpec} from "./types";
import {assertXYChartSpec} from "./validate";

export type XYChartFunctionArgs = FunctionCallEnvelope & {
  title: string;
  axes: {
    x: {label: string; unit: string};
    y: {label: string; unit: string};
  };
  keyframes: Array<{at: number; x: number; y: number; label: string}>;
};

const axisSchema = {
  type: "object",
  additionalProperties: false,
  required: ["label", "unit"],
  properties: {
    label: {type: "string", minLength: 1, maxLength: 40},
    unit: {type: "string", maxLength: 20},
  },
} as const;

export const xyChartParametersSchema = {
  type: "object",
  additionalProperties: false,
  required: ["group", "at", "title", "axes", "keyframes"],
  properties: {
    group: functionGroupSchema,
    at: functionAtSchema,
    title: {type: "string", minLength: 1, maxLength: 80},
    axes: {
      type: "object",
      additionalProperties: false,
      required: ["x", "y"],
      properties: {x: axisSchema, y: axisSchema},
    },
    keyframes: {
      type: "array",
      minItems: 1,
      maxItems: 80,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["at", "x", "y", "label"],
        properties: {
          at: functionAtSchema,
          x: {type: "number"},
          y: {type: "number"},
          label: {type: "string", minLength: 1, maxLength: 80},
        },
      },
    },
  },
} as const;

export const xyChartFunctionDefinition = {
  type: "function",
  name: "create_xy_chart_timeline",
  description: "为一个 <xy-chart> group 创建坐标趋势图。填写标题、坐标轴含义及带 at 的数据关键帧。",
  strict: true,
  parameters: xyChartParametersSchema,
} as const;

export const resolveXYChartFunctionArgs = (
  input: XYChartFunctionArgs,
): ResolvedFunctionCall<XYChartSpec> => {
  const envelope = assertFunctionEnvelope(input);
  const xValues = input.keyframes.map((point) => point.x);
  const xAxis = autoAxis(xValues, {
    includeZero: false,
    targetTicks: Math.max(2, new Set(xValues).size),
  });
  const yAxis = autoAxis(input.keyframes.map((point) => point.y));
  const spec = assertXYChartSpec({
    title: input.title,
    axes: {
      x: {...xAxis, ...input.axes.x},
      y: {...yAxis, ...input.axes.y},
    },
    keyframes: input.keyframes.map((point, index) => ({
      ...point,
      at: toLocalAt(point.at, envelope.at),
      motion: index === 0 ? "instant" as const : "ease" as const,
    })),
  });
  return {...envelope, spec};
};
