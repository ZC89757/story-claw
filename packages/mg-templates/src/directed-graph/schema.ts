import {
  assertFunctionEnvelope,
  functionAtSchema,
  functionGroupSchema,
  FunctionCallEnvelope,
  ResolvedFunctionCall,
  toLocalAt,
} from "../function-call";
import {DirectedGraphSpec} from "./types";
import {assertDirectedGraphSpec} from "./validate";

export type DirectedGraphFunctionArgs = FunctionCallEnvelope & {
  title: string;
  edges: Array<{at: number; from: string; to: string; relation: string}>;
};

export const directedGraphParametersSchema = {
  type: "object",
  additionalProperties: false,
  required: ["group", "at", "title", "edges"],
  properties: {
    group: functionGroupSchema,
    at: functionAtSchema,
    title: {type: "string", minLength: 1, maxLength: 80},
    edges: {
      type: "array",
      minItems: 1,
      maxItems: 40,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["at", "from", "to", "relation"],
        properties: {
          at: functionAtSchema,
          from: {type: "string", minLength: 1, maxLength: 50},
          to: {type: "string", minLength: 1, maxLength: 50},
          relation: {type: "string", minLength: 1, maxLength: 80},
        },
      },
    },
  },
} as const;

export const directedGraphFunctionDefinition = {
  type: "function",
  name: "create_directed_graph_timeline",
  description: "为一个 <directed-graph> group 创建有向关系图。填写标题及按 at 出现的关系边。",
  strict: true,
  parameters: directedGraphParametersSchema,
} as const;

export const resolveDirectedGraphFunctionArgs = (
  input: DirectedGraphFunctionArgs,
): ResolvedFunctionCall<DirectedGraphSpec> => {
  const envelope = assertFunctionEnvelope(input);
  const spec = assertDirectedGraphSpec({
    title: input.title,
    edges: input.edges.map((edge) => ({...edge, at: toLocalAt(edge.at, envelope.at)})),
  });
  return {...envelope, spec};
};
