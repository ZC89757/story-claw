import {createRequire} from "node:module";
import type {ArticleTimelineEntry} from "../render.js";
import {
  isMgStyleForTemplate,
  mgInstanceKey,
  mgStylesForTemplate,
  type MgTemplateName,
} from "@story-claw/mg-templates";
import type {LocatedMgTag, MgInstanceInfo, MgMode} from "./types.js";

const require = createRequire(import.meta.url);
const parse5 = require("parse5") as {parse(input: string): HtmlNode};

type HtmlNode = {
  nodeName?: string;
  tagName?: string;
  value?: string;
  attrs?: Array<{name: string; value: string}>;
  childNodes?: HtmlNode[];
};

export const MG_TAG_NAMES = [
  "progress-timeline",
  "timed-table",
  "directed-graph",
  "side-by-side-comparison",
  "weighted-comparison",
  "decomposition",
  "xy-chart",
  "multi-series-chart",
  "containment",
  "collage-network",
  "image-stack",
  "image-grid",
  "mg-title",
  "emphasis",
  "mg-showcase",
  "mg-metric",
  "mg-transition",
  "mg-rhythm",
  "mg-effect",
  "mg-camera",
] as const;

type MgHtmlTagName = (typeof MG_TAG_NAMES)[number];

const MG_TAGS = new Set<string>(MG_TAG_NAMES);
const GROUP_PATTERN = /^[A-Za-z0-9_-]+$/;
const STYLE_ID = "story-claw-mg-annotation-style";

// HTML uses descriptive `mg-*` names while the renderer and catalog use the
// corresponding internal template names. Keep this mapping explicit so every
// newly introduced structural tag follows the same path through validation,
// timeline location, and Function Calling.
const TEMPLATE_BY_HTML_TAG: Readonly<Record<MgHtmlTagName, MgTemplateName>> = Object.freeze({
  "progress-timeline": "progress-timeline",
  "timed-table": "timed-table",
  "directed-graph": "directed-graph",
  "side-by-side-comparison": "side-by-side-comparison",
  "weighted-comparison": "weighted-comparison",
  decomposition: "decomposition",
  "xy-chart": "xy-chart",
  "multi-series-chart": "multi-series-chart",
  containment: "containment",
  "collage-network": "collage-network",
  "image-stack": "image-stack",
  "image-grid": "image-grid",
  "mg-title": "title",
  emphasis: "emphasis",
  "mg-showcase": "showcase",
  "mg-metric": "metric",
  "mg-transition": "transition",
  "mg-rhythm": "rhythm",
  "mg-effect": "effect",
  "mg-camera": "camera",
});

const MG_DISPLAY_LABELS: Record<MgHtmlTagName, string> = Object.freeze({
  "progress-timeline": "时间进度",
  "timed-table": "动态表格",
  "directed-graph": "有向关系图",
  "side-by-side-comparison": "左右对比",
  "weighted-comparison": "加权对比",
  decomposition: "整体拆解",
  "xy-chart": "坐标趋势图",
  "multi-series-chart": "多系列图表",
  containment: "包含关系",
  "collage-network": "拼贴关系网",
  "image-stack": "图片叠加",
  "image-grid": "图片并列",
  "mg-title": "标题动画",
  emphasis: "重点大字",
  "mg-showcase": "界面陈列",
  "mg-metric": "指标动画",
  "mg-transition": "转场",
  "mg-rhythm": "节拍强调",
  "mg-effect": "视觉效果",
  "mg-camera": "运镜",
});

const annotationContent = (
  tag: MgHtmlTagName,
  ordered: boolean,
  withValue: boolean,
): string => [
  `"${MG_DISPLAY_LABELS[tag]},group=" attr(group)`,
  ordered ? `",order=" attr(order)` : "",
  `",mode=" attr(mode)`,
  withValue ? `",value=" attr(value)` : "",
].filter(Boolean).join(" ");

const collectMgInstanceCounts = (html: string): Map<string, {tag: MgHtmlTagName; order?: number; count: number}> => {
  const counts = new Map<string, {tag: MgHtmlTagName; order?: number; count: number}>();
  const document = parse5.parse(html);
  const visit = (node: HtmlNode): void => {
    const tag = node.tagName && MG_TAGS.has(node.tagName) ? node.tagName as MgHtmlTagName : undefined;
    if (tag) {
      const attrs = Object.fromEntries((node.attrs ?? []).map((attr) => [attr.name, attr.value]));
      const order = attrs.order === undefined ? undefined : Number(attrs.order);
      const key = `${tag}|${order ?? ""}`;
      const current = counts.get(key);
      if (current) current.count++;
      else counts.set(key, {tag, ...(order === undefined ? {} : {order}), count: 1});
    }
    for (const child of node.childNodes ?? []) visit(child);
  };
  visit(document);
  return counts;
};

const annotationRules = (html: string): string => [...collectMgInstanceCounts(html).values()]
  .map((instance) => {
    const selector = instance.order === undefined
      ? `article ${instance.tag}:not([order])::before`
      : `article ${instance.tag}[order="${instance.order}"]::before`;
    return `${selector} { content: ${annotationContent(instance.tag, instance.order !== undefined, instance.count > 1)}; }`;
  })
  .join("\n");

const buildMgAnnotationStyle = (html: string): string => `<style id="${STYLE_ID}">
:root { color-scheme: light; }
body { margin: 0; background: #f3f5f6; color: #20262c; font-family: "Microsoft YaHei", "PingFang SC", sans-serif; }
article { width: min(920px, calc(100% - 48px)); margin: 0 auto; padding: 44px 0 80px; font-size: 17px; line-height: 1.95; }
p { margin: 0 0 24px; white-space: pre-line; }
article > p:first-child { margin-bottom: 12px; font-size: 30px; font-weight: 800; line-height: 1.35; }
article progress-timeline, article timed-table, article directed-graph,
article side-by-side-comparison, article weighted-comparison, article decomposition,
article xy-chart, article multi-series-chart, article containment,
article collage-network, article image-stack, article image-grid,
article mg-title, article emphasis, article mg-showcase, article mg-metric,
article mg-transition, article mg-rhythm, article mg-effect, article mg-camera {
  padding: 2px 4px; border-bottom: 2px solid var(--mg-accent); border-radius: 3px;
  background: var(--mg-fill); box-decoration-break: clone; -webkit-box-decoration-break: clone;
}
article progress-timeline::before, article timed-table::before, article directed-graph::before,
article side-by-side-comparison::before, article weighted-comparison::before, article decomposition::before,
article xy-chart::before, article multi-series-chart::before, article containment::before,
article collage-network::before, article image-stack::before, article image-grid::before,
article mg-title::before, article emphasis::before, article mg-showcase::before,
article mg-metric::before, article mg-transition::before, article mg-rhythm::before,
article mg-effect::before, article mg-camera::before {
  display: inline-block; margin: 0 6px 2px 0; padding: 1px 6px; border-radius: 3px;
  background: var(--mg-accent); color: #fff; font: 600 10px/1.5 Consolas, "Microsoft YaHei", sans-serif;
  vertical-align: 1px; white-space: normal; overflow-wrap: anywhere;
}
article progress-timeline { --mg-accent: #2764c8; --mg-fill: #e9f1ff; }
article timed-table { --mg-accent: #147a52; --mg-fill: #e7f6ee; }
article directed-graph { --mg-accent: #b65a1b; --mg-fill: #fff0e5; }
article side-by-side-comparison, article weighted-comparison { --mg-accent: #7651b5; --mg-fill: #f1eafd; }
article decomposition, article containment { --mg-accent: #8a6500; --mg-fill: #fff7d8; }
article xy-chart, article multi-series-chart { --mg-accent: #087b86; --mg-fill: #e3f5f6; }
article collage-network { --mg-accent: #50606d; --mg-fill: #e9eef1; }
article image-stack { --mg-accent: #9a4d2f; --mg-fill: #fbece5; }
article image-grid { --mg-accent: #2f718f; --mg-fill: #e5f3f8; }
article mg-title { --mg-accent: #334155; --mg-fill: #e8edf2; }
article emphasis { --mg-accent: #bf3448; --mg-fill: #ffe8eb; }
article mg-showcase { --mg-accent: #2d7586; --mg-fill: #e3f3f5; }
article mg-metric { --mg-accent: #4f6f9c; --mg-fill: #e8eef8; }
article mg-transition { --mg-accent: #b34d32; --mg-fill: #fff0e8; }
article mg-rhythm { --mg-accent: #8c3d76; --mg-fill: #f7e8f1; }
article mg-effect { --mg-accent: #bf632f; --mg-fill: #fff0e5; }
article mg-camera { --mg-accent: #176d7a; --mg-fill: #e3f4f6; }
${annotationRules(html)}
@media (max-width: 640px) { article { width: min(100% - 28px, 920px); padding-top: 24px; font-size: 16px; } }
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

const descendants = (node: HtmlNode, predicate: (candidate: HtmlNode) => boolean): HtmlNode[] => {
  const found: HtmlNode[] = [];
  const visit = (candidate: HtmlNode) => {
    if (predicate(candidate)) found.push(candidate);
    for (const child of candidate.childNodes ?? []) visit(child);
  };
  visit(node);
  return found;
};

const attrsOf = (node: HtmlNode): Record<string, string> =>
  Object.fromEntries((node.attrs ?? []).map((attr) => [attr.name, attr.value]));

const sourceParagraphs = (articleSource: string): string[] =>
  articleSource
    .replace(/\r\n/g, "\n")
    .trim()
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

type ParsedStructure = {
  article: HtmlNode;
  paragraphs: HtmlNode[];
  paragraphTexts: string[];
  tags: Array<{
    tag: MgTemplateName;
    group: string;
    order?: number;
    instanceKey: string;
    mode: MgMode;
    value: number;
    text: string;
    startOffset: number;
    endOffset: number;
    paragraphIndex: number;
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
  for (const child of article.childNodes ?? []) {
    if (child.nodeName === "#text" && !(child.value ?? "").trim()) continue;
    if (child.tagName !== "p") throw new Error("MG HTML 的 article 只能直接包含正文 p 段落");
  }
  const paragraphs = descendants(article, (node) => node.tagName === "p");
  const paragraphTexts = paragraphs.map((paragraph) => textContent(paragraph).trim());
  const expectedParagraphs = sourceParagraphs(articleSource);
  if (paragraphTexts.length !== expectedParagraphs.length) {
    throw new Error(`MG HTML 段落数 ${paragraphTexts.length} 与原文 ${expectedParagraphs.length} 不一致`);
  }
  for (let index = 0; index < expectedParagraphs.length; index++) {
    if (paragraphTexts[index] !== expectedParagraphs[index]) {
      throw new Error(`MG HTML 第 ${index + 1} 段去标签后与原文不一致`);
    }
  }

  const allMgNodes = descendants(document, (node) => Boolean(node.tagName && MG_TAGS.has(node.tagName)));
  const articleMgNodes = descendants(article, (node) => Boolean(node.tagName && MG_TAGS.has(node.tagName)));
  if (allMgNodes.length !== articleMgNodes.length) throw new Error("MG 标签只能出现在 article 正文中");

  const tags: ParsedStructure["tags"] = [];
  let documentOrder = 0;
  paragraphs.forEach((paragraph, paragraphIndex) => {
    let relativeOffset = 0;
    const walk = (node: HtmlNode, ancestors: string[]) => {
      if (node.nodeName === "#text") {
        relativeOffset += (node.value ?? "").length;
        return;
      }
      const isMg = Boolean(node.tagName && MG_TAGS.has(node.tagName));
      if (node.tagName && !isMg) throw new Error(`MG HTML 正文包含不支持的标签 <${node.tagName}>`);
      const attrs = isMg ? attrsOf(node) : {};
      const htmlTag = isMg ? node.tagName as MgHtmlTagName : undefined;
      const tag = htmlTag ? TEMPLATE_BY_HTML_TAG[htmlTag] : undefined;
      const group = attrs.group;
      const order = attrs.order === undefined ? undefined : Number(attrs.order);
      const instanceKey = tag ? mgInstanceKey(tag, order) : undefined;
      const nextAncestors = instanceKey ? [...ancestors, instanceKey] : ancestors;
      const currentDocumentOrder = isMg ? documentOrder++ : -1;
      const startOffset = relativeOffset;
      for (const child of node.childNodes ?? []) walk(child, nextAncestors);
      const endOffset = relativeOffset;
      if (!isMg) return;

      const allowedAttrs = new Set(["group", "order", "mode", "value"]);
      const unknownAttrs = Object.keys(attrs).filter((name) => !allowedAttrs.has(name));
      if (unknownAttrs.length) throw new Error(`<${htmlTag}> 包含不支持的属性: ${unknownAttrs.join(", ")}`);
      if (!group || !GROUP_PATTERN.test(group) || group.length > 80) throw new Error(`<${htmlTag}> 缺少合法 group`);
      if (!isMgStyleForTemplate(tag!, group)) {
        const allowed = mgStylesForTemplate(tag!).map((style) => style.style).join(", ");
        throw new Error(`<${htmlTag}> 的 group 样式 ${group} 不可用，可选: ${allowed}`);
      }
      if (attrs.order !== undefined && (!Number.isInteger(order) || order! < 1 || order! > 999)) {
        throw new Error(`<${htmlTag}> 的 order 必须是 1-999 的正整数`);
      }
      if (attrs.mode !== "together" && attrs.mode !== "split") {
        throw new Error(`<${htmlTag}> 的 mode 必须是 together 或 split`);
      }
      const value = Number(attrs.value);
      if (!Number.isInteger(value) || value < 1) throw new Error(`<${htmlTag}> 的 value 必须是正整数`);
      if (endOffset <= startOffset || !textContent(node).trim()) throw new Error(`<${htmlTag}> 不能包裹空文本`);
      if (ancestors.includes(instanceKey!)) throw new Error(`动画实例 ${instanceKey} 不能嵌套自身`);

      tags.push({
        tag: tag!,
        group,
        ...(order === undefined ? {} : {order}),
        instanceKey: instanceKey!,
        mode: attrs.mode,
        value,
        text: textContent(node),
        startOffset,
        endOffset,
        paragraphIndex,
        depth: ancestors.length,
        parentInstance: ancestors.at(-1),
        documentOrder: currentDocumentOrder,
      });
    };
    for (const child of paragraph.childNodes ?? []) walk(child, []);
  });

  const byTemplate = new Map<MgTemplateName, ParsedStructure["tags"]>();
  for (const tag of tags) {
    const current = byTemplate.get(tag.tag) ?? [];
    current.push(tag);
    byTemplate.set(tag.tag, current);
  }
  for (const [template, templateTags] of byTemplate) {
    const hasOrder = templateTags.some((tag) => tag.order !== undefined);
    if (hasOrder && templateTags.some((tag) => tag.order === undefined)) {
      throw new Error(`<${template}> 存在多个实例时，所有同类标签都必须填写 order`);
    }
    if (!hasOrder) continue;
    const orders = [...new Set(
      [...templateTags]
        .sort((left, right) => left.documentOrder - right.documentOrder)
        .map((tag) => tag.order!),
    )];
    if (orders.length < 2) throw new Error(`<${template}> 只有一个实例时不应填写 order`);
    if (orders.some((orderValue, index) => orderValue !== index + 1)) {
      throw new Error(`<${template}> 的 order 必须按首次出现顺序从 1 连续编号`);
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
      throw new Error(`${instanceKey} 出现在不同嵌套层级`);
    }
    if ((first.tag === "title" || first.tag === "emphasis") && instanceTags.length !== 1) {
      throw new Error(`${instanceKey} 的 <${first.tag}> 只能出现一次`);
    }
    const values = [...instanceTags].sort((a, b) => a.documentOrder - b.documentOrder).map((tag) => tag.value);
    if (values.some((value, index) => value !== index + 1)) {
      throw new Error(`${instanceKey} 的 value 必须按正文顺序从 1 连续编号`);
    }
  }

  return {article, paragraphs, paragraphTexts, tags};
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
  const timelineText = timeline.map((entry) => entry.char).join("");
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

  const paragraphOffsets: number[] = [];
  let timelineCursor = 0;
  for (const paragraphText of structure.paragraphTexts) {
    const offset = timelineText.indexOf(paragraphText, timelineCursor);
    if (offset < 0) throw new Error(`正文段落无法映射到字级时间轴: ${paragraphText.slice(0, 40)}`);
    paragraphOffsets.push(offset);
    timelineCursor = offset + paragraphText.length;
  }

  const located: LocatedMgTag[] = structure.tags.map((tag) => {
    const paragraphOffset = paragraphOffsets[tag.paragraphIndex];
    const paragraphText = structure.paragraphTexts[tag.paragraphIndex];
    const startEntry = entryAtOffset(paragraphOffset + tag.startOffset);
    const endEntry = entryAtOffset(paragraphOffset + tag.endOffset - 1);
    const paragraphEnd = entryAtOffset(paragraphOffset + paragraphText.length - 1).end;
    return {...tag, start: startEntry.start, end: endEntry.end, paragraphEnd};
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
      });
      continue;
    }
    current.tags.push(tag);
    current.paragraphEnd = Math.max(current.paragraphEnd, tag.paragraphEnd);
  }
  return instances;
};
