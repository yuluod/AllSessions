import assert from "node:assert/strict";
import test from "node:test";

globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
};

const {
  exportSessionCollection,
  exportSessionJson,
  exportSessionMarkdown,
  prepareExportDetail,
  redactText,
  sessionMarkdown,
} = await import("../public/session-export.js");
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

test("所有错误码都保留后端具体原因且不重复拼接", () => {
  assert.equal(
    translateBackendError("invalid_request", "该来源不支持恢复会话"),
    "请求参数无效: 该来源不支持恢复会话"
  );
  assert.equal(
    translateBackendError("invalid_request", "请求参数无效"),
    "请求参数无效"
  );
  assert.equal(translateBackendError("unknown_code", "原始消息"), null);
  assert.equal(translateBackendError("invalid_request", ""), "请求参数无效");
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

function mockExport(t, answer) {
  const warnings = [];
  const downloads = [];
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = {
    __TAURI_INTERNALS__: {
      invoke: async (command, warning) => {
        assert.equal(command, "plugin:dialog|message");
        warnings.push(warning);
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
  };
  globalThis.document = {
    createElement: () => ({ click() {} }),
  };
  t.mock.method(URL, "createObjectURL", (blob) => {
    downloads.push(blob);
    return "blob:synthetic";
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
  });
  return { downloads, warnings };
}

test("凭据提醒仅显示最终文件的行号、类型和计数，取消时不会生成下载", async (t) => {
  const { downloads, warnings } = mockExport(t, "取消");
  const detail = detailFixture();
  const samples = [
    `sk-proj-${"x".repeat(32)}`,
    `ghp_${"x".repeat(36)}`,
    `AKIA${"X".repeat(16)}`,
    `Bearer\t${"x".repeat(24)}`,
    "-----BEGIN OPENSSH PRIVATE KEY-----",
  ];
  detail.conversation_messages[0].text = `合成示例\r\n${samples.join("\r\n")}\r\n${samples[0]}\r\n${samples[0]}`;
  const lines = sessionMarkdown(prepareExportDetail(detail)).split(/\r?\n/);
  const credentialLine = lines.indexOf(samples[0]) + 1;
  await exportSessionMarkdown(detail);
  assert.equal(downloads.length, 0);
  assert.equal(warnings.length, 1);
  const { message } = warnings[0];
  assert.match(
    message,
    new RegExp(`第 ${credentialLine} 行 · OpenAI API 密钥`)
  );
  assert.match(message, /发现 7 处/);
  assert.match(
    message,
    /GitHub 令牌.*\n.*AWS 访问密钥 ID.*\n.*Bearer 令牌.*\n.*私钥块/
  );
  assert.match(message, /另有 1 处未列出/);
  for (const sample of samples) assert.equal(message.includes(sample), false);
});

test("完整和批量 JSON 导出在确认后下载原文件，扫描覆盖 JSON 转义换行", async (t) => {
  const { downloads, warnings } = mockExport(t, "仍然下载");
  const detail = detailFixture();
  const token = `ghp_${"y".repeat(36)}`;
  detail.raw_events = [{ payload: { command: `合成输出\n${token}` } }];
  detail.export_info = { scope: "full_session", partial: false };
  await exportSessionJson(detail, { full: true, redact: true });
  await exportSessionCollection([detailFixture(), detail], "json");
  assert.equal(warnings.length, 2);
  assert.equal(downloads.length, 2);
  for (let index = 0; index < downloads.length; index++) {
    const lines = (await downloads[index].text()).split("\n");
    const line = lines.findIndex((text) => text.includes(token)) + 1;
    assert.ok(line > 0);
    assert.match(
      warnings[index].message,
      new RegExp(`第 ${line} 行 · GitHub 令牌`)
    );
    assert.equal(warnings[index].message.includes(token), false);
  }
});

test("普通导出直接下载，凭据确认发生错误时中止并上报", async (t) => {
  const error = new Error("对话框不可用");
  const { downloads, warnings } = mockExport(t, error);
  const detail = detailFixture();
  detail.conversation_messages[0]._message_key = `ghp_${"z".repeat(36)}`;
  await exportSessionJson(detail, { redact: true });
  assert.equal(downloads.length, 1);
  assert.equal(warnings.length, 0);
  detail.conversation_messages[0].text = `ghp_${"z".repeat(36)}`;
  await assert.rejects(exportSessionJson(detail), error);
  assert.equal(downloads.length, 1);
  assert.equal(warnings.length, 1);
});

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

test("脱敏覆盖 UNC、扩展路径与更多 Unix 绝对路径", () => {
  assert.equal(redactText("tail /var/log/syslog"), "tail [local path]");
  assert.equal(
    redactText("打开 //server/share/client/main.rs"),
    "打开 [local path]"
  );
  assert.equal(
    redactText("拷贝 \\\\?\\C:\\Users\\alice\\c.toml"),
    "拷贝 [local path]"
  );
  assert.equal(
    redactText("查看 \\\\nas-01\\docs\\报告.md"),
    "查看 [local path]"
  );
  assert.equal(redactText("cd /tmp && ls"), "cd [local path] && ls");
  assert.equal(redactText("/etc/hosts"), "[local path]");
});

test("脱敏覆盖含空格 UNC 与单段系统根目录", () => {
  assert.equal(
    redactText("查看 \\\\nas-01\\My Share\\报告.md"),
    "查看 [local path]"
  );
  assert.equal(redactText("打开 /Applications"), "打开 [local path]");
  assert.equal(redactText("打开 /Library"), "打开 [local path]");
  assert.equal(redactText("打开 /home"), "打开 [local path]");
  assert.equal(redactText("打开 /Users"), "打开 [local path]");
});

test("脱敏不误伤 URL 与普通文本", () => {
  const url = "curl https://example.com/api/v1/list?id=7";
  assert.equal(redactText(url), url);
  assert.equal(redactText("对比 输入/输出 差异"), "对比 输入/输出 差异");
  assert.equal(redactText('cmd /c "calc"'), 'cmd /c "calc"');
  assert.equal(redactText("和 / 或"), "和 / 或");
  assert.equal(redactText("file:///var/tmp/x.txt"), "file:[local path]");
});

test("后端完整导出的 export_info 不被前端推算覆盖", () => {
  const detail = detailFixture();
  detail.export_info = {
    scope: "full_session",
    partial: false,
    message_count: 1,
    total_messages: 3,
    omitted_messages: 0,
    removed_messages: 2,
    export_limited: false,
    changed_during_read: false,
    parse_errors: 0,
    raw_events_omitted: 0,
    generated_at: "2026-11-13T00:00:00Z",
  };
  // 完整导出没有截断标记，若按已加载口径推算会把 partial 算成 false、
  // total_messages 算成 1，覆盖后端给的真实完整性口径。
  const prepared = prepareExportDetail(detail);

  assert.equal(prepared.export_info.scope, "full_session");
  assert.equal(prepared.export_info.total_messages, 3);
  assert.equal(prepared.export_info.removed_messages, 2);
  assert.match(sessionMarkdown(prepared), /完整会话导出：包含 1 条消息/);
});

test("完整导出的不完整标记使用对应文案", () => {
  const detail = detailFixture();
  detail.export_info = {
    scope: "full_session",
    partial: true,
    message_count: 1,
    total_messages: 4,
    omitted_messages: 3,
    removed_messages: 0,
    export_limited: true,
    changed_during_read: false,
    parse_errors: 0,
    raw_events_omitted: 0,
    generated_at: "2026-11-13T00:00:00Z",
  };
  assert.match(
    sessionMarkdown(prepareExportDetail(detail)),
    /完整导出（不完整）：包含 1 条消息/
  );
});
