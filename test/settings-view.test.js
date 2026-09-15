import assert from "node:assert/strict";
import test from "node:test";

globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
};

const { summarizeSourceSupport } = await import("../public/settings-view.js");

test("重新扫描只更新诊断视图而不覆盖设置草稿", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(
    new URL("../public/settings-view.js", import.meta.url),
    "utf8"
  );
  const rescan = source.slice(
    source.indexOf("async function rescanSources()"),
    source.indexOf("async function checkForUpdates()")
  );
  assert.doesNotMatch(rescan, /applyPayload|draft\s*=|renderPreferences/);
  assert.match(rescan, /renderSources\(latestPayload\)/);
  assert.match(rescan, /renderDiagnostics\(latestPayload\)/);
});

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

  assert.deepEqual(result, { supported: 9, detected: 2 });
});
