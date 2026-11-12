const test = require('node:test');
const assert = require('node:assert/strict');
const {resolveLocale, translate, createI18n, STORAGE_KEY} = require('./renderer/i18n.cjs');
const catalogs = require('./renderer/locales.cjs');

test('locale detection supports regional variants, preferences and English fallback', () => {
  assert.equal(resolveLocale('system', ['ru-RU', 'en-US']), 'ru');
  assert.equal(resolveLocale('system', ['zh-TW']), 'zh-CN');
  assert.equal(resolveLocale('system', ['de-DE', 'en-GB']), 'en');
  assert.equal(resolveLocale('system', ['fr-FR']), 'en');
  assert.equal(resolveLocale('ru', ['zh-CN']), 'ru');
  assert.equal(resolveLocale('corrupt', ['zh-CN']), 'zh-CN');
});
test('all catalogs have identical keys and preserve every placeholder', () => {
  assert.deepEqual(Object.keys(catalogs.en), Object.keys(catalogs.ru));
  for (const catalog of Object.values(catalogs)) for (const [key, value] of Object.entries(catalog)) {
    assert.ok(value.trim(), key);
    const slots = text => [...text.matchAll(/\{\d+\}/g)].map(x => x[0]).sort();
    assert.deepEqual(slots(value), slots(key), key);
  }
});
test('formatting preserves user values literally and unknown diagnostics verbatim', () => {
  assert.equal(translate('ru', '第 {0} 集', [3]), 'Эпизод 3');
  assert.equal(translate('zh-CN', '第 {0} 集', [3]), '第 3 集');
  assert.equal(translate('en', '已选择文件：{0}', ['<b>$&</b>']), 'Selected file: <b>$&</b>');
  assert.equal(translate('en', 'A backend diagnostic'), 'A backend diagnostic');
});
function element(text = '') {
  const attributes = new Map();
  return { isConnected: true, textContent: text, setAttribute(k,v) {attributes.set(k,v);}, getAttribute(k) {return attributes.get(k);} };
}
test('live switching updates UI bindings without overwriting user text or reloading', () => {
  const values = new Map();
  const storage = {getItem: k => values.get(k), setItem: (k,v) => values.set(k,v)};
  const doc = {documentElement: {lang: ''}};
  const i18n = createI18n({storage, languages:['zh-CN'], document:doc});
  const ui = element(), dynamic = element(), user = element('首页'), overwritten = element();
  i18n.bindText(ui, () => '首页');
  i18n.bindText(dynamic, () => i18n.t('第 {0} 集', [2]));
  i18n.bindText(overwritten, () => '发送');
  overwritten.textContent = 'User content';
  i18n.bindAttribute(ui, 'aria-label', () => '系统设置');
  assert.equal(i18n.setPreference('ru'), true);
  assert.equal(ui.textContent, 'Главная');
  assert.equal(ui.getAttribute('aria-label'), 'Системные настройки');
  assert.equal(dynamic.textContent, 'Эпизод 2');
  assert.equal(user.textContent, '首页');
  assert.equal(overwritten.textContent, 'User content');
  assert.equal(doc.documentElement.lang, 'ru');
  assert.equal(values.get(STORAGE_KEY), 'ru');
  assert.equal(createI18n({storage, languages:['zh-CN']}).locale, 'ru');
  i18n.setPreference('system');
  assert.equal(ui.textContent, '首页');
  assert.equal(dynamic.textContent, '第 2 集');
});
test('storage failure and invalid preferences do not break the UI', () => {
  const storage = {getItem(){throw Error('denied');},setItem(){throw Error('denied');}};
  const i18n = createI18n({storage, languages:['ru-RU']});
  assert.equal(i18n.locale,'ru');
  assert.equal(i18n.setPreference('en'),false);
  assert.equal(i18n.locale,'en');
  assert.equal(i18n.setPreference('invalid'),false);
  assert.equal(i18n.locale,'en');
});

test('unknown object-property names remain literal and cannot crash rendering', () => {
  for (const key of ['constructor', '__proto__', 'toString']) assert.equal(translate('en', key), key);
});
test('worker progress formatting translates only known status shapes', () => {
  const i18n = createI18n({languages:['en-US']});
  assert.equal(i18n.phaseText('首页 · 已完成 2 / 3 个镜头'), '首页 · Shots completed: 2 / 3');
  assert.equal(i18n.phaseText('已完成 2 / 3 个场景'), 'Scenes completed: 2 / 3');
  assert.equal(i18n.phaseText('Unexpected backend diagnostic'), 'Unexpected backend diagnostic');
});
