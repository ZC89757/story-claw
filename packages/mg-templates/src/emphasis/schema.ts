import {
  assertFunctionEnvelope,
  functionAtSchema,
  functionGroupSchema,
  FunctionCallEnvelope,
  ResolvedFunctionCall,
} from "../function-call";
import {EmphasisSpec} from "./types";
import {assertEmphasisSpec} from "./validate";

export type EmphasisFunctionArgs = FunctionCallEnvelope & {text: string};

export const emphasisParametersSchema = {
  type: "object",
  additionalProperties: false,
  required: ["group", "at", "text"],
  properties: {
    group: functionGroupSchema,
    at: functionAtSchema,
    text: {type: "string", minLength: 1, maxLength: 16},
  },
} as const;

export const emphasisFunctionDefinition = {
  type: "function",
  name: "create_emphasis_text_cue",
  description: "为一个 <emphasis> group 创建重点文字动画。填写文字和 at。",
  strict: true,
  parameters: emphasisParametersSchema,
} as const;

export const resolveEmphasisFunctionArgs = (
  input: EmphasisFunctionArgs,
): ResolvedFunctionCall<EmphasisSpec> => {
  const envelope = assertFunctionEnvelope(input);
  return {...envelope, spec: assertEmphasisSpec({text: input.text, at: 0})};
};
