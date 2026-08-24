import assert from "node:assert/strict";
import test from "node:test";
import type {ArticleTimelineEntry} from "../render.js";
import {
  decorateMgAnnotationHtml,
  locateMgGroups,
  prepareMgAnnotationHtml,
  stripMgAnnotationDecoration,
  validateMgAnnotationHtml,
} from "./html.js";
import {compileMgScenes, selectMgFunctionDefinitions} from "./planner.js";
import {resolveMgFunctionCall} from "./registry.js";
import type {LocatedMgTag, MgGroupInfo, MgMode, MgVideoInfo} from "./types.js";

const article = [
  "谷歌从搜索入口走向AI基础设施。",
  "底层是芯片，中间是模型，上层是应用。",
].join("\n\n");

const html = `<!DOCTYPE html>
<html><body><article>
<p>谷歌从<progress-timeline group="history" mode="split" value="1">搜索入口</progress-timeline>走向<progress-timeline group="history" mode="split" value="2">AI基础设施</progress-timeline>。</p>
<p><decomposition group="stack" mode="together" value="1">底层是<emphasis group="chip" mode="together" value="1">芯片</emphasis>，中间是模型，上层是应用</decomposition>。</p>
</article></body></html>`;

const buildTimeline = (source: string): ArticleTimelineEntry[] =>
  [...source.replace(/\n+/g, "")].map((char, index) => ({
    index,
    char,
    group_order: 0,
    start: Number((index * 0.1).toFixed(3)),
    end: Number(((index + 1) * 0.1).toFixed(3)),
  }));

test("MG HTML preserves clean text and locates nested groups on the real timeline", () => {
  assert.deepEqual(validateMgAnnotationHtml(html, article), {groupCount: 3, tagCount: 4});
  const groups = locateMgGroups(html, buildTimeline(article), article);
  assert.equal(groups.get("history")?.mode, "split");
  assert.deepEqual(groups.get("history")?.tags.map((tag) => tag.value), [1, 2]);
  assert.equal(groups.get("chip")?.parentGroup, "stack");
  assert.equal(groups.get("chip")?.depth, 1);
  assert.ok((groups.get("history")?.tags[1].start ?? 0) > (groups.get("history")?.tags[0].end ?? 0));
});

test("MG HTML rejects at because timestamps belong to Function Calling", () => {
  const invalid = html.replace(
    'group="history" mode="split" value="1"',
    'group="history" mode="split" value="1" at="0.1"',
  );
  assert.throws(() => validateMgAnnotationHtml(invalid, article), /不支持的属性: at/);
});

test("MG HTML rejects text or formatting markup outside the executable tag protocol", () => {
  const extraText = html.replace("</article>", "额外说明</article>");
  assert.throws(() => validateMgAnnotationHtml(extraText, article), /article 只能直接包含正文 p/);
  const formatting = html.replace("搜索入口", "<strong>搜索入口</strong>");
  assert.throws(() => validateMgAnnotationHtml(formatting, article), /不支持的标签 <strong>/);
});

test("single-cue templates cannot reuse one group for multiple tags", () => {
  const source = "搜索广告仍是基本盘，但AI正在冲击基本盘。";
  const invalid = `<!DOCTYPE html><html><body><article><p>` +
    `<emphasis group="risk" mode="split" value="1">搜索广告</emphasis>仍是基本盘，` +
    `但AI正在冲击<emphasis group="risk" mode="split" value="2">基本盘</emphasis>。` +
    `</p></article></body></html>`;
  assert.throws(() => validateMgAnnotationHtml(invalid, source), /<emphasis> 只能出现一次/);
});

test("mg-title is executable markup and native title is rejected in article text", () => {
  const source = "谷歌的第二次创业";
  const valid = `<!DOCTYPE html><html><body><article><p>` +
    `<mg-title group="heading" mode="together" value="1">${source}</mg-title>` +
    `</p></article></body></html>`;
  assert.deepEqual(validateMgAnnotationHtml(valid, source), {groupCount: 1, tagCount: 1});
  assert.equal(locateMgGroups(valid, buildTimeline(source), source).get("heading")?.tag, "title");

  const native = valid.replaceAll("mg-title", "title");
  assert.throws(() => validateMgAnnotationHtml(native, source));
});

test("annotation viewer styles expose Chinese labels without changing article text", () => {
  const decorated = decorateMgAnnotationHtml(html);
  assert.match(decorated, /id="story-claw-mg-annotation-style"/);
  assert.match(decorated, /动态表格/);
  assert.deepEqual(validateMgAnnotationHtml(decorated, article), {groupCount: 3, tagCount: 4});
  assert.equal(decorateMgAnnotationHtml(decorated), decorated);
});

test("annotation preparation removes viewer decoration before restoring canonical styles", () => {
  const decorated = decorateMgAnnotationHtml(html);
  const stripped = stripMgAnnotationDecoration(decorated);
  assert.doesNotMatch(stripped, /story-claw-mg-annotation-style/);
  const prepared = prepareMgAnnotationHtml(`说明文字\n${decorated}\n结束`, article);
  assert.deepEqual(
    {groupCount: prepared.groupCount, tagCount: prepared.tagCount},
    {groupCount: 3, tagCount: 4},
  );
  assert.match(prepared.html, /id="story-claw-mg-annotation-style"/);
  assert.deepEqual(validateMgAnnotationHtml(prepared.html, article), {groupCount: 3, tagCount: 4});
});

test("annotation preparation rejects model-owned CSS, scripts, and changed article text", () => {
  assert.throws(
    () => prepareMgAnnotationHtml(html.replace("<body>", "<head><style>body{color:red}</style></head><body>"), article),
    /审核样式只能由代码注入/,
  );
  assert.throws(
    () => prepareMgAnnotationHtml(html.replace("<body>", "<body><script>alert(1)</script>"), article),
    /不允许包含 script/,
  );
  assert.throws(
    () => prepareMgAnnotationHtml(html.replace("搜索入口", "搜索产品"), article),
    /去标签后与原文不一致/,
  );
  assert.throws(
    () => prepareMgAnnotationHtml(html.replace("</article>", "</article><iframe src=\"https://example.com\"></iframe>"), article),
    /body 只能直接包含 article/,
  );
});

test("Function Calling receives only schemas used by the HTML tags", () => {
  const definitions = selectMgFunctionDefinitions([
    "timed-table",
    "multi-series-chart",
    "emphasis",
  ]);
  assert.deepEqual(
    new Set(definitions.map((definition) => definition.name)),
    new Set([
      "create_timed_table",
      "create_emphasis_text_cue",
      "create_multi_series_bar_chart",
      "create_multi_series_line_chart",
    ]),
  );
  assert.equal(definitions.length, 4);
});

const makeTag = (
  mode: MgMode,
  value: number,
  start: number,
  end: number,
): LocatedMgTag => ({
  tag: "progress-timeline",
  group: "history",
  mode,
  value,
  text: value === 1 ? "1998年创办" : "2023年推出Gemini",
  start,
  end,
  paragraphEnd: 12,
  depth: 0,
  documentOrder: value - 1,
});

const makeGroup = (mode: MgMode): MgGroupInfo => ({
  tag: "progress-timeline",
  group: "history",
  mode,
  tags: [makeTag(mode, 1, 1, 1.8), makeTag(mode, 2, 10, 10.8)],
  paragraphEnd: 12,
  depth: 0,
});

const video: MgVideoInfo = {
  width: 1280,
  height: 720,
  fps: 25,
  duration: 20,
  durationFrames: 500,
};

const progressCall = resolveMgFunctionCall({
  id: "call-history",
  name: "create_progress_timeline",
  arguments: {
    group: "history",
    at: 1,
    title: "谷歌发展时间线",
    nodes: [
      {at: 1, title: "1998年创办"},
      {at: 10, title: "2023年推出Gemini"},
    ],
  },
});

test("split renders separated windows and restores raw footage in the gap", () => {
  const group = makeGroup("split");
  const scenes = compileMgScenes([progressCall], new Map([[group.group, group]]), video);
  assert.equal(scenes.length, 2);
  assert.deepEqual(scenes.map((scene) => scene.startFrame), [25, 250]);
  assert.ok(scenes[0].endFrame < scenes[1].startFrame);
  assert.deepEqual(scenes.map((scene) => scene.timelineOffsetFrames), [0, 225]);
});

test("together renders one continuous window across all group nodes", () => {
  const group = makeGroup("together");
  const scenes = compileMgScenes([progressCall], new Map([[group.group, group]]), video);
  assert.equal(scenes.length, 1);
  assert.equal(scenes[0].startFrame, 25);
  assert.ok(scenes[0].endFrame > 250);
});

test("an MG cue near the end never exceeds the raw master frame range", () => {
  const endTag = makeTag("together", 1, 19.99, 20);
  const group: MgGroupInfo = {
    tag: "emphasis",
    group: "ending",
    mode: "together",
    tags: [{...endTag, tag: "emphasis", group: "ending"}],
    paragraphEnd: 20,
    depth: 0,
  };
  const call = resolveMgFunctionCall({
    id: "call-ending",
    name: "create_emphasis_text_cue",
    arguments: {group: "ending", at: 19.99, text: "第二次创业"},
  });
  const scenes = compileMgScenes([call], new Map([[group.group, group]]), video);
  assert.equal(scenes.length, 1);
  assert.equal(scenes[0].startFrame, 499);
  assert.equal(scenes[0].endFrame, 500);
  assert.equal(scenes[0].durationFrames, 1);
});
