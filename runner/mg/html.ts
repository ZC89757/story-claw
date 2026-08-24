import {createRequire} from "node:module";
import type {ArticleTimelineEntry} from "../render.js";
import type {MgTemplateName} from "@story-claw/mg-templates";
import type {LocatedMgTag, MgGroupInfo, MgMode} from "./types.js";

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
  "mg-title",
  "emphasis",
] as const;

type MgHtmlTagName = (typeof MG_TAG_NAMES)[number];

const MG_TAGS = new Set<string>(MG_TAG_NAMES);
const GROUP_PATTERN = /^[A-Za-z0-9_-]+$/;
const STYLE_ID = "story-claw-mg-annotation-style";

const MG_ANNOTATION_STYLE = `<style id="${STYLE_ID}">
:root { color-scheme: light; }
body { margin: 0; background: #f3f5f6; color: #20262c; font-family: "Microsoft YaHei", "PingFang SC", sans-serif; }
article { width: min(920px, calc(100% - 48px)); margin: 0 auto; padding: 44px 0 80px; font-size: 17px; line-height: 1.95; }
p { margin: 0 0 24px; white-space: pre-line; }
article > p:first-child { margin-bottom: 12px; font-size: 30px; font-weight: 800; line-height: 1.35; }
article progress-timeline, article timed-table, article directed-graph,
article side-by-side-comparison, article weighted-comparison, article decomposition,
article xy-chart, article multi-series-chart, article containment,
article collage-network, article mg-title, article emphasis {
  padding: 2px 4px; border-bottom: 2px solid var(--mg-accent); border-radius: 3px;
  background: var(--mg-fill); box-decoration-break: clone; -webkit-box-decoration-break: clone;
}
article progress-timeline::before, article timed-table::before, article directed-graph::before,
article side-by-side-comparison::before, article weighted-comparison::before, article decomposition::before,
article xy-chart::before, article multi-series-chart::before, article containment::before,
article collage-network::before, article mg-title::before, article emphasis::before {
  display: inline-block; margin: 0 6px 2px 0; padding: 1px 6px; border-radius: 3px;
  background: var(--mg-accent); color: #fff; font: 600 11px/1.6 Consolas, "Microsoft YaHei", sans-serif;
  vertical-align: 1px; white-space: nowrap;
}
article progress-timeline { --mg-accent: #2764c8; --mg-fill: #e9f1ff; }
article timed-table { --mg-accent: #147a52; --mg-fill: #e7f6ee; }
article directed-graph { --mg-accent: #b65a1b; --mg-fill: #fff0e5; }
article side-by-side-comparison, article weighted-comparison { --mg-accent: #7651b5; --mg-fill: #f1eafd; }
article decomposition, article containment { --mg-accent: #8a6500; --mg-fill: #fff7d8; }
article xy-chart, article multi-series-chart { --mg-accent: #087b86; --mg-fill: #e3f5f6; }
article collage-network { --mg-accent: #50606d; --mg-fill: #e9eef1; }
article mg-title { --mg-accent: #334155; --mg-fill: #e8edf2; }
article emphasis { --mg-accent: #bf3448; --mg-fill: #ffe8eb; }
article progress-timeline::before { content: "时间进度条 · " attr(group) " · " attr(mode) " · " attr(value); }
article timed-table::before { content: "动态表格 · " attr(group) " · " attr(mode) " · " attr(value); }
article directed-graph::before { content: "有向关系图 · " attr(group) " · " attr(mode) " · " attr(value); }
article side-by-side-comparison::before { content: "左右对比 · " attr(group) " · " attr(mode) " · " attr(value); }
article weighted-comparison::before { content: "加权对比 · " attr(group) " · " attr(mode) " · " attr(value); }
article decomposition::before { content: "整体拆解 · " attr(group) " · " attr(mode) " · " attr(value); }
article xy-chart::before { content: "坐标趋势图 · " attr(group) " · " attr(mode) " · " attr(value); }
article multi-series-chart::before { content: "多系列图表 · " attr(group) " · " attr(mode) " · " attr(value); }
article containment::before { content: "包含关系 · " attr(group) " · " attr(mode) " · " attr(value); }
article collage-network::before { content: "拼贴关系网 · " attr(group) " · " attr(mode) " · " attr(value); }
article mg-title::before { content: "标题动画 · " attr(group) " · " attr(mode) " · " attr(value); }
article emphasis::before { content: "重点文字 · " attr(group) " · " attr(mode) " · " attr(value); }
@media (max-width: 640px) { article { width: min(100% - 28px, 920px); padding-top: 24px; font-size: 16px; } }
</style>`;

/** AI 只产出语义标签；浏览器预览样式由代码统一注入，避免重复消耗模型输出。 */
export const decorateMgAnnotationHtml = (html: string): string => {
  if (html.includes(`id="${STYLE_ID}"`)) return html;
  if (/<\/head\s*>/i.test(html)) return html.replace(/<\/head\s*>/i, `${MG_ANNOTATION_STYLE}\n</head>`);
  const htmlOpen = /<html(?:\s[^>]*)?>/i;
  if (htmlOpen.test(html)) return html.replace(htmlOpen, (match) => `${match}\n<head>${MG_ANNOTATION_STYLE}</head>`);
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
    mode: MgMode;
    value: number;
    text: string;
    startOffset: number;
    endOffset: number;
    paragraphIndex: number;
    depth: number;
    parentGroup?: string;
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
      const group = attrs.group;
      const nextAncestors = isMg && group ? [...ancestors, group] : ancestors;
      const startOffset = relativeOffset;
      for (const child of node.childNodes ?? []) walk(child, nextAncestors);
      const endOffset = relativeOffset;
      if (!isMg) return;

      const htmlTag = node.tagName as MgHtmlTagName;
      const tag = htmlTag === "mg-title" ? "title" : htmlTag as MgTemplateName;
      const allowedAttrs = new Set(["group", "mode", "value"]);
      const unknownAttrs = Object.keys(attrs).filter((name) => !allowedAttrs.has(name));
      if (unknownAttrs.length) throw new Error(`<${htmlTag}> 包含不支持的属性: ${unknownAttrs.join(", ")}`);
      if (!group || !GROUP_PATTERN.test(group) || group.length > 80) throw new Error(`<${htmlTag}> 缺少合法 group`);
      if (attrs.mode !== "together" && attrs.mode !== "split") {
        throw new Error(`<${htmlTag}> 的 mode 必须是 together 或 split`);
      }
      const value = Number(attrs.value);
      if (!Number.isInteger(value) || value < 1) throw new Error(`<${htmlTag}> 的 value 必须是正整数`);
      if (endOffset <= startOffset || !textContent(node).trim()) throw new Error(`<${htmlTag}> 不能包裹空文本`);
      if (ancestors.includes(group)) throw new Error(`group ${group} 不能嵌套自身`);

      tags.push({
        tag,
        group,
        mode: attrs.mode,
        value,
        text: textContent(node),
        startOffset,
        endOffset,
        paragraphIndex,
        depth: ancestors.length,
        parentGroup: ancestors.at(-1),
        documentOrder: documentOrder++,
      });
    };
    for (const child of paragraph.childNodes ?? []) walk(child, []);
  });

  const byGroup = new Map<string, ParsedStructure["tags"]>();
  for (const tag of tags) {
    const current = byGroup.get(tag.group) ?? [];
    current.push(tag);
    byGroup.set(tag.group, current);
  }
  for (const [group, groupTags] of byGroup) {
    const first = groupTags[0];
    if (groupTags.some((tag) => tag.tag !== first.tag)) throw new Error(`group ${group} 混用了多个模板标签`);
    if (groupTags.some((tag) => tag.mode !== first.mode)) throw new Error(`group ${group} 的 mode 不一致`);
    if (groupTags.some((tag) => tag.parentGroup !== first.parentGroup)) throw new Error(`group ${group} 出现在不同嵌套层级`);
    if ((first.tag === "title" || first.tag === "emphasis") && groupTags.length !== 1) {
      throw new Error(`group ${group} 的 <${first.tag}> 只能出现一次`);
    }
    const values = [...groupTags].sort((a, b) => a.documentOrder - b.documentOrder).map((tag) => tag.value);
    if (values.some((value, index) => value !== index + 1)) {
      throw new Error(`group ${group} 的 value 必须按正文顺序从 1 连续编号`);
    }
  }

  return {article, paragraphs, paragraphTexts, tags};
};

export const validateMgAnnotationHtml = (html: string, articleSource: string): {groupCount: number; tagCount: number} => {
  if (!/^\s*<!doctype html>/i.test(html)) throw new Error("MG HTML 必须以 <!DOCTYPE html> 开头");
  const structure = parseStructure(html, articleSource);
  return {groupCount: new Set(structure.tags.map((tag) => tag.group)).size, tagCount: structure.tags.length};
};

export const prepareMgAnnotationHtml = (
  modelOutput: string,
  articleSource: string,
): {html: string; groupCount: number; tagCount: number} => {
  const extracted = extractMgAnnotationHtml(modelOutput);
  const rawHtml = stripMgAnnotationDecoration(extracted);
  const summary = validateMgAnnotationHtml(rawHtml, articleSource);
  const html = decorateMgAnnotationHtml(rawHtml);
  validateMgAnnotationHtml(html, articleSource);
  return {html, ...summary};
};

export const locateMgGroups = (
  html: string,
  timeline: ArticleTimelineEntry[],
  articleSource: string,
): Map<string, MgGroupInfo> => {
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

  const groups = new Map<string, MgGroupInfo>();
  for (const tag of located.sort((left, right) => left.documentOrder - right.documentOrder)) {
    const current = groups.get(tag.group);
    if (!current) {
      groups.set(tag.group, {
        tag: tag.tag,
        group: tag.group,
        mode: tag.mode,
        tags: [tag],
        paragraphEnd: tag.paragraphEnd,
        depth: tag.depth,
        parentGroup: tag.parentGroup,
      });
      continue;
    }
    current.tags.push(tag);
    current.paragraphEnd = Math.max(current.paragraphEnd, tag.paragraphEnd);
  }
  return groups;
};
