const assert = require("node:assert/strict");
const test = require("node:test");
const {listMgAnnotationInstances, replaceMgAnnotationStyle} = require("./mg-assets.cjs");

const catalog = [
  {template: "progress-timeline", style: "horizontal", name: "横向", structureName: "进度条"},
  {template: "progress-timeline", style: "vertical", name: "纵向", structureName: "进度条"},
  {template: "timed-table", style: "grid", name: "动态数据表格", structureName: "动态表格"},
  {template: "title", style: "fade", name: "淡入标题", structureName: "标题动画"},
  {template: "effect", style: "scanline-annotate-focus", name: "扫描聚焦", structureName: "视觉效果"},
  {template: "camera", style: "slow-push-in", name: "缓慢推近", structureName: "运镜"},
  {template: "showcase", style: "card-stack", name: "卡片堆叠", structureName: "界面陈列"},
  {template: "metric", style: "counter-confetti", name: "计数庆祝", structureName: "指标动画"},
  {template: "transition", style: "whip-pan", name: "甩镜转场", structureName: "转场"},
  {template: "rhythm", style: "beat-pump", name: "节拍脉冲", structureName: "节拍强调"},
];

const html = `<!DOCTYPE html><html><body><article><p>
<progress-timeline group="horizontal" order="1" mode="split" value="1">十年前</progress-timeline>
<progress-timeline group="horizontal" order="1" mode="split" value="2">今天</progress-timeline>
<progress-timeline group="vertical" order="2" mode="together" value="1">芯片</progress-timeline>
</p></article></body></html>`;

test("MG asset instances use tag plus order rather than style group", () => {
  const instances = listMgAnnotationInstances(html, 1, true, catalog);
  assert.deepEqual(instances.map((item) => item.instanceKey), ["progress-timeline-01", "progress-timeline-02"]);
  assert.deepEqual(instances[0].texts, ["十年前", "今天"]);
  assert.equal(instances[0].style, "horizontal");
  assert.equal(instances[1].style, "vertical");
});

test("style replacement changes every node selected by tag and order only", () => {
  const result = replaceMgAnnotationStyle(html, {tag: "progress-timeline", order: 2, style: "horizontal"}, catalog);
  assert.equal(result.changedTagCount, 1);
  const instances = listMgAnnotationInstances(result.html, 1, true, catalog);
  assert.equal(instances[0].style, "horizontal");
  assert.equal(instances[1].style, "horizontal");
  assert.match(result.html, /group="horizontal" order="2"/);
});

test("style replacement rejects a style from another structural type", () => {
  assert.throws(
    () => replaceMgAnnotationStyle(html, {tag: "progress-timeline", order: 1, style: "radial"}, catalog),
    /未注册/,
  );
});

test("a singleton is replaced by tag without adding order", () => {
  const singleton = '<!DOCTYPE html><html><body><article><p>' +
    '<progress-timeline group="horizontal" mode="together" value="1">今天</progress-timeline>' +
    '</p></article></body></html>';
  const result = replaceMgAnnotationStyle(singleton, {
    tag: "progress-timeline",
    order: null,
    style: "vertical",
  }, catalog);
  assert.match(result.html, /group="vertical" mode="together"/);
  assert.doesNotMatch(result.html, /\border=/);
});

test("repeated templates reject replacement without order instead of choosing the first instance", () => {
  assert.throws(
    () => replaceMgAnnotationStyle(html, {tag: "progress-timeline", style: "vertical"}, catalog),
    /存在多个实例，替换时必须提供 order/,
  );
});

test("new protocol exposes Chinese structure and style names and keeps repeated instances separate", () => {
  const fresh = '<!DOCTYPE html><html><body><article><p>' +
    '<mg-title group="fade" mode="together" value="1">安全评测</mg-title>' +
    '</p><p>' +
    '<timed-table group="grid" order="1" mode="together" value="1">22 个模型</timed-table>，' +
    '<timed-table group="grid" order="1" mode="together" value="2">23 道题</timed-table>；' +
    '<timed-table group="grid" order="2" mode="split" value="1">21 个模型</timed-table>' +
    '</p></article></body></html>';
  const instances = listMgAnnotationInstances(fresh, 1, true, catalog);
  assert.deepEqual(instances.map((item) => item.instanceKey), ["title-01", "timed-table-01", "timed-table-02"]);
  assert.equal(instances[0].structureName, "标题动画");
  assert.equal(instances[0].styleName, "淡入标题");
  assert.equal(instances[1].structureName, "动态表格");
  assert.equal(instances[1].styleName, "动态数据表格");
  assert.equal(instances[1].order, 1);
  assert.equal(instances[2].order, 2);
});

test("legacy group ids are rejected instead of being displayed as English fallbacks", () => {
  const legacy = '<!DOCTYPE html><html><body><article><p>' +
    '<mg-title group="main_title" mode="together" value="1">旧标题</mg-title>' +
    '</p></article></body></html>';
  assert.throws(
    () => listMgAnnotationInstances(legacy, 1, true, catalog),
    /group 样式 main_title 未注册.*不是新协议/,
  );
});

test("repeated new-protocol tags must carry continuous order values", () => {
  const missingOrder = '<!DOCTYPE html><html><body><article><p>' +
    '<timed-table group="grid" mode="together" value="1">第一组</timed-table>' +
    '<timed-table group="grid" order="2" mode="together" value="1">第二组</timed-table>' +
    '</p></article></body></html>';
  assert.throws(() => listMgAnnotationInstances(missingOrder, 1, true, catalog), /所有同类标签都必须填写 order/);

  const skippedOrder = missingOrder
    .replace('mode="together" value="1">第一组', 'order="1" mode="together" value="1">第一组')
    .replace('order="2"', 'order="3"');
  assert.throws(() => listMgAnnotationInstances(skippedOrder, 1, true, catalog), /order 必须按首次出现顺序从 1 连续编号/);
});

test("Shotcraft tags are parsed and style replacement keeps their template mapping", () => {
  const shotcraft = '<!DOCTYPE html><html><body><article><p>' +
    '<mg-effect group="scanline-annotate-focus" mode="together" value="1">扫描页面</mg-effect>' +
    '<mg-camera group="slow-push-in" mode="together" value="1">推近核心</mg-camera>' +
    '<mg-showcase group="card-stack" mode="together" value="1">功能卡片</mg-showcase>' +
    '<mg-metric group="counter-confetti" mode="together" value="1">完成率</mg-metric>' +
    '<mg-transition group="whip-pan" mode="together" value="1">下一段</mg-transition>' +
    '<mg-rhythm group="beat-pump" mode="together" value="1">重音</mg-rhythm>' +
    '</p></article></body></html>';
  const instances = listMgAnnotationInstances(shotcraft, 1, true, catalog);
  assert.deepEqual(instances.map((item) => item.template), ["effect", "camera", "showcase", "metric", "transition", "rhythm"]);
  const replaced = replaceMgAnnotationStyle(shotcraft, {tag: "mg-effect", style: "scanline-annotate-focus", order: null}, catalog);
  assert.equal(replaced.changedTagCount, 1);
});
