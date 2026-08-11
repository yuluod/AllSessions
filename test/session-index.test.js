import test from "node:test";
import assert from "node:assert/strict";

import { MAX_INDEX_TEXT_CHARS, SessionSearchIndex } from "../server/session-index.js";

test("搜索索引不重复保存 token 集合并保持原有匹配语义", () => {
  const index = new SessionSearchIndex();

  index.add(
    "codex:first",
    {
      id: "first",
      _key: "codex:first",
      title: "Provider 可见性修复",
      cwd: "/tmp/project"
    },
    [
      { role: "user", text: "请分析隐藏会话" },
      { role: "assistant", text: "Repair provider history safely" }
    ]
  );
  index.add(
    "codex:second",
    { id: "second", _key: "codex:second", title: "其他会话" },
    [{ role: "assistant", text: "没有匹配内容" }]
  );

  assert.equal("index" in index, false);
  assert.deepEqual(Object.keys(index.documents.get("codex:first")), ["text"]);
  assert.deepEqual(index.search("prov").map((result) => result.key), ["codex:first"]);
  assert.deepEqual(index.search("隐藏 会话").map((result) => result.key), ["codex:first"]);
  assert.match(index.search("repair provider")[0].snippet, /Repair provider/i);

  index.delete("codex:first");
  assert.deepEqual(index.search("prov"), []);
});

test("搜索索引限制单会话正文并支持恢复持久化文本", () => {
  const index = new SessionSearchIndex();
  index.addText("codex:large", "x".repeat(MAX_INDEX_TEXT_CHARS + 100));

  assert.equal(index.getText("codex:large").length, MAX_INDEX_TEXT_CHARS);

  const restored = new SessionSearchIndex();
  restored.addText("codex:large", index.getText("codex:large"));
  assert.equal(restored.getText("codex:large"), index.getText("codex:large"));
});

test("搜索索引排除应用注入的系统上下文", () => {
  const index = new SessionSearchIndex();
  index.add(
    "codex:context",
    { id: "context", _key: "codex:context", title: "真实问题" },
    [
      { role: "user", text: "private-injected-token", synthetic_context: true },
      { role: "user", text: "真实可搜索内容" }
    ]
  );

  assert.deepEqual(index.search("private-injected-token"), []);
  assert.deepEqual(index.search("真实可搜索").map((result) => result.key), ["codex:context"]);
});
