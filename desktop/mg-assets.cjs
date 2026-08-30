const parse5 = require("parse5");

const MG_HTML_TAGS = new Set([
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
]);

const TEMPLATE_BY_HTML_TAG = Object.freeze({
  "mg-title": "title",
  "mg-showcase": "showcase",
  "mg-metric": "metric",
  "mg-transition": "transition",
  "mg-rhythm": "rhythm",
  "mg-effect": "effect",
  "mg-camera": "camera",
});

const templateForHtmlTag = (htmlTag) => TEMPLATE_BY_HTML_TAG[htmlTag] || htmlTag;

const ALLOWED_ATTRIBUTES = new Set(["group", "order", "mode", "value"]);
const GROUP_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const MODES = new Set(["together", "split"]);

const attrsOf = (node) => Object.fromEntries((node.attrs || []).map((attr) => [attr.name, attr.value]));

const textContent = (node) => node.nodeName === "#text"
  ? String(node.value || "")
  : (node.childNodes || []).map(textContent).join("");

const visit = (node, callback) => {
  callback(node);
  (node.childNodes || []).forEach((child) => visit(child, callback));
};

const parseOrder = (raw, tagName) => {
  if (raw === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(String(raw))) {
    throw new Error(`<${tagName}> 的 order 必须是 1-999 的正整数`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > 999) {
    throw new Error(`<${tagName}> 的 order 必须是 1-999 的正整数`);
  }
  return value;
};

const instanceKey = (template, order) => `${template}-${String(order || 1).padStart(2, "0")}`;

const styleEntryFor = (catalog, template, style, tagName) => {
  const entry = catalog.find((candidate) => candidate.template === template && candidate.style === style);
  if (!entry) {
    throw new Error(`<${tagName}> 的 group 样式 ${style || "(缺失)"} 未注册；当前 MG HTML 不是新协议`);
  }
  return entry;
};

const parseValue = (raw, tagName) => {
  if (!/^[1-9]\d*$/.test(String(raw ?? ""))) {
    throw new Error(`<${tagName}> 的 value 必须是正整数`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`<${tagName}> 的 value 必须是正整数`);
  return value;
};

const parseMgAnnotation = (html, catalog) => {
  const document = parse5.parse(String(html || ""));
  const tags = [];
  let documentOrder = 0;

  const walk = (node, ancestors = []) => {
    if (MG_HTML_TAGS.has(node.tagName)) {
      const attrs = attrsOf(node);
      const unknown = Object.keys(attrs).filter((name) => !ALLOWED_ATTRIBUTES.has(name));
      if (unknown.length) throw new Error(`<${node.tagName}> 包含不支持的属性: ${unknown.join(", ")}`);

      const template = templateForHtmlTag(node.tagName);
      const style = attrs.group;
      if (!style || !GROUP_PATTERN.test(style)) {
        throw new Error(`<${node.tagName}> 缺少合法 group；当前 MG HTML 不是新协议`);
      }
      const styleEntry = styleEntryFor(catalog, template, style, node.tagName);
      const order = parseOrder(attrs.order, node.tagName);
      if (!MODES.has(attrs.mode)) throw new Error(`<${node.tagName}> 的 mode 必须是 together 或 split`);
      const value = parseValue(attrs.value, node.tagName);
      const text = textContent(node).trim();
      if (!text) throw new Error(`<${node.tagName}> 不能包裹空文本`);

      const key = instanceKey(template, order);
      if (ancestors.includes(key)) throw new Error(`动画实例 ${key} 不能嵌套自身`);
      tags.push({
        tag: node.tagName,
        template,
        style,
        styleEntry,
        order,
        mode: attrs.mode,
        value,
        text,
        instanceKey: key,
        parentInstance: ancestors.at(-1),
        documentOrder: documentOrder++,
      });
      const nextAncestors = [...ancestors, key];
      (node.childNodes || []).forEach((child) => walk(child, nextAncestors));
      return;
    }
    (node.childNodes || []).forEach((child) => walk(child, ancestors));
  };
  walk(document);

  const byTemplate = new Map();
  for (const tag of tags) {
    const group = byTemplate.get(tag.template) || [];
    group.push(tag);
    byTemplate.set(tag.template, group);
  }
  for (const [template, templateTags] of byTemplate) {
    const ordered = templateTags.filter((tag) => tag.order !== undefined);
    if (ordered.length > 0 && ordered.length < templateTags.length) {
      throw new Error(`<${template}> 存在多个实例时，所有同类标签都必须填写 order`);
    }
    const orderValues = [...new Set(templateTags
      .sort((left, right) => left.documentOrder - right.documentOrder)
      .map((tag) => tag.order))];
    if (ordered.length === 0) continue;
    if (orderValues.length < 2) throw new Error(`<${template}> 只有一个实例时不应填写 order`);
    if (orderValues.some((value, index) => value !== index + 1)) {
      throw new Error(`<${template}> 的 order 必须按首次出现顺序从 1 连续编号`);
    }
  }

  const byInstance = new Map();
  for (const tag of tags) {
    const group = byInstance.get(tag.instanceKey) || [];
    group.push(tag);
    byInstance.set(tag.instanceKey, group);
  }
  const instances = [...byInstance.values()].map((instanceTags) => {
    const first = instanceTags[0];
    if (instanceTags.some((tag) => tag.template !== first.template || tag.style !== first.style)) {
      throw new Error(`${first.instanceKey} 的 group 样式不一致`);
    }
    if (instanceTags.some((tag) => tag.mode !== first.mode)) {
      throw new Error(`${first.instanceKey} 的 mode 不一致`);
    }
    if (instanceTags.some((tag) => tag.parentInstance !== first.parentInstance)) {
      throw new Error(`${first.instanceKey} 出现在不同嵌套层级`);
    }
    if ((first.template === "title" || first.template === "emphasis") && instanceTags.length !== 1) {
      throw new Error(`${first.instanceKey} 的 <${first.tag}> 只能出现一次`);
    }
    const values = [...instanceTags]
      .sort((left, right) => left.documentOrder - right.documentOrder)
      .map((tag) => tag.value);
    if (values.some((value, index) => value !== index + 1)) {
      throw new Error(`${first.instanceKey} 的 value 必须按正文顺序从 1 连续编号`);
    }
    return {
      instanceKey: first.instanceKey,
      tag: first.tag,
      template: first.template,
      order: first.order,
      style: first.style,
      styleName: first.styleEntry.name,
      structureName: first.styleEntry.structureName,
      mode: first.mode,
      values,
      texts: instanceTags
        .sort((left, right) => left.documentOrder - right.documentOrder)
        .map((tag) => tag.text),
      firstDocumentOrder: first.documentOrder,
      tags: instanceTags,
    };
  });
  return {tags, instances: instances.sort((left, right) => left.firstDocumentOrder - right.firstDocumentOrder)};
};

function listMgAnnotationInstances(html, episode, editable, catalog) {
  const parsed = parseMgAnnotation(html, catalog);
  return parsed.instances.map((item) => ({
    instanceKey: item.instanceKey,
    tag: item.tag,
    template: item.template,
    order: item.order,
    style: item.style,
    styleName: item.styleName,
    structureName: item.structureName,
    mode: item.mode,
    values: item.values,
    texts: item.texts,
    firstDocumentOrder: item.firstDocumentOrder,
    episode,
    editable: Boolean(editable),
    compatibleStyles: catalog
      .filter((entry) => entry.template === item.template)
      .map((entry) => ({style: entry.style, name: entry.name})),
  }));
}

function replaceMgAnnotationStyle(html, selection, catalog) {
  const tag = String(selection?.tag || "").trim();
  const style = String(selection?.style || "").trim();
  const order = selection?.order === null || selection?.order === undefined
    ? undefined
    : parseOrder(String(selection.order), tag);
  if (!MG_HTML_TAGS.has(tag)) throw new Error("MG 标签类型无效");
  const template = templateForHtmlTag(tag);
  styleEntryFor(catalog, template, style, tag);

  const source = String(html || "");
  const parsed = parseMgAnnotation(source, catalog);
  const templateInstances = parsed.instances.filter((item) => item.template === template);
  if (templateInstances.length > 1 && order === undefined) {
    throw new Error(`<${tag}> 存在多个实例，替换时必须提供 order`);
  }
  const targetKey = instanceKey(template, order);
  const target = parsed.instances.find((item) => item.instanceKey === targetKey);
  if (!target) throw new Error(`找不到新协议中的 <${tag}> ${order === undefined ? "单实例" : `order=${order}`} 实例`);
  if (target.tag !== tag) throw new Error(`MG 标签类型与目标实例不一致`);
  const document = parse5.parse(source, {sourceCodeLocationInfo: true});
  const replacements = [];
  visit(document, (node) => {
    if (node.tagName !== tag) return;
    const attrs = attrsOf(node);
    const nodeOrder = parseOrder(attrs.order, tag);
    if (instanceKey(template, nodeOrder) !== targetKey) return;
    const location = node.sourceCodeLocation?.attrs?.group;
    if (!location) throw new Error(`<${tag}> 缺少可替换的 group 属性`);
    replacements.push({start: location.startOffset, end: location.endOffset});
  });
  if (!replacements.length) {
    throw new Error(`找不到新协议中的 <${tag}> 实例`);
  }

  let updated = source;
  replacements.sort((left, right) => right.start - left.start).forEach((replacement) => {
    updated = `${updated.slice(0, replacement.start)}group="${style}"${updated.slice(replacement.end)}`;
  });
  return {html: updated, changedTagCount: replacements.length};
}

module.exports = {
  listMgAnnotationInstances,
  parseMgAnnotation,
  replaceMgAnnotationStyle,
};
