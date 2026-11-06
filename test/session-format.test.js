import assert from "node:assert/strict";
import test from "node:test";

globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
};

const {
  displaySessionTitle,
  formatListTimestamp,
  isDefaultSessionSource,
  isSessionRunning,
  sessionNeedsLiveReload,
  sessionTimestamp,
  providerLabel,
} = await import("../public/session-format.js");

test("进行中标记以文件写入窗口为准并自然过期", () => {
  const now = 1_700_000_000_000;
  assert.equal(isSessionRunning({ file_mtime_ms: now - 10_000 }, now), true);
  assert.equal(isSessionRunning({ file_mtime_ms: now - 91_000 }, now), false);
  assert.equal(isSessionRunning({ file_mtime_ms: 0 }, now), false);
  assert.equal(isSessionRunning({}, now), false);
  assert.equal(isSessionRunning(undefined, now), false);
});

test("实时重载只在消息数、写入时间或最后时间变化时触发", () => {
  const current = {
    message_count: 10,
    file_mtime_ms: 1000,
    last_timestamp: "2024-01-01T00:00:10Z",
  };
  assert.equal(sessionNeedsLiveReload({ ...current }, current), false);
  assert.equal(
    sessionNeedsLiveReload({ ...current, message_count: 11 }, current),
    true
  );
  assert.equal(
    sessionNeedsLiveReload({ ...current, file_mtime_ms: 2000 }, current),
    true
  );
  assert.equal(
    sessionNeedsLiveReload(
      { ...current, last_timestamp: "2024-01-01T00:00:20Z" },
      current
    ),
    true
  );
  assert.equal(sessionNeedsLiveReload(null, current), false);
  assert.equal(sessionNeedsLiveReload({ ...current }, null), false);
});

test("自定义名称优先于原始标题，缺失时逐层回退", () => {
  assert.equal(
    displaySessionTitle({
      title: "原始标题",
      workspace: { display_name: "我的名字" },
    }),
    "我的名字"
  );
  assert.equal(displaySessionTitle({ title: "原始标题" }), "原始标题");
  assert.equal(
    displaySessionTitle({ title: "原始标题", workspace: { display_name: "" } }),
    "原始标题"
  );
  assert.equal(displaySessionTitle({}), "");
  assert.equal(displaySessionTitle(undefined), "");
});

test("Provider 优先显示服务商，缺失时回退模型名且不修改数据", () => {
  assert.equal(
    providerLabel({ model_provider: "anthropic", model: "claude" }),
    "anthropic"
  );
  const summary = Object.freeze({ model_provider: "unknown", model: "claude" });
  assert.equal(providerLabel(summary), "claude");
  assert.equal(providerLabel({ model: "gpt" }), "gpt");
  assert.equal(providerLabel({ model: "default" }), "default");
  assert.equal(providerLabel({ model: null }), "unknown");
  assert.equal(providerLabel(undefined), "unknown");
});

test("模型回退不依赖语言文案", async () => {
  const { setLang, getLang } = await import("../public/i18n.js");
  const previous = getLang();
  globalThis.document = {
    documentElement: { lang: "zh-CN" },
    querySelectorAll: () => [],
    querySelector: () => null,
  };
  try {
    setLang("en");
    assert.equal(providerLabel({ model: "claude" }), "claude");
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

test("默认来源形态不在会话列表重复展示", () => {
  assert.equal(isDefaultSessionSource("cli"), true);
  assert.equal(isDefaultSessionSource("ide"), true);
  assert.equal(isDefaultSessionSource("subagent"), false);
  assert.equal(isDefaultSessionSource("desktop"), false);
  assert.equal(isDefaultSessionSource(""), false);
  assert.equal(isDefaultSessionSource(undefined), false);
});

test("列表当天显示时间，跨日期与跨年份补充日期", () => {
  const now = new Date(2026, 9, 16, 12, 0);
  assert.equal(
    formatListTimestamp(new Date(2026, 9, 16, 9, 5).toISOString(), now),
    "09:05"
  );
  assert.match(
    formatListTimestamp(new Date(2026, 9, 15, 23, 16).toISOString(), now),
    /10月15日 23:16/
  );
  assert.match(
    formatListTimestamp(new Date(2025, 9, 15, 23, 16).toISOString(), now),
    /2025.*10月15日 23:16/
  );
  assert.equal(formatListTimestamp("bad-date", now), "bad-date");
});
