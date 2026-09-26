import {createRequire} from "node:module";
import type {ArticleTimelineEntry} from "../render.js";
import {loadMgTemplateProvider} from "../../utils/mg-template-runtime.js";
import type {DirectedGraphAnnotation, LocatedMgTag, MgInstanceInfo, MgMode} from "./types.js";

const require = createRequire(import.meta.url);
const parse5 = require("parse5") as {parse(input: string): HtmlNode};

type HtmlNode = {
  nodeName?: string;
  tagName?: string;
  value?: string;
  attrs?: Array<{name: string; value: string}>;
  childNodes?: HtmlNode[];
};

const mgProvider = await loadMgTemplateProvider();
export const MG_TAG_NAMES = mgProvider.templates.map((template) => template.htmlTag);
const MG_TAGS = new Set<string>(MG_TAG_NAMES);
const GROUP_PATTERN = /^[A-Za-z0-9_-]+$/;
const STYLE_ID = "story-claw-mg-annotation-style";
const SC_VIDEO_TAG = "sc-video";
const SC_LONGTAKE_TAG = "sc-longtake";
const MG_VALUE_TAG = "mg-value";

const isScVideo = (tag: string | undefined): boolean => tag === SC_VIDEO_TAG;
const isScLongtake = (tag: string | undefined): boolean => tag === SC_LONGTAKE_TAG;
const isGeneratedVideoTag = (tag: string | undefined): boolean => isScVideo(tag) || isScLongtake(tag);

const parseValuesAttribute = (tag: string, raw: string | undefined): string[] => {
  if (raw === undefined) throw new Error(`<${tag}> 的 values 必须是 JSON 字符串数组`);
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error(`<${tag}> 的 values 不是合法 JSON`); }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`<${tag}> 的 values 必须是非空字符串数组`);
  }
  const values = parsed as string[];
  if (new Set(values).size !== values.length) throw new Error(`<${tag}> 的 values 不允许重复词语`);
  return values;
};

const parseDirectedGraphTopology = (attrs: Record<string, string>): DirectedGraphAnnotation | undefined => {
  const hasNodes = attrs.nodes !== undefined;
  const hasEdges = attrs.edges !== undefined;
  if (!hasNodes && !hasEdges) return undefined;
  if (!hasNodes || !hasEdges) throw new Error("<directed-graph> 的 nodes 和 edges 必须同时提供");

  let rawNodes: unknown;
  let rawEdges: unknown;
  try {
    rawNodes = JSON.parse(attrs.nodes);
    rawEdges = JSON.parse(attrs.edges);
  } catch {
    throw new Error("<directed-graph> 的 nodes/edges 必须是合法 JSON");
  }
  if (!Array.isArray(rawNodes) || rawNodes.length < 1 || rawNodes.length > 40
    || rawNodes.some((node) => typeof node !== "string" || !node.trim() || node.length > 80)) {
    throw new Error("<directed-graph> 的 nodes 必须是 1-40 个非空字符串");
  }
  const nodes = rawNodes.map((node) => String(node).trim());
  if (new Set(nodes).size !== nodes.length) throw new Error("<directed-graph> 的 nodes 不允许重复");
  if (!Array.isArray(rawEdges) || rawEdges.length < 1 || rawEdges.length > 40
    || rawEdges.some((edge) => !Array.isArray(edge) || edge.length !== 2
      || !Number.isInteger(edge[0]) || !Number.isInteger(edge[1]))) {
    throw new Error("<directed-graph> 的 edges 必须是 1-40 个 [from,to] 整数对");
  }
  const edgeKeys = new Set<string>();
  const edges = rawEdges.map((edge) => {
    const from = Number(edge[0]);
    const to = Number(edge[1]);
    if (from < 0 || from >= nodes.length || to < 0 || to >= nodes.length) {
      throw new Error("<directed-graph> 的 edges 节点索引超出 nodes 范围");
    }
    if (from === to) throw new Error("<directed-graph> 的 edges 不能连接节点自身");
    const key = `${from}:${to}`;
    if (edgeKeys.has(key)) throw new Error("<directed-graph> 的 edges 不允许重复方向");
    edgeKeys.add(key);
    return [from, to] as const;
  });
  return {nodes, edges};
};

const annotationContent = (
  tag: string,
  ordered: boolean,
  withValue: boolean,
): string => [
  `"${tag},group=" attr(group)`,
  ordered ? `",order=" attr(order)` : "",
  isGeneratedVideoTag(tag) ? "" : `",mode=" attr(mode)`,
  !isGeneratedVideoTag(tag) && withValue ? `",value=" attr(value)` : "",
].filter(Boolean).join(" ");

const collectMgInstanceCounts = (html: string): Map<string, {tag: string; group: string; order?: number; count: number}> => {
  const counts = new Map<string, {tag: string; group: string; order?: number; count: number}>();
  const document = parse5.parse(html);
  const visit = (node: HtmlNode): void => {
      const tag = node.tagName && MG_TAGS.has(node.tagName) ? node.tagName : undefined;
      if (tag) {
        const attrs = Object.fromEntries((node.attrs ?? []).map((attr) => [attr.name, attr.value]));
        const group = attrs.group ?? "";
        const order = attrs.order === undefined ? undefined : Number(attrs.order);
        const key = mgProvider.instanceKey({htmlTag: tag, group, order});
        const current = counts.get(key);
        if (current) current.count++;
        else counts.set(key, {tag, group, ...(order === undefined ? {} : {order}), count: 1});
    }
    for (const child of node.childNodes ?? []) visit(child);
  };
  visit(document);
  return counts;
};

const annotationRules = (html: string): string => [...collectMgInstanceCounts(html).values()]
  .map((instance) => {
    const selector = instance.order === undefined
      ? `article ${instance.tag}[group="${instance.group}"]:not([order])::before`
      : `article ${instance.tag}[group="${instance.group}"][order="${instance.order}"]::before`;
    return `${selector} { content: ${annotationContent(instance.tag, instance.order !== undefined, instance.count > 1)}; }`;
  })
  .join("\n");

const tagSelectors = (suffix = ""): string => MG_TAG_NAMES.map((tag) => `article ${tag}${suffix}`).join(",\n");
const annotationPalette = [
  ["#2764c8", "#e9f1ff"], ["#147a52", "#e7f6ee"], ["#b65a1b", "#fff0e5"],
  ["#7651b5", "#f1eafd"], ["#8a6500", "#fff7d8"], ["#087b86", "#e3f5f6"],
  ["#50606d", "#e9eef1"], ["#9a4d2f", "#fbece5"],
] as const;
const tagColorRules = (): string => MG_TAG_NAMES.map((tag, index) => {
  const [accent, fill] = annotationPalette[index % annotationPalette.length];
  return `article ${tag} { --mg-accent: ${accent}; --mg-fill: ${fill}; }`;
}).join("\n");

const buildMgAnnotationStyle = (html: string): string => `<style id="${STYLE_ID}">
:root { color-scheme: light; }
body { margin: 0; background: #f3f5f6; color: #20262c; font-family: "Microsoft YaHei", "PingFang SC", sans-serif; }
article { padding: 24px; white-space: pre-wrap; }
${tagSelectors()} {
  border-bottom: 2px solid var(--mg-accent); background: var(--mg-fill);
  box-decoration-break: clone; -webkit-box-decoration-break: clone;
}
article ai-hot-focus-stage {
  border-bottom: 0;
  background: linear-gradient(to bottom, transparent calc(100% - 2px), var(--mg-accent) 0), var(--mg-fill);
  box-decoration-break: clone; -webkit-box-decoration-break: clone;
}
article mg-value {
  padding: 1px 3px; border-bottom: 0;
  background: linear-gradient(to bottom, transparent calc(100% - 2px), var(--mg-accent) 0),
    color-mix(in srgb, var(--mg-accent) 24%, white);
  box-decoration-break: clone; -webkit-box-decoration-break: clone;
}
${tagSelectors("::before")} {
  display: inline-block; margin: 0 6px 2px 0; padding: 1px 6px; border-radius: 3px;
  background: var(--mg-accent); color: #fff; font: 600 10px/1.5 Consolas, "Microsoft YaHei", sans-serif;
  vertical-align: 1px; white-space: normal; overflow-wrap: anywhere;
}
${tagColorRules()}
${annotationRules(html)}
</style>`;

/** AI 只产出语义标签；浏览器预览样式由代码统一注入，避免重复消耗模型输出。 */
export const decorateMgAnnotationHtml = (html: string): string => {
  const style = buildMgAnnotationStyle(html);
  const existingStyle = new RegExp(`<style\\b(?=[^>]*\\bid=["']${STYLE_ID}["'])[^>]*>[\\s\\S]*?<\\/style>`, "i");
  if (existingStyle.test(html)) return html.replace(existingStyle, style);
  if (/<\/head\s*>/i.test(html)) return html.replace(/<\/head\s*>/i, `${style}\n</head>`);
  const htmlOpen = /<html(?:\s[^>]*)?>/i;
  if (htmlOpen.test(html)) return html.replace(htmlOpen, (match) => `${match}\n<head>${style}</head>`);
  return html;
};

/** 移除审核页的代码注入样式，让 AI 只接触和修改语义 HTML。 */
export const stripMgAnnotationDecoration = (html: string): string =>
  html.replace(
    /<style\b(?=[^>]*\bid=["']story-claw-mg-annotation-style["'])[^>]*>[\s\S]*?<\/style>\s*/gi,
    "",
  );

export const extractMgAnnotationHtml = (output: string): string => {
  const start = output.search(/<!doctype html>/i);
  const endMatches = output.matchAll(/<\/html\s*>/ig);
  let end = -1;
  for (const match of endMatches) end = (match.index ?? -1) + match[0].length;
  if (start < 0 || end <= start) throw new Error("AI 输出中找不到完整 HTML 文档");
  return `${output.slice(start, end).trim()}\n`;
};

const textContent = (node: HtmlNode): string => {
  if (node.nodeName === "#text") return node.value ?? "";
  return (node.childNodes ?? []).map(textContent).join("");
};

const attrsOf = (node: HtmlNode): Record<string, string> =>
  Object.fromEntries((node.attrs ?? []).map((attr) => [attr.name, attr.value]));

const descendants = (node: HtmlNode, predicate: (candidate: HtmlNode) => boolean): HtmlNode[] => {
  const found: HtmlNode[] = [];
  const visit = (candidate: HtmlNode) => {
    if (predicate(candidate)) found.push(candidate);
    for (const child of candidate.childNodes ?? []) visit(child);
  };
  visit(node);
  return found;
};

const normalizeSourceText = (value: string): string => value.replace(/\r\n?/g, "\n").trim();
const timelineText = (value: string): string => normalizeSourceText(value).replace(/\n/g, "");

type ParsedStructure = {
  article: HtmlNode;
  articleText: string;
  tags: Array<{
    tag: string;
    group: string;
    order?: number;
    instanceKey: string;
    mode: MgMode;
    value?: number;
    values?: string[];
    valueAnchors?: Array<{value: number; text: string; startOffset: number; endOffset: number}>;
    graph?: DirectedGraphAnnotation;
    text: string;
    startOffset: number;
    endOffset: number;
    depth: number;
    parentInstance?: string;
    documentOrder: number;
  }>;
};

const parseStructure = (html: string, articleSource: string): ParsedStructure => {
  const document = parse5.parse(html);
  const executableNodes = descendants(document, (node) => node.tagName === "script");
  if (executableNodes.length) throw new Error("MG HTML 不允许包含 script");
  const stylesheetLinks = descendants(document, (node) => (
    node.tagName === "link" && attrsOf(node).rel?.toLowerCase() === "stylesheet"
  ));
  if (stylesheetLinks.length) throw new Error("MG HTML 不允许引用外部样式");
  const inlineStyledNodes = descendants(document, (node) => (
    (node.attrs ?? []).some((attr) => attr.name.toLowerCase() === "style")
  ));
  if (inlineStyledNodes.length) throw new Error("MG HTML 不允许包含内联 style 属性");
  const styleNodes = descendants(document, (node) => node.tagName === "style");
  if (styleNodes.some((node) => attrsOf(node).id !== STYLE_ID)) {
    throw new Error("MG HTML 的审核样式只能由代码注入");
  }
  const articles = descendants(document, (node) => node.tagName === "article");
  if (articles.length !== 1) throw new Error(`MG HTML 必须且只能包含一个 article，当前 ${articles.length} 个`);
  const article = articles[0];
  const bodies = descendants(document, (node) => node.tagName === "body");
  if (bodies.length !== 1) throw new Error("MG HTML 必须包含一个 body");
  for (const child of bodies[0].childNodes ?? []) {
    if (child.nodeName === "#text" && !(child.value ?? "").trim()) continue;
    if (child !== article) throw new Error("MG HTML 的 body 只能直接包含 article 正文");
  }
  const heads = descendants(document, (node) => node.tagName === "head");
  for (const child of heads[0]?.childNodes ?? []) {
    if (child.nodeName === "#text" && !(child.value ?? "").trim()) continue;
    if (["meta", "title", "style"].includes(child.tagName ?? "")) continue;
    throw new Error("MG HTML 的 head 包含不支持的页面元素");
  }
  const articleText = normalizeSourceText(textContent(article));
  if (articleText !== normalizeSourceText(articleSource)) {
    throw new Error("MG HTML 去标签后的全文与原文不一致");
  }

  const allMgNodes = descendants(document, (node) => Boolean(node.tagName && MG_TAGS.has(node.tagName)));
  const articleMgNodes = descendants(article, (node) => Boolean(node.tagName && MG_TAGS.has(node.tagName)));
  if (allMgNodes.length !== articleMgNodes.length) throw new Error("MG 标签只能出现在 article 正文中");

  const tags: ParsedStructure["tags"] = [];
  let documentOrder = 0;
  let relativeOffset = 0;
  const walk = (node: HtmlNode, ancestors: string[], markerSink?: Array<{value: number; text: string; startOffset: number; endOffset: number}>) => {
      if (node.nodeName === "#text") {
        relativeOffset += timelineText(node.value ?? "").length;
        return;
      }
      if (node.tagName === MG_VALUE_TAG) {
        const attrs = attrsOf(node);
        const value = Number(attrs.value);
        if (Object.keys(attrs).some((name) => name !== "value") || !markerSink || !Number.isInteger(value) || value < 1) {
          throw new Error(`<${MG_VALUE_TAG}> 必须位于 together 标签内且只使用正整数 value`);
        }
        const startOffset = relativeOffset;
        for (const child of node.childNodes ?? []) walk(child, ancestors, markerSink);
        const endOffset = relativeOffset;
        const text = textContent(node);
        if (!text.trim()) throw new Error(`<${MG_VALUE_TAG}> 不能包裹空文本`);
        markerSink.push({value, text, startOffset, endOffset});
        return;
      }
      const isMg = Boolean(node.tagName && MG_TAGS.has(node.tagName));
      if (node.tagName && !isMg) throw new Error(`MG HTML 正文包含不支持的原生标签 <${node.tagName}>`);
      const attrs = isMg ? attrsOf(node) : {};
      const htmlTag = isMg ? node.tagName : undefined;
      const group = attrs.group;
      const order = attrs.order === undefined ? undefined : Number(attrs.order);
      const instanceKey = htmlTag && group ? mgProvider.instanceKey({htmlTag, group, order}) : undefined;
      const nextAncestors = instanceKey ? [...ancestors, instanceKey] : ancestors;
      const currentDocumentOrder = isMg ? documentOrder++ : -1;
      const startOffset = relativeOffset;
      const ownMarkers: Array<{value: number; text: string; startOffset: number; endOffset: number}> = [];
      for (const child of node.childNodes ?? []) walk(child, nextAncestors, isMg ? ownMarkers : markerSink);
      const endOffset = relativeOffset;
      if (!isMg) return;

      const generatedVideo = isGeneratedVideoTag(htmlTag);
      const graphTag = htmlTag === "directed-graph";
      const allowedAttrs = new Set(generatedVideo
        ? ["group", "order"]
        : ["group", "order", "mode", "value", "values", ...(graphTag ? ["nodes", "edges"] : [])]);
      const unknownAttrs = Object.keys(attrs).filter((name) => !allowedAttrs.has(name));
      if (unknownAttrs.length) throw new Error(`<${htmlTag}> 包含不支持的属性: ${unknownAttrs.join(", ")}`);
      if (!group || !GROUP_PATTERN.test(group) || group.length > 80) throw new Error(`<${htmlTag}> 缺少合法 group`);
      if (!mgProvider.supportsGroup(htmlTag!, group)) {
        const allowed = mgProvider.templates.find((template) => template.htmlTag === htmlTag)?.groups.join(", ") ?? "";
        throw new Error(`<${htmlTag}> 的 group 样式 ${group} 不可用，可选: ${allowed}`);
      }
      if (attrs.order !== undefined && (!Number.isInteger(order) || order! < 1 || order! > 999)) {
        throw new Error(`<${htmlTag}> 的 order 必须是 1-999 的正整数`);
      }
      if (!generatedVideo && attrs.mode !== "together" && attrs.mode !== "split") {
        throw new Error(`<${htmlTag}> 的 mode 必须是 together 或 split`);
      }
      if (isScVideo(htmlTag) && group !== "normal") throw new Error(`<${htmlTag}> 目前只允许 group=normal`);
      if (isScLongtake(htmlTag) && group !== "relay") throw new Error(`<${htmlTag}> 目前只允许 group=relay`);
      const value = generatedVideo ? 1 : (attrs.value === undefined ? undefined : Number(attrs.value));
      const values = !generatedVideo
        && attrs.mode === "together"
        && attrs.values !== undefined
        ? parseValuesAttribute(htmlTag!, attrs.values)
        : undefined;
      const valueAnchors = ownMarkers.length ? [...ownMarkers].sort((left, right) => left.value - right.value) : undefined;
      if (valueAnchors && valueAnchors.some((anchor, index) => anchor.value !== index + 1)) {
        throw new Error(`<${htmlTag}> 的 mg-value 必须按正文顺序从 1 连续编号`);
      }
      if (valueAnchors && JSON.stringify(valueAnchors.map((anchor) => anchor.text)) !== JSON.stringify(values ?? [])) {
        throw new Error(`<${htmlTag}> 的 mg-value 文本和顺序必须与 values 完全一致`);
      }
      const graph = graphTag ? parseDirectedGraphTopology(attrs) : undefined;
      if (graphTag && !graph) throw new Error("<directed-graph> 必须提供已审核的 nodes 和 edges");
      if (!generatedVideo && attrs.mode === "split" && (value === undefined || !Number.isInteger(value) || value < 1)) throw new Error(`<${htmlTag}> 的 split value 必须是正整数`);
      if (!generatedVideo && attrs.mode === "split" && attrs.values !== undefined) throw new Error(`<${htmlTag}> 的 split 不允许使用 values`);
      if (!generatedVideo && attrs.mode === "together" && attrs.value !== undefined) throw new Error(`<${htmlTag}> 的 together 不允许使用 value`);
      if (values && values.some((item) => !textContent(node).includes(item))) throw new Error(`<${htmlTag}> 的 values 必须逐字出现在标签正文中`);
      if (endOffset <= startOffset || !textContent(node).trim()) throw new Error(`<${htmlTag}> 不能包裹空文本`);
      if (ancestors.includes(instanceKey!)) throw new Error(`动画实例 ${instanceKey} 不能嵌套自身`);

      const mode: MgMode = generatedVideo ? "together" : attrs.mode as MgMode;
      tags.push({
        tag: htmlTag!,
        group,
        ...(order === undefined ? {} : {order}),
        instanceKey: instanceKey!,
        mode,
        ...(value === undefined ? {} : {value}),
        ...(values ? {values} : {}),
        ...(valueAnchors ? {valueAnchors} : {}),
        ...(graph ? {graph} : {}),
        text: textContent(node),
        startOffset,
        endOffset,
        depth: ancestors.length,
        parentInstance: ancestors.at(-1),
        documentOrder: currentDocumentOrder,
      });
  };
  for (const child of article.childNodes ?? []) walk(child, []);

  const byTemplateGroup = new Map<string, ParsedStructure["tags"]>();
  for (const tag of tags) {
    const key = `${tag.tag}::${tag.group}`;
    const current = byTemplateGroup.get(key) ?? [];
    current.push(tag);
    byTemplateGroup.set(key, current);
  }
  for (const [, templateTags] of byTemplateGroup) {
    const firstTag = templateTags[0];
    const hasOrder = templateTags.some((tag) => tag.order !== undefined);
    if (hasOrder && templateTags.some((tag) => tag.order === undefined)) {
      throw new Error(`<${firstTag.tag} group=${firstTag.group}> 存在多个实例时，所有同类标签都必须填写 order`);
    }
    if (!hasOrder) continue;
    const orders = [...new Set(
      [...templateTags]
        .sort((left, right) => left.documentOrder - right.documentOrder)
        .map((tag) => tag.order!),
    )];
    if (orders.length < 2) throw new Error(`<${firstTag.tag} group=${firstTag.group}> 只有一个实例时不应填写 order`);
    if (orders.some((orderValue, index) => orderValue !== index + 1)) {
      throw new Error(`<${firstTag.tag} group=${firstTag.group}> 的 order 必须按首次出现顺序从 1 连续编号`);
    }
  }

  const byInstance = new Map<string, ParsedStructure["tags"]>();
  for (const tag of tags) {
    const current = byInstance.get(tag.instanceKey) ?? [];
    current.push(tag);
    byInstance.set(tag.instanceKey, current);
  }
  for (const [instanceKey, instanceTags] of byInstance) {
    const first = instanceTags[0];
    if (instanceTags.some((tag) => tag.group !== first.group)) throw new Error(`${instanceKey} 的 group 样式不一致`);
    if (instanceTags.some((tag) => tag.mode !== first.mode)) throw new Error(`${instanceKey} 的 mode 不一致`);
    if (instanceTags.some((tag) => tag.parentInstance !== first.parentInstance)) {
      throw new Error(`${instanceKey} 出现在不同父实例；这些是独立实例，必须用连续 order 区分`);
    }
    if (instanceTags.some((tag) => JSON.stringify(tag.graph ?? null) !== JSON.stringify(first.graph ?? null))) {
      throw new Error(`${instanceKey} 的 directed-graph 拓扑不一致`);
    }
    mgProvider.validateAnnotatedInstance({htmlTag: first.tag, tagCount: instanceTags.length});
    const values = [...instanceTags].sort((a, b) => a.documentOrder - b.documentOrder).map((tag) => tag.value);
    if (!isGeneratedVideoTag(first.tag) && first.mode === "split" && values.some((value, index) => value !== index + 1)) {
      throw new Error(`${instanceKey} 的 value 必须按正文顺序从 1 连续编号`);
    }
  }
  return {article, articleText, tags};
};

export const validateMgAnnotationHtml = (html: string, articleSource: string): {instanceCount: number; tagCount: number} => {
  if (!/^\s*<!doctype html>/i.test(html)) throw new Error("MG HTML 必须以 <!DOCTYPE html> 开头");
  const structure = parseStructure(html, articleSource);
  return {instanceCount: new Set(structure.tags.map((tag) => tag.instanceKey)).size, tagCount: structure.tags.length};
};

export const prepareMgAnnotationHtml = (
  modelOutput: string,
  articleSource: string,
): {html: string; instanceCount: number; tagCount: number} => {
  const extracted = extractMgAnnotationHtml(modelOutput);
  const rawHtml = stripMgAnnotationDecoration(extracted);
  const summary = validateMgAnnotationHtml(rawHtml, articleSource);
  const html = decorateMgAnnotationHtml(rawHtml);
  validateMgAnnotationHtml(html, articleSource);
  return {html, ...summary};
};

export const locateMgInstances = (
  html: string,
  timeline: ArticleTimelineEntry[],
  articleSource: string,
): Map<string, MgInstanceInfo> => {
  const structure = parseStructure(html, articleSource);
  if (!timeline.length) throw new Error("字级时间轴为空，无法规划 MG");
  const fullTimelineText = timeline.map((entry) => entry.char).join("");
  if (fullTimelineText !== timelineText(structure.articleText)) {
    throw new Error("MG HTML 全文无法与字级时间轴逐字对应");
  }
  const charOffsets: number[] = [];
  let charCursor = 0;
  timeline.forEach((entry) => {
    charOffsets.push(charCursor);
    charCursor += entry.char.length;
  });
  const entryAtOffset = (offset: number): ArticleTimelineEntry => {
    let low = 0;
    let high = timeline.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const start = charOffsets[middle];
      const end = start + timeline[middle].char.length;
      if (offset < start) high = middle - 1;
      else if (offset >= end) low = middle + 1;
      else return timeline[middle];
    }
    throw new Error(`时间轴字符偏移越界: ${offset}`);
  };

  const located: LocatedMgTag[] = structure.tags.map((tag) => {
    const startEntry = entryAtOffset(tag.startOffset);
    const endEntry = entryAtOffset(tag.endOffset - 1);
    const paragraphEnd = endEntry.end;
    const valueAnchors = tag.valueAnchors?.map((anchor) => ({
      value: anchor.value,
      text: anchor.text,
      start: entryAtOffset(anchor.startOffset).start,
      end: entryAtOffset(anchor.endOffset - 1).end,
    }));
    const {valueAnchors: _rawAnchors, ...baseTag} = tag;
    return {...baseTag, ...(valueAnchors ? {valueAnchors} : {}), start: startEntry.start, end: endEntry.end, paragraphEnd};
  });

  const instances = new Map<string, MgInstanceInfo>();
  for (const tag of located.sort((left, right) => left.documentOrder - right.documentOrder)) {
    const current = instances.get(tag.instanceKey);
    if (!current) {
      instances.set(tag.instanceKey, {
        instanceKey: tag.instanceKey,
        tag: tag.tag,
        group: tag.group,
        ...(tag.order === undefined ? {} : {order: tag.order}),
        mode: tag.mode,
        tags: [tag],
        paragraphEnd: tag.paragraphEnd,
        depth: tag.depth,
        parentInstance: tag.parentInstance,
        ...(tag.graph ? {graph: tag.graph} : {}),
      });
      continue;
    }
    current.tags.push(tag);
    current.paragraphEnd = Math.max(current.paragraphEnd, tag.paragraphEnd);
  }
  return instances;
};
