import test from "node:test";
import assert from "node:assert/strict";

import { SessionSearchIndex } from "../server/session-index.js";

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
