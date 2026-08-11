import test from "node:test";
import assert from "node:assert/strict";

import {
  matchesSessionFilters,
  readPageLimit,
  readSessionFilters,
  sanitizeQueryValue
} from "../server/session-query.js";

test("分页上限始终限制在安全范围内", () => {
  assert.equal(readPageLimit(new URLSearchParams()), 50);
  assert.equal(readPageLimit(new URLSearchParams("limit=0")), 50);
  assert.equal(readPageLimit(new URLSearchParams("limit=-3")), 50);
  assert.equal(readPageLimit(new URLSearchParams("limit=nope")), 50);
  assert.equal(readPageLimit(new URLSearchParams("limit=17")), 17);
  assert.equal(readPageLimit(new URLSearchParams("limit=500")), 200);
});

test("会话查询解析与 Store 匹配共享同一组可见性语义", () => {
  const filters = readSessionFilters(new URLSearchParams(
    "provider=custom&source_kind=codex&date=2026-04-21&cwd=%2Ftmp%2Fproject&show_hidden=1"
  ));
  const summary = {
    model_provider: "custom",
    source_kind: "codex",
    timestamp: "2026-04-21T10:00:00.000Z",
    cwd: "/tmp/project",
    hidden: true,
    hidden_reason: "subagent"
  };

  assert.equal(matchesSessionFilters(summary, filters), true);
  assert.equal(matchesSessionFilters(summary, { ...filters, show_hidden: false }), false);
  assert.equal(matchesSessionFilters({ ...summary, model_provider: "openai" }, filters), false);
});

test("查询值移除控制字符并限制长度", () => {
  assert.equal(sanitizeQueryValue("abc\u0000def"), "abcdef");
  assert.equal(sanitizeQueryValue("x".repeat(300)).length, 256);
});
