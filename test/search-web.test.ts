import assert from "node:assert/strict";
import test from "node:test";
import {extractReadablePage, searchWebTool} from "../tools/search-web.js";

const articleHtml = `<!doctype html><html><head>
  <title>原网页标题</title><meta property="og:title" content="网页原始报道">
  </head><body><nav>不要摘导航里的词语</nav><main><article>
  <h1>TypeSafe AI 发布 Jev</h1>
  <p>Jev <span>不生成文本</span>，而是处理另一类任务。</p>
  <p>模型的能力涉及代码分析、长任务规划以及金融数据处理。</p>
  <aside>不要摘相关推荐里的词语</aside>
  <p style="display:none">不要摘隐藏的词语</p>
  </article></main><script>不要摘脚本里的词语</script></body></html>`;

const resultText = (result: Awaited<ReturnType<typeof searchWebTool.execute>>): string => {
  const block = result.content[0];
  if (!block || block.type !== "text") throw new Error("search_web did not return text");
  return block.text;
};

test("search_web extracts selected article text, not page chrome or hidden content", () => {
  const page = extractReadablePage(articleHtml);
  assert.equal(page.title, "网页原始报道");
  assert.equal(page.source, "article");
  assert.match(page.content, /Jev 不生成文本/);
  assert.doesNotMatch(page.content, /不要摘/);
  assert.equal(page.truncated, false);
});

test("search_web URL mode returns the selected page body after a redirect", async () => {
  const previousFetch = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = String(input);
    requested.push(url);
    if (url === "https://example.org/old") {
      return new Response(null, {status: 302, headers: {location: "/story"}});
    }
    assert.equal(url, "https://example.org/story");
    return new Response(articleHtml, {headers: {"content-type": "text/html; charset=utf-8"}});
  }) as typeof fetch;
  try {
    const result = await searchWebTool.execute("read-page", {url: "https://example.org/old"}, undefined, undefined, {} as never);
    const output = JSON.parse(resultText(result)) as {url: string; content: string};
    assert.deepEqual(requested, ["https://example.org/old", "https://example.org/story"]);
    assert.equal(output.url, "https://example.org/story");
    assert.match(output.content, /Jev 不生成文本/);
    assert.doesNotMatch(output.content, /它不生成聊天文本/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("search_web retains query mode and requires exactly one of query or url", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    if (String(input).startsWith("https://html.duckduckgo.com/")) {
      return new Response(`<div class="result"><a class="result__a" href="https://example.org/story">报道</a>
        <a class="result__snippet">搜索摘要</a></div></body>`, {status: 200});
    }
    assert.equal(String(input), "https://example.org/story");
    return new Response(articleHtml, {headers: {"content-type": "text/html"}});
  }) as typeof fetch;
  try {
    const result = await searchWebTool.execute("search", {query: "Jev"}, undefined, undefined, {} as never);
    const output = JSON.parse(resultText(result)) as {query: string; results: Array<{url: string; snippet: string; content?: string}>};
    assert.equal(output.query, "Jev");
    assert.equal(output.results[0].url, "https://example.org/story");
    assert.equal(output.results[0].snippet, "搜索摘要");
    assert.equal(output.results[0].content, undefined);
  } finally {
    globalThis.fetch = previousFetch;
  }
  const invalid = await searchWebTool.execute("invalid", {query: "Jev", url: "https://example.org/story"}, undefined, undefined, {} as never);
  assert.match(resultText(invalid), /ERROR: query 和 url 必须二选一/);
  const local = await searchWebTool.execute("local", {url: "http://127.0.0.1/private"}, undefined, undefined, {} as never);
  assert.match(resultText(local), /ERROR:.*本地地址/);
});

test("search_web rejects a blocked or JavaScript-only page instead of presenting a snippet as source text", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("<html><body><div id='app'></div></body></html>", {
    headers: {"content-type": "text/html"},
  })) as typeof fetch;
  try {
    const result = await searchWebTool.execute("empty-page", {url: "https://example.org/story"}, undefined, undefined, {} as never);
    assert.match(resultText(result), /ERROR: 网页没有足够的可读取正文/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
