import {createRequire} from "node:module";
import net from "node:net";
import {Type} from "@sinclair/typebox";
import type {ToolDefinition} from "@mariozechner/pi-coding-agent";
import {EnvHttpProxyAgent} from "undici";

const require = createRequire(import.meta.url);
const parse5 = require("parse5") as {parse(input: string): HtmlNode};

type HtmlNode = {
  nodeName?: string;
  tagName?: string;
  value?: string;
  attrs?: Array<{name: string; value: string}>;
  childNodes?: HtmlNode[];
};

const MAX_PAGE_HTML_BYTES = 4_000_000;
const MAX_PAGE_TEXT_CHARS = 20_000;
const SKIP_TAGS = new Set(["script", "style", "noscript", "template", "svg", "nav", "footer", "aside"]);
const TEXT_BLOCK_TAGS = new Set(["h1", "h2", "h3", "h4", "p", "li", "blockquote"]);

// Node's native fetch does not consistently honor HTTP(S)_PROXY.  The image
// selection step often runs through the same local proxy as the image API, so
// use one shared dispatcher for both search and metadata requests.
const fetchDispatcher = new EnvHttpProxyAgent();
const fetchWithProxy = (input: string | URL, init: RequestInit = {}) =>
  fetch(input, {...init, dispatcher: fetchDispatcher} as RequestInit);

type SearchHit = {
  title: string;
  url: string;
  snippet?: string;
  imageUrl?: string;
  screenshotUrl: string;
};

const decodeHtml = (value: string): string => value
  .replace(/&amp;/g, "&")
  .replace(/&quot;/g, '"')
  .replace(/&#x27;/g, "'")
  .replace(/&#39;/g, "'")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">");

const decodeUrl = (value: string): string => {
  const raw = decodeHtml(value);
  const match = raw.match(/[?&]uddg=([^&]+)/i);
  try { return decodeURIComponent(match?.[1] ?? raw); } catch { return raw; }
};

const attr = (html: string, name: string): string | undefined => {
  const match = html.match(new RegExp(`<meta\\b[^>]*\\b(?:property|name)=["']${name}["'][^>]*\\bcontent=["']([^"']+)["'][^>]*>`, "i"))
    ?? html.match(new RegExp(`<meta\\b[^>]*\\bcontent=["']([^"']+)["'][^>]*\\b(?:property|name)=["']${name}["'][^>]*>`, "i"));
  return match?.[1] ? decodeHtml(match[1]) : undefined;
};

const screenshotUrlFor = (url: string): string => `https://image.thum.io/get/width/1280/crop/900/noanimate/${url}`;

const nodeAttr = (node: HtmlNode, name: string): string | undefined =>
  node.attrs?.find((item) => item.name === name)?.value;

const isHiddenNode = (node: HtmlNode): boolean =>
  Boolean(node.tagName && (
    SKIP_TAGS.has(node.tagName)
    || nodeAttr(node, "hidden") !== undefined
    || nodeAttr(node, "aria-hidden") === "true"
    || /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\b/i.test(nodeAttr(node, "style") ?? "")
  ));

const nodeText = (node: HtmlNode): string => {
  if (isHiddenNode(node)) return "";
  if (node.nodeName === "#text") return node.value ?? "";
  return (node.childNodes ?? []).map(nodeText).join("");
};

const textBlocks = (root: HtmlNode): string[] => {
  const blocks: string[] = [];
  const visit = (node: HtmlNode): void => {
    if (isHiddenNode(node)) return;
    if (node.tagName && TEXT_BLOCK_TAGS.has(node.tagName)) {
      const text = nodeText(node).trim();
      if (text) blocks.push(text);
      return;
    }
    for (const child of node.childNodes ?? []) visit(child);
  };
  visit(root);
  return blocks;
};

/** Preserve the source text inside each block, so a short phrase can be copied verbatim. */
export const extractReadablePage = (html: string): {title: string; content: string; totalCharacters: number; truncated: boolean; source: string} => {
  const document = parse5.parse(html);
  const candidates: Array<{node: HtmlNode; source: string}> = [];
  const visit = (node: HtmlNode): void => {
    if (isHiddenNode(node)) return;
    if (node.tagName === "article") candidates.push({node, source: "article"});
    else if (nodeAttr(node, "role") === "main" || node.tagName === "main") candidates.push({node, source: "main"});
    else if (node.tagName === "body") candidates.push({node, source: "body"});
    for (const child of node.childNodes ?? []) visit(child);
  };
  visit(document);
  const ranked = candidates
    .map(({node, source}) => ({node, source, blocks: textBlocks(node)}))
    .sort((left, right) => {
      const priority = (source: string): number => source === "article" ? 2 : source === "main" ? 1 : 0;
      return priority(right.source) - priority(left.source)
        || right.blocks.join("").length - left.blocks.join("").length;
    });
  const selected = ranked.find((item) => item.blocks.join("").trim().length >= 80) ?? ranked[0];
  if (!selected) throw new Error("网页没有可读取的正文");
  const fullText = selected.blocks.length ? selected.blocks.join("\n\n") : nodeText(selected.node).trim();
  if (fullText.trim().length < 40) throw new Error("网页没有足够的可读取正文；可能需要 JavaScript 或被网站拦截，请换一篇报道");
  const titleNode = ((): HtmlNode | undefined => {
    const find = (node: HtmlNode): HtmlNode | undefined =>
      node.tagName === "title" ? node : (node.childNodes ?? []).map(find).find(Boolean);
    return find(document);
  })();
  return {
    title: attr(html, "og:title") ?? (titleNode ? nodeText(titleNode).trim() : ""),
    content: fullText.slice(0, MAX_PAGE_TEXT_CHARS),
    totalCharacters: fullText.length,
    truncated: fullText.length > MAX_PAGE_TEXT_CHARS,
    source: selected.source,
  };
};

const pageUrl = (value: string): string => {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("url 必须是有效的 http(s) 网页地址"); }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password
    || !hostname || hostname === "localhost" || hostname.endsWith(".localhost")
    || hostname.endsWith(".local") || net.isIP(hostname) !== 0) {
    throw new Error("url 必须是公开的 http(s) 网页地址，不能是本地地址或 IP 地址");
  }
  return url.href;
};

const responseHtml = async (response: Response): Promise<string> => {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("网页响应没有正文");
  const decoder = new TextDecoder();
  let html = "";
  let size = 0;
  while (true) {
    const {value, done} = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_PAGE_HTML_BYTES) {
      await reader.cancel();
      throw new Error("网页正文过大，无法完整读取");
    }
    html += decoder.decode(value, {stream: true});
  }
  return html + decoder.decode();
};

const readWebPage = async (inputUrl: string) => {
  let url = pageUrl(inputUrl);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetchWithProxy(url, {
      headers: {"user-agent": "StoryClaw/1.0 web-search"},
      signal: AbortSignal.timeout(30_000),
      redirect: "manual",
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`网页跳转缺少目标地址: ${url}`);
      url = pageUrl(new URL(location, url).href);
      continue;
    }
    if (!response.ok) throw new Error(`网页读取失败: HTTP ${response.status}`);
    if (!/^(?:text\/html|application\/xhtml\+xml)\b/i.test(response.headers.get("content-type") ?? "")) {
      throw new Error("该 URL 没有返回 HTML 网页，请换用报道原文地址");
    }
    const page = extractReadablePage(await responseHtml(response));
    return {url, ...page};
  }
  throw new Error("网页跳转次数过多");
};

const searchDuckDuckGo = async (query: string, maxResults: number): Promise<Array<{title: string; url: string; snippet?: string}>> => {
  const response = await fetchWithProxy(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: {"user-agent": "StoryClaw/1.0 web-search"},
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`web search failed: ${response.status}`);
  const html = await response.text();
  const hits: Array<{title: string; url: string; snippet?: string}> = [];
  const blockPattern = /<div[^>]+class=["'][^"']*result[^"']*["'][^>]*>([\s\S]*?)(?=<div[^>]+class=["'][^"']*result[^"']|<\/body>)/gi;
  for (const block of html.matchAll(blockPattern)) {
    const body = block[1];
    const link = body.match(/<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const url = decodeUrl(link[1]);
    if (!/^https?:\/\//i.test(url)) continue;
    const title = decodeHtml(link[2].replace(/<[^>]+>/g, "").trim());
    const snippet = body.match(/<a[^>]+class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/a>/i)?.[1]
      ?? body.match(/<div[^>]+class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1];
    hits.push({title, url, snippet: snippet ? decodeHtml(snippet.replace(/<[^>]+>/g, "").trim()) : undefined});
    if (hits.length >= maxResults) break;
  }
  return hits;
};

const enrichHit = async (hit: {title: string; url: string; snippet?: string}): Promise<SearchHit> => {
  let title = hit.title;
  let imageUrl: string | undefined;
  try {
    const response = await fetchWithProxy(hit.url, {
      headers: {"user-agent": "StoryClaw/1.0 web-search"},
      signal: AbortSignal.timeout(20_000),
    });
    if (response.ok && /^text\/html/i.test(response.headers.get("content-type") ?? "")) {
      const html = await response.text();
      title = attr(html, "og:title") ?? title;
      imageUrl = attr(html, "og:image") ?? attr(html, "twitter:image");
    }
  } catch {
    // Search results remain useful when an article blocks metadata fetching.
  }
  return {title, url: hit.url, snippet: hit.snippet, ...(imageUrl ? {imageUrl} : {}), screenshotUrl: screenshotUrlFor(hit.url)};
};

export const searchWebTool: ToolDefinition = {
  name: "search_web",
  label: "搜索或读取网页素材",
  description: "传 query 搜索真实网页，返回标题、摘要、网页截图地址和 og:image；选择报道后再传 url 读取那一页的正文，复制其逐字短语。query 和 url 只能填写一个；无法读取正文时不要将搜索摘要冒充网页原文。仅在当前模板提示词要求网络素材时调用。",
  parameters: Type.Object({
    query: Type.Optional(Type.String({description: "搜索关键词；与 url 二选一。优先包含当前动画文字和主题上下文"})),
    url: Type.Optional(Type.String({description: "已选中的报道原文 URL；与 query 二选一，用于读取网页正文"})),
    maxResults: Type.Optional(Type.Number({description: "最多返回几条结果，默认 6，范围 2-10"})),
  }),
  execute: async (_toolCallId: string, args: {query?: string; url?: string; maxResults?: number}) => {
    const query = args.query?.trim();
    const url = args.url?.trim();
    if (Boolean(query) === Boolean(url)) {
      return {content: [{type: "text" as const, text: "ERROR: query 和 url 必须二选一"}], details: {}};
    }
    try {
      if (url) {
        const page = await readWebPage(url);
        return {
          content: [{type: "text" as const, text: JSON.stringify(page, null, 2)}],
          details: {url: page.url, totalCharacters: page.totalCharacters, truncated: page.truncated},
        };
      }
      const maxResults = Math.min(10, Math.max(2, Math.trunc(args.maxResults ?? 6)));
      const searchQuery = query!;
      const raw = await searchDuckDuckGo(searchQuery, maxResults);
      const hits = await Promise.all(raw.map(enrichHit));
      return {
        content: [{type: "text" as const, text: JSON.stringify({query: searchQuery, results: hits}, null, 2)}],
        details: {query: searchQuery, count: hits.length},
      };
    } catch (error) {
      return {content: [{type: "text" as const, text: `ERROR: ${error instanceof Error ? error.message : String(error)}`}], details: {}};
    }
  },
};
