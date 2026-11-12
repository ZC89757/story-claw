/* Explicit UI bindings only: never walk user content or observe arbitrary DOM changes. */
(function (root) {
  const catalogs = typeof module === 'object' && module.exports
    ? require('./locales.cjs') : root.storyClawLocales;
  const STORAGE_KEY = 'story-claw.ui-language';
  const supported = ['system', 'zh-CN', 'en', 'ru'];
  function resolveLocale(preference, languages = []) {
    if (supported.includes(preference) && preference !== 'system') return preference;
    for (const language of languages) {
      const base = String(language).toLowerCase().split(/[-_]/)[0];
      if (base === 'zh') return 'zh-CN';
      if (base === 'en' || base === 'ru') return base;
    }
    return 'en';
  }
  function translate(locale, key, values = []) {
    const source = String(key ?? '');
    const catalog = Object.hasOwn(catalogs, locale) ? catalogs[locale] : catalogs.en;
    const template = locale === 'zh-CN' ? source
      : Object.hasOwn(catalog, source) ? catalog[source]
      : Object.hasOwn(catalogs.en, source) ? catalogs.en[source] : source;
    // Replacement callbacks keep dollar signs and markup in user values literal.
    return template.replace(/\{(\d+)\}/g, (match, index) => index < values.length ? String(values[index]) : match);
  }
  function createI18n({ storage, languages = [], document } = {}) {
    let preference = 'system';
    try { const saved = storage?.getItem(STORAGE_KEY); if (supported.includes(saved)) preference = saved; } catch {}
    let locale = resolveLocale(preference, languages);
    const bindings = new Map();
    let bindingCount = 0;
    const t = (key, values) => translate(locale, key, values);
    // Legacy workers emit Chinese phase details; localize only these known formats.
    const phaseFormats = [
      [/^(.*) 正在准备视觉标签视频流水线$/, '{0} 正在准备视觉标签视频流水线'],
      [/^(.*) 正在生成分场与分镜规划$/, '{0} 正在生成分场与分镜规划'],
      [/^(.*) 正在读取并清理原始章节$/, '{0} 正在读取并清理原始章节'],
      [/^已完成 (\d+) \/ (\d+) 个场景$/, '已完成 {0} / {1} 个场景'],
      [/^(.*) · 已完成 (\d+) \/ (\d+) 个镜头$/, '{0} · 已完成 {1} / {2} 个镜头'],
    ];
    function phaseText(source) {
      for (const [pattern, key] of phaseFormats) {
        const match = String(source ?? '').match(pattern);
        if (match) return t(key, match.slice(1));
      }
      return t(source);
    }
    function bind(node, attribute, getter) {
      if (!node) return;
      if (++bindingCount % 100 === 0) {
        queueMicrotask(() => {
          for (const existing of bindings.keys()) if (!existing.isConnected) bindings.delete(existing);
        });
      }
      let entries = bindings.get(node);
      if (!entries) bindings.set(node, entries = new Map());
      const entry = { getter, rendered: null };
      entries.set(attribute, entry);
      render(node, attribute, entry);
    }
    function render(node, attribute, entry) {
      const value = t(entry.getter());
      if (attribute === 'textContent') node.textContent = value;
      else node.setAttribute(attribute, value);
      entry.rendered = value;
    }
    function localize(container) {
      // Called only for initial, authored UI and trusted UI fragments.
      const walker = document.createTreeWalker(container, 4);
      const nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      for (const node of nodes) {
        if (node.parentElement?.closest('script, style, [data-i18n-ignore]')) continue;
        const source = node.textContent;
        const key = source.trim();
        if (Object.hasOwn(catalogs.en, key)) bind(node, 'textContent', () => source.replace(key, () => t(key)));
      }
      for (const element of [container, ...container.querySelectorAll('*')]) {
        if (element.closest('[data-i18n-ignore]')) continue;
        for (const attribute of ['aria-label', 'title', 'placeholder']) {
          const source = element.getAttribute(attribute);
          if (source && Object.hasOwn(catalogs.en, source)) {
            if (attribute === "placeholder") element.dataset.i18nPlaceholder = source;
            bind(element, attribute, () => source);
          }
        }
      }
    }
    function refresh() {
      if (document) document.documentElement.lang = locale;
      for (const [node, entries] of bindings) {
        if (!node.isConnected) { bindings.delete(node); continue; }
        for (const [attribute, entry] of entries) {
          // A later raw write belongs to application/user data, not to this binding.
          const current = attribute === 'textContent' ? node.textContent : node.getAttribute(attribute);
          if (current !== entry.rendered) { entries.delete(attribute); continue; }
          render(node, attribute, entry);
        }
      }
    }
    function setPreference(value) {
      if (!supported.includes(value)) return false;
      preference = value;
      locale = resolveLocale(preference, languages);
      let saved = Boolean(storage);
      try { storage?.setItem(STORAGE_KEY, preference); } catch { saved = false; }
      refresh();
      return saved;
    }
    return {
      t, phaseText, get locale() { return locale; }, get preference() { return preference; }, setPreference,
      bindText: (node, getter) => bind(node, 'textContent', getter),
      bindAttribute: (node, attribute, getter) => bind(node, attribute, getter),
      localize,
      setHTML(node, html) { node.innerHTML = html; localize(node); },
    };
  }
  if (typeof module === 'object' && module.exports) {
    module.exports = { resolveLocale, translate, createI18n, STORAGE_KEY };
  } else {
    let storage;
    try { storage = root.localStorage; } catch {}
    const i18n = createI18n({ storage, languages: root.navigator.languages, document: root.document });
    root.storyClawI18n = i18n;
    root.document.documentElement.lang = i18n.locale;
    for (const container of root.document.querySelectorAll('.claw-app, .claw-settings-dialog')) i18n.localize(container);
    for (const select of root.document.querySelectorAll('[data-ui-language]')) {
      select.value = i18n.preference;
      select.addEventListener('change', () => {
        const saved = i18n.setPreference(select.value);
        const status = root.document.querySelector('[data-language-status]');
        if (status) i18n.bindText(status, () => saved ? '' : '无法保存语言偏好，本次切换仍然生效。');
      });
    }
  }
})(globalThis);
