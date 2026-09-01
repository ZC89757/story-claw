const parse5 = require("parse5");

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

const instanceKey = (tag, style, order) => `${tag}::${style}::${order === undefined ? "one" : String(order).padStart(2, "0")}`;

const catalogHtmlTag = (entry) => entry.htmlTag || entry.template;

const styleEntryFor = (catalog, tagName, style) => {
  const entry = catalog.find((candidate) => catalogHtmlTag(candidate) === tagName && candidate.style === style);
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
  const MG_HTML_TAGS = new Set(catalog.map(catalogHtmlTag));
  const document = parse5.parse(String(html || ""));
  const tags = [];
  let documentOrder = 0;

  const walk = (node, ancestors = []) => {
    if (MG_HTML_TAGS.has(node.tagName)) {
      const attrs = attrsOf(node);
      const unknown = Object.keys(attrs).filter((name) => !ALLOWED_ATTRIBUTES.has(name));
      if (unknown.length) throw new Error(`<${node.tagName}> 包含不支持的属性: ${unknown.join(", ")}`);

      const style = attrs.group;
      if (!style || !GROUP_PATTERN.test(style)) {
        throw new Error(`<${node.tagName}> 缺少合法 group；当前 MG HTML 不是新协议`);
      }
      const styleEntry = styleEntryFor(catalog, node.tagName, style);
      const order = parseOrder(attrs.order, node.tagName);
      if (!MODES.has(attrs.mode)) throw new Error(`<${node.tagName}> 的 mode 必须是 together 或 split`);
      const value = parseValue(attrs.value, node.tagName);
      const text = textContent(node).trim();
      if (!text) throw new Error(`<${node.tagName}> 不能包裹空文本`);

      const key = instanceKey(node.tagName, style, order);
      if (ancestors.includes(key)) throw new Error(`动画实例 ${key} 不能嵌套自身`);
      tags.push({
        tag: node.tagName,
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

  const byTagGroup = new Map();
  for (const tag of tags) {
    const group = byTagGroup.get(`${tag.tag}::${tag.style}`) || [];
    group.push(tag);
    byTagGroup.set(`${tag.tag}::${tag.style}`, group);
  }
  for (const [, templateTags] of byTagGroup) {
    const firstTag = templateTags[0];
    const ordered = templateTags.filter((tag) => tag.order !== undefined);
    if (ordered.length > 0 && ordered.length < templateTags.length) {
      throw new Error(`<${firstTag.tag} group=${firstTag.style}> 存在多个实例时，所有同类标签都必须填写 order`);
    }
    const orderValues = [...new Set(templateTags
      .sort((left, right) => left.documentOrder - right.documentOrder)
      .map((tag) => tag.order))];
    if (ordered.length === 0) continue;
    if (orderValues.length < 2) throw new Error(`<${firstTag.tag} group=${firstTag.style}> 只有一个实例时不应填写 order`);
    if (orderValues.some((value, index) => value !== index + 1)) {
      throw new Error(`<${firstTag.tag} group=${firstTag.style}> 的 order 必须按首次出现顺序从 1 连续编号`);
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
    if (instanceTags.some((tag) => tag.tag !== first.tag || tag.style !== first.style)) {
      throw new Error(`${first.instanceKey} 的 group 样式不一致`);
    }
    if (instanceTags.some((tag) => tag.mode !== first.mode)) {
      throw new Error(`${first.instanceKey} 的 mode 不一致`);
    }
    if (instanceTags.some((tag) => tag.parentInstance !== first.parentInstance)) {
      throw new Error(`${first.instanceKey} 出现在不同嵌套层级`);
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
      .filter((entry) => catalogHtmlTag(entry) === item.tag)
      .map((entry) => ({style: entry.style, name: entry.name})),
  }));
}

function replaceMgAnnotationStyle(html, selection, catalog) {
  const tag = String(selection?.tag || "").trim();
  const style = String(selection?.style || "").trim();
  const currentStyle = String(selection?.currentStyle || "").trim() || undefined;
  const order = selection?.order === null || selection?.order === undefined
    ? undefined
    : parseOrder(String(selection.order), tag);
  const MG_HTML_TAGS = new Set(catalog.map(catalogHtmlTag));
  if (!MG_HTML_TAGS.has(tag)) throw new Error("MG 标签类型无效");
  styleEntryFor(catalog, tag, style);

  const source = String(html || "");
  const parsed = parseMgAnnotation(source, catalog);
  const sameTagInstances = parsed.instances.filter((item) => item.tag === tag);
  const styleCandidates = currentStyle
    ? sameTagInstances.filter((item) => item.style === currentStyle)
    : sameTagInstances;
  if (currentStyle && !styleCandidates.length) {
    throw new Error(`<${tag}> 不存在当前 group=${currentStyle} 的实例`);
  }
  const candidates = order === undefined
    ? styleCandidates.filter((item) => item.order === undefined)
    : styleCandidates.filter((item) => item.order === order);
  if (!candidates.length && order === undefined && styleCandidates.length > 1) {
    throw new Error(`<${tag}> 当前 group 存在多个实例，替换时必须提供 order`);
  }
  if (candidates.length > 1) {
    throw new Error(`<${tag}> 的目标实例不唯一，请同时提供当前 group 和 order`);
  }
  if (!currentStyle && !candidates.length && sameTagInstances.length > 1) {
    throw new Error(`<${tag}> 存在多个 group 实例，替换时必须提供 currentStyle`);
  }
  const target = candidates[0];
  if (!target) throw new Error(`找不到新协议中的 <${tag}> ${order === undefined ? "单实例" : `order=${order}`} 实例`);
  if (target.tag !== tag) throw new Error(`MG 标签类型与目标实例不一致`);

  // Changing a group's style can move an instance into a group that already
  // contains other instances (or leave its old group with one fewer
  // instance).  `order` is local to tag+group, so normalize both affected
  // groups after the move instead of leaving gaps/collisions behind.
  const targetKey = target.instanceKey;
  const desiredGroupByInstance = new Map(
    parsed.instances.map((item) => [item.instanceKey, item.instanceKey === targetKey ? style : item.style]),
  );
  const instancesByTagGroup = new Map();
  for (const instance of parsed.instances) {
    const desiredGroup = desiredGroupByInstance.get(instance.instanceKey);
    const key = `${instance.tag}::${desiredGroup}`;
    const group = instancesByTagGroup.get(key) || [];
    group.push(instance);
    instancesByTagGroup.set(key, group);
  }
  for (const group of instancesByTagGroup.values()) {
    group.sort((left, right) => left.firstDocumentOrder - right.firstDocumentOrder);
  }
  const normalizedOrderByInstance = new Map();
  for (const group of instancesByTagGroup.values()) {
    if (group.length <= 1) {
      normalizedOrderByInstance.set(group[0].instanceKey, undefined);
      continue;
    }
    group.forEach((instance, index) => normalizedOrderByInstance.set(instance.instanceKey, index + 1));
  }

  const document = parse5.parse(source, {sourceCodeLocationInfo: true});
  const nodeByDocumentOrder = new Map();
  let documentOrder = 0;
  visit(document, (node) => {
    if (!node.tagName || !MG_HTML_TAGS.has(node.tagName)) return;
    nodeByDocumentOrder.set(documentOrder++, node);
  });

  const targetDocumentOrders = new Set(target.tags.map((item) => item.documentOrder));
  const replacements = [];
  for (const instance of parsed.instances) {
    const desiredGroup = desiredGroupByInstance.get(instance.instanceKey);
    const desiredOrder = normalizedOrderByInstance.get(instance.instanceKey);
    for (const locatedTag of instance.tags) {
      const node = nodeByDocumentOrder.get(locatedTag.documentOrder);
      const startTag = node?.sourceCodeLocation?.startTag;
      const groupLocation = node?.sourceCodeLocation?.attrs?.group;
      if (!node || !startTag || !groupLocation) {
        throw new Error(`<${locatedTag.tag}> 缺少可替换的 group 属性`);
      }
      const orderLocation = node.sourceCodeLocation?.attrs?.order;
      const originalStartTag = source.slice(startTag.startOffset, startTag.endOffset);
      let updatedStartTag = originalStartTag;
      const relative = (location) => ({
        start: location.startOffset - startTag.startOffset,
        end: location.endOffset - startTag.startOffset,
      });
      const groupRelative = relative(groupLocation);
      updatedStartTag = `${updatedStartTag.slice(0, groupRelative.start)}group="${desiredGroup}"${updatedStartTag.slice(groupRelative.end)}`;

      if (orderLocation) {
        const orderRelative = relative(orderLocation);
        // The group replacement above does not affect the order offset when
        // both attributes are represented relative to the original tag; do
        // the second edit against the original string to avoid offset drift.
        const pieces = [
          {start: groupRelative.start, end: groupRelative.end, value: `group="${desiredGroup}"`},
          ...(desiredOrder === undefined
            ? [{
              start: Math.max(0, orderRelative.start - (/\s/.test(originalStartTag[orderRelative.start - 1] || "") ? 1 : 0)),
              end: orderRelative.end,
              value: "",
            }]
            : [{start: orderRelative.start, end: orderRelative.end, value: `order="${desiredOrder}"`}]),
        ];
        updatedStartTag = pieces
          .sort((left, right) => right.start - left.start)
          .reduce((text, piece) => `${text.slice(0, piece.start)}${piece.value}${text.slice(piece.end)}`, originalStartTag);
      } else if (desiredOrder !== undefined) {
        const insertion = groupRelative.end;
        updatedStartTag = `${originalStartTag.slice(0, insertion)} order="${desiredOrder}"${originalStartTag.slice(insertion)}`;
      }
      if (updatedStartTag !== originalStartTag) {
        replacements.push({start: startTag.startOffset, end: startTag.endOffset, value: updatedStartTag});
      }
    }
  }
  if (!targetDocumentOrders.size || ![...targetDocumentOrders].some((value) => nodeByDocumentOrder.has(value))) {
    throw new Error(`找不到新协议中的 <${tag}> 实例`);
  }

  let updated = source;
  replacements.sort((left, right) => right.start - left.start).forEach((replacement) => {
    updated = `${updated.slice(0, replacement.start)}${replacement.value}${updated.slice(replacement.end)}`;
  });
  return {html: updated, changedTagCount: target.tags.length};
}

module.exports = {
  listMgAnnotationInstances,
  parseMgAnnotation,
  replaceMgAnnotationStyle,
};
