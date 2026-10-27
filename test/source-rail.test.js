import assert from "node:assert/strict";
import test from "node:test";
import { sourceRailItemState } from "../public/source-rail.js";

test("Claude Code 与 Cowork 分别计数且仅选中点击来源", () => {
  const counts = {
    claude: 32,
    claude_cowork: 1,
    codex: 100,
    codex_archived: 2,
  };
  for (const selected of ["claude_code", "claude_cowork"]) {
    const code = sourceRailItemState("claude_code", selected, counts);
    const cowork = sourceRailItemState("claude_cowork", selected, counts);
    assert.equal(code.active, selected === "claude_code");
    assert.equal(cowork.active, selected === "claude_cowork");
    assert.equal(code.count, "32");
    assert.equal(cowork.count, "1");
    assert.equal(sourceRailItemState("", selected, counts).count, "135");
  }
  assert.equal(
    sourceRailItemState("codex", "codex_archived", counts).count,
    "102"
  );
  assert.equal(
    sourceRailItemState("codex", "codex_archived", counts).active,
    true
  );
  counts.claude_cowork = 0;
  assert.equal(
    sourceRailItemState("claude_cowork", "claude_code", counts).empty,
    true
  );
  assert.equal(
    sourceRailItemState("claude_cowork", "claude_cowork", counts).empty,
    false
  );
});

test("facets 尚未加载时计数显示占位", () => {
  const item = sourceRailItemState("codex", "", null);
  assert.equal(item.count, "-");
  assert.equal(item.empty, false);
});
