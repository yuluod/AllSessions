import assert from "node:assert/strict";
import test from "node:test";

globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
};

const { prepareExportDetail, sessionMarkdown } =
  await import("../public/session-export.js");
const { translateBackendError } = await import("../public/i18n.js");

test("长会话导出注明省略范围且不把占位符算作消息", () => {
  const detail = detailFixture();
  detail.conversation_messages.push({
    is_truncation_marker: true,
    omitted_count: 999,
  });
  detail.truncation = {
    truncated: true,
    messages: { total: 1000, omitted: 999 },
  };
  const prepared = prepareExportDetail(detail);
  assert.equal(prepared.export_info.partial, true);
  assert.equal(prepared.export_info.message_count, 1);
  assert.equal(prepared.export_info.total_messages, 1000);
  assert.match(sessionMarkdown(prepared), /部分内容导出/);
  assert.match(sessionMarkdown(prepared), /不是完整会话备份/);
  assert.equal(detail.export_info, undefined);
});

test("单条正文截断和搜索片段均不能标记为完整导出", () => {
  const detail = detailFixture();
  detail.conversation_messages[0].text_truncated = true;
  assert.equal(prepareExportDetail(detail).export_info.text_truncated, true);
  assert.equal(prepareExportDetail(detail).export_info.partial, true);
  delete detail.conversation_messages[0].text_truncated;
  detail.search_context = true;
  assert.equal(prepareExportDetail(detail).export_info.partial, true);
  assert.equal(prepareExportDetail(detail).export_info.total_messages, null);
});

test("普通导出记录消息数量且读取错误保留实际原因", () => {
  const prepared = prepareExportDetail(detailFixture());
  assert.equal(prepared.export_info.partial, false);
  assert.equal(prepared.export_info.message_count, 1);
  assert.match(sessionMarkdown(prepared), /包含 1 条消息/);
  assert.match(
    translateBackendError("session_read_failed", "database is locked"),
    /database is locked/
  );
  assert.match(
    translateBackendError("session_read_failed", "权限不足"),
    /无法读取会话详情/
  );
});

test("仅原始事件载荷被截断时也标记部分导出", () => {
  const detail = detailFixture();
  detail.conversation_messages[0].text = "a".repeat(11_000);
  detail.truncation = {
    truncated: false,
    messages: { total: 1, omitted: 0 },
    raw_events: { total: 1, omitted: 0 },
  };
  detail.raw_events = [
    {
      type: "event_msg",
      payload: { truncated: true, original_chars: 11_100 },
    },
  ];

  for (const redact of [false, true]) {
    const prepared = prepareExportDetail(detail, { redact });
    assert.equal(prepared.export_info.partial, true);
    assert.equal(prepared.export_info.text_truncated, false);
    assert.equal(prepared.export_info.total_messages, 1);
    assert.match(sessionMarkdown(prepared), /部分内容导出/);
  }

  detail.raw_events[0].payload = { truncated: false };
  assert.equal(prepareExportDetail(detail).export_info.partial, false);
});

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
