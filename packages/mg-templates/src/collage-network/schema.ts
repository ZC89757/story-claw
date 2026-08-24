import {
  assertFunctionEnvelope,
  functionAtSchema,
  functionGroupSchema,
  FunctionCallEnvelope,
  ResolvedFunctionCall,
  toLocalAt,
} from "../function-call";
import {CollageNetworkEdgeType, CollageNetworkNodeKind, CollageNetworkSpec} from "./types";
import {assertCollageNetworkSpec} from "./validate";

const shortText = {type: "string", minLength: 1, maxLength: 80} as const;
const nodeId = {type: "string", minLength: 1, maxLength: 40, pattern: "^[A-Za-z0-9_-]+$"} as const;

export type CollageNetworkFunctionArgs = FunctionCallEnvelope & {
  title: string;
  subtitle: string;
  nodes: Array<{id: string; label: string; at: number; role: string}>;
  edges: Array<{at: number; from: string; to: string; relation: string}>;
};

export type CollageAssetResolver = (node: {id: string; label: string; role: string}) => string | undefined;

export type CollageNetworkResolveOptions = {
  resolveAsset?: CollageAssetResolver;
};

export const collageNetworkParametersSchema = {
  type: "object",
  additionalProperties: false,
  required: ["group", "at", "title", "subtitle", "nodes", "edges"],
  properties: {
    group: functionGroupSchema,
    at: functionAtSchema,
    title: shortText,
    subtitle: {type: "string", minLength: 1, maxLength: 120},
    nodes: {
      type: "array",
      minItems: 2,
      maxItems: 10,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "label", "at", "role"],
        properties: {id: nodeId, label: shortText, at: functionAtSchema, role: shortText},
      },
    },
    edges: {
      type: "array",
      minItems: 1,
      maxItems: 30,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["at", "from", "to", "relation"],
        properties: {at: functionAtSchema, from: nodeId, to: nodeId, relation: shortText},
      },
    },
  },
} as const;

export const collageNetworkFunctionDefinition = {
  type: "function",
  name: "create_collage_network",
  description: "为一个 <collage-network> group 创建拼贴关系网络。填写实体、角色及带 at 的关系。实体 id 使用稳定的 ASCII 标识。",
  strict: true,
  parameters: collageNetworkParametersSchema,
} as const;

const inferNodeKind = (node: {label: string; role: string}, index: number): CollageNetworkNodeKind => {
  const text = `${node.label} ${node.role}`.toLowerCase();
  if (/(芯片|算力|tpu|gpu|nvidia|英伟达)/i.test(text)) return "chip";
  if (/(云|平台|azure|aws|cloud)/i.test(text)) return "cloud";
  return (["model", "cloud", "chip"] as const)[index % 3];
};

const inferEdgeType = (relation: string, index: number): CollageNetworkEdgeType => {
  if (/(竞争|对抗|挑战|替代)/.test(relation)) return "competition";
  if (/(投资|持股|收购)/.test(relation)) return "investment";
  if (/(云|平台|部署|托管)/.test(relation)) return "cloud";
  if (/(芯片|算力|供应|训练)/.test(relation)) return "supply";
  return (["investment", "cloud", "supply", "competition"] as const)[index % 4];
};

export const resolveCollageNetworkFunctionArgs = (
  input: CollageNetworkFunctionArgs,
  options: CollageNetworkResolveOptions = {},
): ResolvedFunctionCall<CollageNetworkSpec> => {
  const envelope = assertFunctionEnvelope(input);
  const spec = assertCollageNetworkSpec({
    title: input.title,
    subtitle: input.subtitle,
    nodes: input.nodes.map((node, index) => ({
      ...node,
      at: toLocalAt(node.at, envelope.at),
      assetSrc: options.resolveAsset?.(node),
      kind: inferNodeKind(node, index),
    })),
    edges: input.edges.map((edge, index) => ({
      ...edge,
      at: toLocalAt(edge.at, envelope.at),
      type: inferEdgeType(edge.relation, index),
    })),
  });
  return {...envelope, spec};
};
