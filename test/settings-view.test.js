import assert from "node:assert/strict";
import test from "node:test";

globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
};

const { summarizeSourceSupport } = await import("../public/settings-view.js");

test("来源概览按 Agent 去重并统计当前检测结果", () => {
  const result = summarizeSourceSupport({
    diagnostics: {
      sources: {
        codex: { enabled: true, available_roots: 1 },
        codex_archived: { enabled: true, available_roots: 1 },
        claude: { enabled: true, available_roots: 0 },
        opencode: { enabled: true, available_roots: 1 },
      },
    },
  });

  assert.deepEqual(result, { supported: 6, detected: 2 });
});
