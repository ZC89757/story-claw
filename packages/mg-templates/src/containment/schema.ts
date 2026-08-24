import {
  assertFunctionEnvelope,
  functionAtSchema,
  functionGroupSchema,
  FunctionCallEnvelope,
  ResolvedFunctionCall,
  toLocalAt,
} from "../function-call";
import {ContainmentSpec} from "./types";
import {assertContainmentSpec} from "./validate";

export type ContainmentFunctionArgs = FunctionCallEnvelope & {
  title: string;
  root: string;
  relations: Array<{at: number; parent: string; child: string}>;
  highlights: Array<{at: number; target: string}>;
};

const concept = {type: "string", minLength: 1, maxLength: 50} as const;

export const containmentParametersSchema = {
  type: "object",
  additionalProperties: false,
  required: ["group", "at", "title", "root", "relations", "highlights"],
  properties: {
    group: functionGroupSchema,
    at: functionAtSchema,
    title: {type: "string", minLength: 1, maxLength: 80},
    root: concept,
    relations: {
      type: "array",
      minItems: 1,
      maxItems: 40,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["at", "parent", "child"],
        properties: {at: functionAtSchema, parent: concept, child: concept},
      },
    },
    highlights: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["at", "target"],
        properties: {at: functionAtSchema, target: concept},
      },
    },
  },
} as const;

export const containmentFunctionDefinition = {
  type: "function",
  name: "create_containment_timeline",
  description: "为一个 <containment> group 创建包含关系动画。填写标题、根节点及带 at 的父子关系和高亮。",
  strict: true,
  parameters: containmentParametersSchema,
} as const;

export const resolveContainmentFunctionArgs = (
  input: ContainmentFunctionArgs,
): ResolvedFunctionCall<ContainmentSpec> => {
  const envelope = assertFunctionEnvelope(input);
  const events = [
    ...input.relations.map((relation) => ({
      action: "contain" as const,
      parent: relation.parent,
      child: relation.child,
      at: toLocalAt(relation.at, envelope.at),
    })),
    ...input.highlights.map((highlight) => ({
      action: "highlight" as const,
      target: highlight.target,
      at: toLocalAt(highlight.at, envelope.at),
    })),
  ].sort((left, right) => left.at - right.at);
  const spec = assertContainmentSpec({title: input.title, root: input.root, events});
  return {...envelope, spec};
};
