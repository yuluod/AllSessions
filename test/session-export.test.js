import assert from "node:assert/strict";
import test from "node:test";

globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
};

const { prepareExportDetail } = await import("../public/session-export.js");

function detailFixture() {
  return {
    summary: {
      _key: "codex:session-123",
      id: "session-123",
      cwd: "/Users/alice/work/private-project",
      file_path: "/Users/alice/.codex/sessions/session-123.jsonl",
      title: "修复 /home/alice/private/app.js",
    },
    conversation_messages: [
      {
        role: "user",
        text: "请检查 C:\\Users\\alice\\secret\\config.toml",
        _message_key: "message-1",
        _removed: false,
      },
    ],
  };
}

test("普通导出保留来源信息但移除内部实现字段", () => {
  const original = detailFixture();
  const prepared = prepareExportDetail(original);

  assert.equal(prepared.summary.id, "session-123");
  assert.equal(prepared.summary.cwd, "/Users/alice/work/private-project");
  assert.equal(prepared.conversation_messages[0]._message_key, undefined);
  assert.equal(prepared.conversation_messages[0]._removed, undefined);
  assert.equal(original.conversation_messages[0]._message_key, "message-1");
});

test("显式开启脱敏后隐藏标识和常见本地路径", () => {
  const prepared = prepareExportDetail(detailFixture(), { redact: true });

  assert.equal(prepared.summary._key, "[redacted]");
  assert.equal(prepared.summary.id, "[redacted]");
  assert.equal(prepared.summary.cwd, "[local path]");
  assert.equal(prepared.summary.file_path, "[local path]");
  assert.equal(prepared.summary.title, "修复 [local path]");
  assert.equal(prepared.conversation_messages[0].text, "请检查 [local path]");
});

test("脱敏会完整隐藏包含空格的本地路径", () => {
  const detail = detailFixture();
  detail.summary.title = "打开 /Users/alice/My Project/secret.txt";
  detail.conversation_messages[0].text =
    "检查 C:\\Users\\alice\\My Project\\secret.txt";

  const prepared = prepareExportDetail(detail, { redact: true });

  assert.equal(prepared.summary.title, "打开 [local path]");
  assert.equal(prepared.conversation_messages[0].text, "检查 [local path]");
});
