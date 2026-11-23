import assert from "node:assert/strict";
import test from "node:test";

test("默认跟随系统，手动偏好和旧版语言设置均保留", async (context) => {
  const values = new Map();
  const locales = ["zh-HK"];
  context.mock.method(globalThis.navigator, "languages", () => locales, {
    getter: true,
  });
  globalThis.localStorage = {
    getItem: (key) => values.get(key),
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  globalThis.document = {
    documentElement: {},
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const i18n = await import("../public/i18n.js");
  assert.equal(i18n.getLangPreference(), "system");
  assert.equal(i18n.getLang(), "zh");
  locales[0] = "fr-FR";
  assert.equal(i18n.refreshLanguage(), true);
  assert.equal(i18n.getLang(), "en");
  i18n.setLang("en");
  locales[0] = "zh-CN";
  assert.equal(i18n.refreshLanguage(), false);
  assert.equal(i18n.getLang(), "en");
  values.clear();
  values.set("codex_viewer_lang", "en");
  const migrated = await import("../public/i18n.js?legacy");
  assert.equal(migrated.getLangPreference(), "en");
  assert.equal(values.get("allsessions_lang"), "en");
  assert.equal(values.has("codex_viewer_lang"), false);
});
