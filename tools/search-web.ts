import {Type} from "@sinclair/typebox";
import type {ToolDefinition} from "@mariozechner/pi-coding-agent";
import {EnvHttpProxyAgent} from "undici";

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
  label: "搜索网页素材",
  description: "按关键词搜索真实新闻、技术博客、机构公告或专题文章，并返回页面标题、来源、摘要、网页截图地址和可用 og:image。仅在当前模板提示词要求网络素材时调用。",
  parameters: Type.Object({
    query: Type.String({description: "搜索关键词，优先包含当前动画文字和主题上下文"}),
    maxResults: Type.Optional(Type.Number({description: "最多返回几条结果，默认 6，范围 2-10"})),
  }),
  execute: async (_toolCallId: string, args: {query: string; maxResults?: number}) => {
    const query = args.query.trim();
    if (!query) return {content: [{type: "text" as const, text: "ERROR: query 不能为空"}], details: {}};
    const maxResults = Math.min(10, Math.max(2, Math.trunc(args.maxResults ?? 6)));
    try {
      const raw = await searchDuckDuckGo(query, maxResults);
      const hits = await Promise.all(raw.map(enrichHit));
      return {
        content: [{type: "text" as const, text: JSON.stringify({query, results: hits}, null, 2)}],
        details: {query, count: hits.length},
      };
    } catch (error) {
      return {content: [{type: "text" as const, text: `ERROR: ${error instanceof Error ? error.message : String(error)}`}], details: {}};
    }
  },
};
