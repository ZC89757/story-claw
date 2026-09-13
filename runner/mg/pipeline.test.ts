import assert from "node:assert/strict";
import test from "node:test";
import type {ArticleTimelineEntry} from "../render.js";
import {
  decorateMgAnnotationHtml,
  locateMgInstances,
  prepareMgAnnotationHtml,
  stripMgAnnotationDecoration,
  validateMgAnnotationHtml,
} from "./html.js";
import {compileMgScenes, computeScLongtakeSegmentWindows, selectMgFunctionDefinitions} from "./planner.js";
import {resolveMgFunctionCall} from "./registry.js";
import type {LocatedMgTag, MgInstanceInfo, MgMode, MgVideoInfo} from "./types.js";

const article = [
  "谷歌从搜索入口走向AI基础设施。",
  "底层是芯片，中间是模型，上层是应用。",
].join("\n\n");

const html = `<!DOCTYPE html>
<html><body><article>
<p>谷歌从<progress-timeline group="horizontal" mode="split" value="1">搜索入口</progress-timeline>走向<progress-timeline group="horizontal" mode="split" value="2">AI基础设施</progress-timeline>。</p>
<p><decomposition group="cards" mode="together">底层是<emphasis group="scale" mode="together">芯片</emphasis>，中间是模型，上层是应用</decomposition>。</p>
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
  assert.deepEqual(validateMgAnnotationHtml(html, article), {instanceCount: 3, tagCount: 4});
  const instances = locateMgInstances(html, buildTimeline(article), article);
  assert.equal(instances.get("progress-timeline::horizontal::one")?.mode, "split");
  assert.deepEqual(instances.get("progress-timeline::horizontal::one")?.tags.map((tag) => tag.value), [1, 2]);
  assert.equal(instances.get("emphasis::scale::one")?.parentInstance, "decomposition::cards::one");
  assert.equal(instances.get("emphasis::scale::one")?.depth, 1);
  assert.ok((instances.get("progress-timeline::horizontal::one")?.tags[1].start ?? 0) > (instances.get("progress-timeline::horizontal::one")?.tags[0].end ?? 0));
});

test("MG HTML rejects at because timestamps belong to Function Calling", () => {
  const invalid = html.replace(
    'group="horizontal" mode="split" value="1"',
    'group="horizontal" mode="split" value="1" at="0.1"',
  );
  assert.throws(() => validateMgAnnotationHtml(invalid, article), /不支持的属性: at/);
});

test("directed-graph keeps the reviewed topology in the located instance", () => {
  const source = "显卡连接研究机构。";
  const valid = `<!DOCTYPE html><html><body><article><p>`
    + `<directed-graph group="flow" mode="together" nodes='["显卡","研究机构"]' edges='[[0,1]]'>${source}</directed-graph>`
    + `</p></article></body></html>`;
  assert.deepEqual(validateMgAnnotationHtml(valid, source), {instanceCount: 1, tagCount: 1});
  const instance = locateMgInstances(valid, buildTimeline(source), source).get("directed-graph::flow::one");
  assert.deepEqual(instance?.graph, {nodes: ["显卡", "研究机构"], edges: [[0, 1]]});
  assert.throws(
    () => validateMgAnnotationHtml(valid.replace("edges='[[0,1]]'", "edges='[[0,2]]'"), source),
    /节点索引超出 nodes 范围/,
  );
  assert.throws(
    () => validateMgAnnotationHtml(valid.replace(" nodes='[\"显卡\",\"研究机构\"]'", ""), source),
    /nodes 和 edges 必须同时提供/,
  );
});

test("sc-longtake is a single relay video instance without mode or value", () => {
  const source = "这次转向虽然在短期内增加了成本。";
  const valid = `<!DOCTYPE html><html><body><article><p>`
    + `<sc-longtake group="relay">${source}</sc-longtake>`
    + `</p></article></body></html>`;
  assert.deepEqual(validateMgAnnotationHtml(valid, source), {instanceCount: 1, tagCount: 1});
  const instance = locateMgInstances(valid, buildTimeline(source), source).get("sc-longtake::relay::one");
  assert.equal(instance?.mode, "together");
  assert.deepEqual(instance?.tags.map((tag) => tag.value), [1]);

  assert.throws(
    () => validateMgAnnotationHtml(valid.replace('group="relay"', 'group="relay" mode="together"'), source),
    /包含不支持的属性: mode/,
  );
  assert.throws(
    () => validateMgAnnotationHtml(valid.replace('group="relay"', 'group="relay" value="1"'), source),
    /包含不支持的属性: value/,
  );
  assert.throws(
    () => validateMgAnnotationHtml(valid.replace('group="relay"', 'group="normal"'), source),
    /group 样式 normal 不可用/,
  );
});

test("sc-longtake maps absolute segment times to adjacent non-empty frame windows", () => {
  assert.deepEqual(
    computeScLongtakeSegmentWindows([
      {at: 10.2, video_prompt: "first"},
      {at: 11.5, video_prompt: "second"},
      {at: 12.9, video_prompt: "third"},
    ], 255, 400, 25),
    [
      {index: 0, startFrame: 255, endFrame: 288},
      {index: 1, startFrame: 288, endFrame: 323},
      {index: 2, startFrame: 323, endFrame: 400},
    ],
  );
  assert.throws(() => computeScLongtakeSegmentWindows([
    {at: 10, video_prompt: "first"},
    {at: 10, video_prompt: "second"},
  ], 250, 350, 25), /segments\.at 必须严格递增/);
  assert.throws(() => computeScLongtakeSegmentWindows([
    {at: 10, video_prompt: "first"},
    {at: 11, video_prompt: "second"},
  ], 250, 260, 25), /第 2 段没有有效的帧区间/);
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
    `<emphasis group="scale" mode="split" value="1">搜索广告</emphasis>仍是基本盘，` +
    `但AI正在冲击<emphasis group="scale" mode="split" value="2">基本盘</emphasis>。` +
    `</p></article></body></html>`;
  assert.throws(() => validateMgAnnotationHtml(invalid, source), /<emphasis>.*只能出现一次/);
});

test("mg-title is executable markup and native title is rejected in article text", () => {
  const source = "谷歌的第二次创业";
  const valid = `<!DOCTYPE html><html><body><article><p>` +
    `<mg-title group="fade" mode="together">${source}</mg-title>` +
    `</p></article></body></html>`;
  assert.deepEqual(validateMgAnnotationHtml(valid, source), {instanceCount: 1, tagCount: 1});
  assert.equal(locateMgInstances(valid, buildTimeline(source), source).get("mg-title::fade::one")?.tag, "mg-title");

  const native = valid.replaceAll("mg-title", "title");
  assert.throws(() => validateMgAnnotationHtml(native, source));
});

test("all Shotcraft structural tags remain executable through provider-backed HTML tags", () => {
  const source = "界面展示指标转场节拍效果。";
  const annotated = `<!DOCTYPE html><html><body><article><p>` +
    `<mg-showcase group="card-stack" mode="together">界面</mg-showcase>` +
    `<mg-metric group="counter-confetti" mode="together">展示</mg-metric>` +
    `<mg-transition group="flash-cut" mode="together">指标</mg-transition>` +
    `<mg-rhythm group="beat-pump" mode="together">转场</mg-rhythm>` +
    `<mg-effect group="line-unfold-panel" mode="together">节拍效果</mg-effect>` +
    `。</p></article></body></html>`;
  assert.deepEqual(validateMgAnnotationHtml(annotated, source), {instanceCount: 5, tagCount: 5});
  const tags = [...locateMgInstances(annotated, buildTimeline(source), source).values()]
    .map((instance) => instance.tag);
  assert.deepEqual(tags, ["mg-showcase", "mg-metric", "mg-transition", "mg-rhythm", "mg-effect"]);
});

test("annotation viewer styles expose provider tags and protocol attributes", () => {
  const decorated = decorateMgAnnotationHtml(html);
  const style = decorated.match(/<style id="story-claw-mg-annotation-style">[\s\S]*?<\/style>/)?.[0] ?? "";
  assert.match(decorated, /id="story-claw-mg-annotation-style"/);
  assert.match(style, /progress-timeline,group=/);
  assert.match(style, /progress-timeline,group=.*mode=.*value=/);
  assert.match(style, /decomposition,group=.*mode=/);
  assert.match(style, /article decomposition\[group="cards"\]:not\(\[order\]\)::before \{ content: "decomposition,group=" attr\(group\)\s+",mode=" attr\(mode\); \}/);
  assert.doesNotMatch(style, /tag=/);
  assert.doesNotMatch(style, /order=implicit/);
  assert.doesNotMatch(style, /·/);
  assert.deepEqual(validateMgAnnotationHtml(decorated, article), {instanceCount: 3, tagCount: 4});
  assert.equal(decorateMgAnnotationHtml(decorated), decorated);
});

test("order identifies repeated instances while value and values identify their nodes", () => {
  const source = ["十年前走向今天。", "芯片走向模型。"].join("\n\n");
  const repeated = `<!DOCTYPE html><html><body><article>` +
    `<p><progress-timeline group="horizontal" order="1" mode="split" value="1">十年前</progress-timeline>走向` +
    `<progress-timeline group="horizontal" order="1" mode="split" value="2">今天</progress-timeline>。</p>` +
    `<p><progress-timeline group="horizontal" order="2" mode="together" values='["芯片","模型"]'>` +
    `<span class="mg-value">芯片</span>走向<span class="mg-value">模型</span></progress-timeline>。</p>` +
    `</article></body></html>`;

  assert.deepEqual(validateMgAnnotationHtml(repeated, source), {instanceCount: 2, tagCount: 3});
  const instances = locateMgInstances(repeated, buildTimeline(source), source);
  assert.equal(instances.get("progress-timeline::horizontal::01")?.group, "horizontal");
  assert.equal(instances.get("progress-timeline::horizontal::02")?.group, "horizontal");
  assert.deepEqual(instances.get("progress-timeline::horizontal::02")?.tags[0].values, ["芯片", "模型"]);

  const differentGroups = repeated
    .replaceAll('group="horizontal" order="1" mode="split"', 'group="horizontal" mode="split"')
    .replace('group="horizontal" order="2" mode="together"', 'group="vertical" mode="together"');
  assert.deepEqual(validateMgAnnotationHtml(differentGroups, source), {instanceCount: 2, tagCount: 3});
  assert.equal(locateMgInstances(differentGroups, buildTimeline(source), source).get("progress-timeline::vertical::one")?.group, "vertical");

  const sameStyle = repeated;
  assert.deepEqual(validateMgAnnotationHtml(sameStyle, source), {instanceCount: 2, tagCount: 3});
  assert.equal(locateMgInstances(sameStyle, buildTimeline(source), source).get("progress-timeline::horizontal::02")?.group, "horizontal");

  const decorated = decorateMgAnnotationHtml(repeated);
  const style = decorated.match(/<style id="story-claw-mg-annotation-style">[\s\S]*?<\/style>/)?.[0] ?? "";
  assert.match(style, /article progress-timeline\[group="horizontal"\]\[order="1"\]::before \{ content: "progress-timeline,group=" attr\(group\)\s+",order=" attr\(order\)\s+",mode=" attr\(mode\)\s+",value=" attr\(value\); \}/);
  assert.match(style, /article progress-timeline\[group="horizontal"\]\[order="2"\]::before \{ content: "progress-timeline,group=" attr\(group\)\s+",order=" attr\(order\)\s+",mode=" attr\(mode\); \}/);
  assert.doesNotMatch(style, /tag=/);
  assert.doesNotMatch(style, /order=implicit/);
  assert.doesNotMatch(style, /·/);
});

test("order is forbidden for one tag/group instance and mandatory for repeated tag/group instances", () => {
  const singletonSource = "十年前走向今天。";
  const redundant = `<!DOCTYPE html><html><body><article><p>` +
    `<progress-timeline group="horizontal" order="1" mode="split" value="1">十年前</progress-timeline>走向` +
    `<progress-timeline group="horizontal" order="1" mode="split" value="2">今天</progress-timeline>。` +
    `</p></article></body></html>`;
  assert.throws(() => validateMgAnnotationHtml(redundant, singletonSource), /只有一个实例时不应填写 order/);

  const repeatedSource = ["十年前走向今天。", "芯片走向模型。"].join("\n\n");
  const differentGroups = `<!DOCTYPE html><html><body><article>` +
    `<p><progress-timeline group="horizontal" mode="split" value="1">十年前</progress-timeline>走向` +
    `<progress-timeline group="horizontal" mode="split" value="2">今天</progress-timeline>。</p>` +
    `<p><progress-timeline group="vertical" mode="together" values='["芯片","模型"]'>芯片走向模型</progress-timeline>。</p>` +
    `</article></body></html>`;
  // Different groups are different instances by themselves; order is not
  // shared across groups and is therefore omitted for both singleton groups.
  assert.deepEqual(validateMgAnnotationHtml(differentGroups, repeatedSource), {instanceCount: 2, tagCount: 3});

  const redundantDifferentGroupOrder = differentGroups.replace('group="vertical" mode=', 'group="vertical" order="2" mode=');
  assert.throws(() => validateMgAnnotationHtml(redundantDifferentGroupOrder, repeatedSource), /vertical.*只有一个实例时不应填写 order/);

  const sameGroup = differentGroups.replace('group="vertical" mode=', 'group="horizontal" order="2" mode=')
    .replaceAll('group="horizontal" mode="split"', 'group="horizontal" order="1" mode="split"');
  assert.deepEqual(validateMgAnnotationHtml(sameGroup, repeatedSource), {instanceCount: 2, tagCount: 3});

  const reversed = sameGroup
    .replaceAll('group="horizontal" order="1" mode="split"', 'group="horizontal" order="2" mode="split"')
    .replaceAll('group="horizontal" order="2" mode="together"', 'group="horizontal" order="1" mode="together"');
  assert.throws(() => validateMgAnnotationHtml(reversed, repeatedSource), /order 必须按首次出现顺序从 1 连续编号/);
});

test("group must be a registered style for the structural tag", () => {
  const invalid = html.replaceAll('group="horizontal"', 'group="dark"');
  assert.throws(() => validateMgAnnotationHtml(invalid, article), /group 样式 dark 不可用/);
});

test("annotation preparation removes viewer decoration before restoring canonical styles", () => {
  const decorated = decorateMgAnnotationHtml(html);
  const stripped = stripMgAnnotationDecoration(decorated);
  assert.doesNotMatch(stripped, /story-claw-mg-annotation-style/);
  const prepared = prepareMgAnnotationHtml(`说明文字\n${decorated}\n结束`, article);
  assert.deepEqual(
    {instanceCount: prepared.instanceCount, tagCount: prepared.tagCount},
    {instanceCount: 3, tagCount: 4},
  );
  assert.match(prepared.html, /id="story-claw-mg-annotation-style"/);
  assert.deepEqual(validateMgAnnotationHtml(prepared.html, article), {instanceCount: 3, tagCount: 4});
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
      "create_multi_series_chart",
    ]),
  );
  assert.equal(definitions.length, 3);
});

test("image stack and grid expose the same media contract", () => {
  const definitions = selectMgFunctionDefinitions(["image-stack", "image-grid"]);
  assert.deepEqual(
    definitions.map((definition) => definition.name),
    ["create_image_stack", "create_image_grid"],
  );
  const args = {
    group: "stack",
    order: null,
    at: 10,
    title: "报道截图",
    images: [
      {at: 10, image: "https://example.com/one.png"},
      {at: 12, image: "办公室里的网页截图"},
    ],
  };
  const stack = resolveMgFunctionCall({id: "image-stack", name: "create_image_stack", arguments: args});
  const grid = resolveMgFunctionCall({id: "image-grid", name: "create_image_grid", arguments: {...args, group: "grid"}});
  assert.equal(stack.htmlTag, "image-stack");
  assert.equal(grid.htmlTag, "image-grid");
  assert.deepEqual((stack.render.spec as {images: Array<{at: number}>}).images.map((item) => item.at), [0, 2]);
  assert.deepEqual(Object.keys(stack.render.spec as object), Object.keys(grid.render.spec as object));
});

test("effect tags remain executable through the provider", () => {
  const source = "先扫描页面，再确认核心数字。";
  const annotated = `<!DOCTYPE html><html><body><article><p>` +
    `先<mg-effect group="scanline-annotate-focus" mode="together">扫描页面</mg-effect>，再` +
    `确认核心数字。` +
    `</p></article></body></html>`;
  assert.deepEqual(validateMgAnnotationHtml(annotated, source), {instanceCount: 1, tagCount: 1});
  const instances = locateMgInstances(annotated, buildTimeline(source), source);
  const effectCall = resolveMgFunctionCall({
    id: "effect-call",
    name: "create_effect_cue",
    arguments: {group: "scanline-annotate-focus", order: null, at: 0.1, text: "扫描页面", items: [{text: "扫描页面", at: 0.1}]},
  });
  const scenes = compileMgScenes(
    [effectCall],
    instances,
    {...video, duration: 20, durationFrames: 500},
  );
  assert.ok(scenes.some((scene) => scene.render.kind === "effect" && scene.layerRole === "overlay"));
});

const makeTag = (
  mode: MgMode,
  value: number,
  start: number,
  end: number,
): LocatedMgTag => ({
  tag: "progress-timeline",
  group: "horizontal",
  instanceKey: "progress-timeline::horizontal::one",
  mode,
  value,
  text: value === 1 ? "1998年创办" : "2023年推出Gemini",
  start,
  end,
  paragraphEnd: 12,
  depth: 0,
  documentOrder: value - 1,
});

const makeInstance = (mode: MgMode): MgInstanceInfo => ({
  instanceKey: "progress-timeline::horizontal::one",
  tag: "progress-timeline",
  group: "horizontal",
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
    group: "horizontal",
    order: null,
    at: 1,
    title: "谷歌发展时间线",
    nodes: [
      {at: 1, title: "1998年创办"},
      {at: 10, title: "2023年推出Gemini"},
    ],
  },
});

test("split renders separated windows and restores raw footage in the gap", () => {
  const instance = makeInstance("split");
  const scenes = compileMgScenes([progressCall], new Map([[instance.instanceKey, instance]]), video);
  assert.equal(scenes.length, 2);
  assert.deepEqual(scenes.map((scene) => scene.startFrame), [25, 250]);
  assert.ok(scenes[0].endFrame < scenes[1].startFrame);
  assert.deepEqual(scenes.map((scene) => scene.timelineOffsetFrames), [0, 225]);
});

test("together renders one continuous window across all group nodes", () => {
  const instance = makeInstance("together");
  const scenes = compileMgScenes([progressCall], new Map([[instance.instanceKey, instance]]), video);
  assert.equal(scenes.length, 1);
  assert.equal(scenes[0].startFrame, 25);
  assert.ok(scenes[0].endFrame > 250);
});

test("an MG cue near the end never exceeds the raw master frame range", () => {
  const endTag = makeTag("together", 1, 19.99, 20);
  const instance: MgInstanceInfo = {
    instanceKey: "emphasis::scale::one",
    tag: "emphasis",
    group: "scale",
    mode: "together",
    tags: [{...endTag, tag: "emphasis", group: "scale", instanceKey: "emphasis::scale::one"}],
    paragraphEnd: 20,
    depth: 0,
  };
  const call = resolveMgFunctionCall({
    id: "call-ending",
    name: "create_emphasis_text_cue",
    arguments: {group: "scale", order: null, at: 19.99, text: "第二次创业"},
  });
  const scenes = compileMgScenes([call], new Map([[instance.instanceKey, instance]]), video);
  assert.equal(scenes.length, 1);
  assert.equal(scenes[0].startFrame, 499);
  assert.equal(scenes[0].endFrame, 500);
  assert.equal(scenes[0].durationFrames, 1);
});
