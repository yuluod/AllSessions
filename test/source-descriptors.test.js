import assert from "node:assert/strict";
import test from "node:test";
import {
  SOURCE_DESCRIPTORS,
  SOURCE_RAIL_AGENTS,
  agentPresentation,
} from "../public/source-descriptors.js";

test("来源定义唯一，配置类型和列表别名均落到正确分组", () => {
  assert.equal(
    new Set(SOURCE_DESCRIPTORS.map((source) => source.key)).size,
    SOURCE_DESCRIPTORS.length
  );
  const kinds = SOURCE_RAIL_AGENTS.flatMap((source) => source.kinds);
  assert.equal(new Set(kinds).size, kinds.length);
  for (const source of SOURCE_DESCRIPTORS) {
    assert.ok(source.colorToken.startsWith("--"));
    assert.ok(kinds.includes(source.key));
    assert.equal(agentPresentation(source.key).label, source.label);
  }
  assert.ok(
    SOURCE_RAIL_AGENTS.find(
      (source) => source.agent === "claude"
    ).kinds.includes("claude_code")
  );
  assert.ok(
    SOURCE_RAIL_AGENTS.find(
      (source) => source.agent === "copilot"
    ).kinds.includes("vscode_copilot")
  );
  assert.equal(agentPresentation("new-agent").colorToken, "--line-strong");
  assert.equal(agentPresentation("new-agent").label, "new-agent");
});
