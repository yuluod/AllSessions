import assert from "node:assert/strict";
import test from "node:test";

globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
};

const { formatListTimestamp, sessionTimestamp, providerLabel } =
  await import("../public/session-format.js");

test("Provider 优先显示服务商，缺失时明确标注模型且不修改数据", () => {
  assert.equal(
    providerLabel({ model_provider: "anthropic", model: "claude" }),
    "anthropic"
  );
  const summary = Object.freeze({ model_provider: "unknown", model: "claude" });
  assert.equal(providerLabel(summary), "模型：claude");
  assert.equal(providerLabel({ model: "gpt" }), "模型：gpt");
  assert.equal(providerLabel({ model: null }), "unknown");
  assert.equal(providerLabel(undefined), "unknown");
});

test("模型回退标签支持英文", async () => {
  const { setLang, getLang } = await import("../public/i18n.js");
  const previous = getLang();
  globalThis.document = {
    documentElement: { lang: "zh-CN" },
    querySelectorAll: () => [],
    querySelector: () => null,
  };
  try {
    setLang("en");
    assert.equal(providerLabel({ model: "claude" }), "Model: claude");
  } finally {
    setLang(previous);
    delete globalThis.document;
  }
});

test("会话列表优先展示最近活动时间", () => {
  assert.equal(
    sessionTimestamp({
      timestamp: "2026-08-20T12:53:50Z",
      last_timestamp: "2026-08-24T14:51:00Z",
    }),
    "2026-08-24T14:51:00Z"
  );
  assert.equal(
    sessionTimestamp({ timestamp: "2026-08-20T12:53:50Z" }),
    "2026-08-20T12:53:50Z"
  );
});

test("日期分组中的会话行只显示时间", () => {
  assert.match(formatListTimestamp("2026-08-24T14:51:00Z"), /^\d{2}:\d{2}$/);
});
