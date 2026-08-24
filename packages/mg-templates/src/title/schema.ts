import {
  assertFunctionEnvelope,
  functionAtSchema,
  functionGroupSchema,
  FunctionCallEnvelope,
  ResolvedFunctionCall,
} from "../function-call";
import {TitleSpec} from "./types";
import {assertTitleSpec} from "./validate";

export type TitleFunctionArgs = FunctionCallEnvelope & {text: string};

export const titleParametersSchema = {
  type: "object",
  additionalProperties: false,
  required: ["group", "at", "text"],
  properties: {
    group: functionGroupSchema,
    at: functionAtSchema,
    text: {type: "string", minLength: 1, maxLength: 80},
  },
} as const;

export const titleFunctionDefinition = {
  type: "function",
  name: "create_title_cue",
  description: "为一个 <mg-title> group 创建标题动画。填写标题文字和 at。",
  strict: true,
  parameters: titleParametersSchema,
} as const;

export const resolveTitleFunctionArgs = (
  input: TitleFunctionArgs,
): ResolvedFunctionCall<TitleSpec> => {
  const envelope = assertFunctionEnvelope(input);
  return {...envelope, spec: assertTitleSpec({text: input.text, at: 0})};
};
