import assert from "node:assert/strict";
import test from "node:test";
import { sourceRailItemState } from "../public/source-rail.js";

test("Claude Code 与 Cowork 分别计数且仅选中点击来源", () => {
  const diagnostics = {
    sources: {
      claude: { indexed_sessions: 32 },
      claude_cowork: { indexed_sessions: 1 },
      codex: { indexed_sessions: 100 },
      codex_archived: { indexed_sessions: 2 },
    },
  };
  for (const selected of ["claude_code", "claude_cowork"]) {
    const code = sourceRailItemState("claude_code", selected, diagnostics);
    const cowork = sourceRailItemState("claude_cowork", selected, diagnostics);
    assert.equal(code.active, selected === "claude_code");
    assert.equal(cowork.active, selected === "claude_cowork");
    assert.equal(code.count, "32");
    assert.equal(cowork.count, "1");
    assert.equal(sourceRailItemState("", selected, diagnostics).count, "135");
  }
  assert.equal(
    sourceRailItemState("codex", "codex_archived", diagnostics).count,
    "102"
  );
  assert.equal(
    sourceRailItemState("codex", "codex_archived", diagnostics).active,
    true
  );
  diagnostics.sources.claude_cowork.indexed_sessions = 0;
  assert.equal(
    sourceRailItemState("claude_cowork", "claude_code", diagnostics).empty,
    true
  );
  assert.equal(
    sourceRailItemState("claude_cowork", "claude_cowork", diagnostics).empty,
    false
  );
});
