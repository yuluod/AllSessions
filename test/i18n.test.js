import assert from "node:assert/strict";
import test from "node:test";

function installStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  globalThis.localStorage = {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
  return data;
}

let importCounter = 0;
async function loadI18n(storage = {}, languages = ["en-US"]) {
  const data = installStorage(storage);
  Object.defineProperty(globalThis, "navigator", {
    value: { languages, language: languages[0] },
    configurable: true,
    writable: true,
  });
  const module = await import(`../public/i18n.js?case=${++importCounter}`);
  return { module, data };
}

test("跟随系统时中文区域解析为 zh，其余解析为 en", async () => {
  const { module } = await loadI18n();
  const { resolveLang, LANG_SYSTEM } = module;
  assert.equal(resolveLang(LANG_SYSTEM, ["zh-CN", "en-US"]), "zh");
  assert.equal(resolveLang(LANG_SYSTEM, ["zh-Hant-TW"]), "zh");
  assert.equal(resolveLang(LANG_SYSTEM, ["ZH"]), "zh");
  assert.equal(resolveLang(LANG_SYSTEM, ["en-GB", "zh-CN"]), "en");
  assert.equal(resolveLang(LANG_SYSTEM, ["ja-JP"]), "en");
  assert.equal(resolveLang(LANG_SYSTEM, ["zhx"]), "en");
  assert.equal(resolveLang(LANG_SYSTEM, []), "en");
  assert.equal(resolveLang("zh", ["en-US"]), "zh");
  assert.equal(resolveLang("en", ["zh-CN"]), "en");
});

test("未保存偏好时默认跟随系统语言", async () => {
  const english = await loadI18n({}, ["en-US"]);
  assert.equal(english.module.getLangPreference(), "system");
  assert.equal(english.module.getLang(), "en");
  assert.equal(english.module.t("languageSystem"), "Follow system");

  const chinese = await loadI18n({}, ["zh-CN"]);
  assert.equal(chinese.module.getLang(), "zh");
  assert.equal(chinese.module.t("languageSystem"), "跟随系统");
});

test("已保存的显式语言优先于系统语言", async () => {
  const { module } = await loadI18n({ allsessions_lang: "zh" }, ["en-US"]);
  assert.equal(module.getLangPreference(), "zh");
  assert.equal(module.getLang(), "zh");
});

test("旧版语言键迁移为显式偏好，无效值回退为跟随系统", async () => {
  const legacy = await loadI18n({ codex_viewer_lang: "en" }, ["zh-CN"]);
  assert.equal(legacy.module.getLang(), "en");
  assert.equal(legacy.data.get("allsessions_lang"), "en");
  assert.equal(legacy.data.has("codex_viewer_lang"), false);

  const invalid = await loadI18n({ allsessions_lang: "fr" }, ["zh-CN"]);
  assert.equal(invalid.module.getLangPreference(), "system");
  assert.equal(invalid.module.getLang(), "zh");
});

test("切换偏好会持久化并仅在界面语言变化时通知", async () => {
  const { module, data } = await loadI18n({}, ["en-US"]);
  const changes = [];
  module.onLangChange((lang) => changes.push(lang));

  assert.equal(module.setLangPreference("en"), false);
  assert.equal(data.get("allsessions_lang"), "en");
  assert.equal(module.setLangPreference("zh"), true);
  assert.equal(module.setLangPreference("system"), true);
  assert.equal(data.get("allsessions_lang"), "system");
  assert.equal(module.getLangPreference(), "system");
  assert.equal(module.setLangPreference("bogus"), false);
  assert.equal(module.getLangPreference(), "system");
  assert.deepEqual(changes, ["zh", "en"]);
});

test("系统语言变化只影响跟随系统的偏好", async () => {
  const { module } = await loadI18n({}, ["en-US"]);
  globalThis.navigator.languages = ["zh-CN"];
  assert.equal(module.refreshSystemLang(), true);
  assert.equal(module.getLang(), "zh");

  module.setLangPreference("en");
  globalThis.navigator.languages = ["zh-TW"];
  assert.equal(module.refreshSystemLang(), false);
  assert.equal(module.getLang(), "en");
});
