import assert from "node:assert/strict";
import test from "node:test";

globalThis.localStorage = {
  getItem: (key) => (key === "allsessions_lang" ? "zh" : null),
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

class PreviewElement extends EventTarget {
  children = [];
  #text = "";
  set textContent(text) {
    this.#text = text;
    this.children = [];
  }
  get textContent() {
    return this.#text;
  }
  closest() {
    return this;
  }
  focus() {}
  click() {
    this.dispatchEvent(new Event("click"));
  }
  append(child) {
    this.children.push(child);
  }
  replaceChildren(...children) {
    this.children = children;
  }
  scrollIntoView() {}
}

function mockExport(t, redact) {
  const downloads = [];
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  globalThis.window = {
    __TAURI__: {
      core: {
        invoke: async (_, { request }) => {
          if (request.url === "/api/settings/export-redaction") {
            return {
              enabled: Boolean(redact),
              patterns: redact ? ["alice"] : [],
            };
          }
          assert.equal(request.url, "/api/export/redact");
          return redact(request.body.document);
        },
      },
    },
  };
  const selectors = new Map();
  const dialog = new PreviewElement();
  dialog.querySelector = (selector) => {
    if (!selectors.has(selector)) selectors.set(selector, new PreviewElement());
    return selectors.get(selector);
  };
  dialog.showModal = () => {
    dialog.open = true;
  };
  dialog.close = (value) => {
    if (value !== undefined) dialog.returnValue = value;
    dialog.open = false;
    dialog.dispatchEvent(new Event("close"));
  };
  globalThis.document = {
    querySelector: () => dialog,
    createElement: () => new PreviewElement(),
  };
  t.mock.method(URL, "createObjectURL", (blob) => {
    downloads.push(blob);
    return "blob:synthetic";
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  });
  return { dialog, downloads, field: dialog.querySelector };
}

async function waitForPreview(dialog) {
  await new Promise(setImmediate);
  assert.equal(dialog.open, true);
}

test("预览列出类型和行号，跳到实际命中位置，取消后清除内容且不下载", async (t) => {
  const { dialog, downloads, field } = mockExport(t);
  const detail = detailFixture();
  const samples = [
    `sk-proj-${"x".repeat(32)}`,
    `ghp_${"x".repeat(36)}`,
    `AKIA${"X".repeat(16)}`,
    `Bearer\t${"x".repeat(24)}`,
    "-----BEGIN OPENSSH PRIVATE KEY-----",
  ];
  detail.conversation_messages[0].text = `合成示例\r\n${samples.join("\r\n")}`;
  const expected = sessionMarkdown(prepareExportDetail(detail));
  const line = expected.split(/\r?\n/).indexOf(samples[0]) + 1;
  const exporting = exportSessionMarkdown(detail);
  await waitForPreview(dialog);
  const hits = field("#export-preview-hits").children;
  assert.equal(hits.length, 5);
  assert.match(field("#export-preview-warning").textContent, /发现 5 处/);
  assert.match(
    hits[0].textContent,
    new RegExp(`第 ${line} 行 · OpenAI API 密钥`)
  );
  for (const sample of samples) {
    assert.ok(hits.every((entry) => !entry.textContent.includes(sample)));
  }
  hits[0].onclick();
  assert.equal(field("pre").children[1].textContent, samples[0]);
  dialog.close("cancel");
  await exporting;
  assert.equal(downloads.length, 0);
  assert.deepEqual(field("pre").children, []);
});

test("完整和批量 JSON 下载预览中的内容，脱敏可切换且扫描覆盖转义换行", async (t) => {
  const { dialog, downloads, field } = mockExport(t);
  const detail = detailFixture();
  const token = `ghp_${"y".repeat(36)}`;
  detail.raw_events = [{ payload: { command: `合成输出\n${token}` } }];
  detail.export_info = { scope: "full_session", partial: false };
  for (const exportFile of [
    () => exportSessionJson(detail, { full: true }),
    () => exportSessionCollection([detailFixture(), detail], "json"),
  ]) {
    const exporting = exportFile();
    await waitForPreview(dialog);
    assert.match(field("pre").textContent, /alice/);
    const toggle = field("input");
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change"));
    const preview = field("pre").textContent;
    assert.doesNotMatch(preview, /alice/);
    assert.match(preview, /\[local path\]/);
    const line =
      preview.split("\n").findIndex((text) => text.includes(token)) + 1;
    assert.ok(line > 0);
    const hit = field("#export-preview-hits").children[0];
    assert.match(hit.textContent, new RegExp(`第 ${line} 行 · GitHub 令牌`));
    dialog.close("download");
    await exporting;
    assert.equal(await downloads.at(-1).text(), preview);
  }
});

test("无凭据的导出同样需要确认，预览异常不生成文件", async (t) => {
  const { dialog, downloads, field } = mockExport(t);
  const detail = detailFixture();
  detail.conversation_messages[0]._message_key = `ghp_${"z".repeat(36)}`;
  const preview = exportSessionJson(detail);
  await waitForPreview(dialog);
  assert.equal(downloads.length, 0);
  assert.equal(field("#export-preview-warning").textContent, "");
  dialog.close("download");
  await preview;
  assert.equal(downloads.length, 1);
  dialog.showModal = () => {
    throw new Error("预览不可用");
  };
  await assert.rejects(exportSessionJson(detail), /预览不可用/);
  assert.equal(downloads.length, 1);
});

test("自定义规则应用于预览和下载，处理失败时终止导出", async (t) => {
  let fail = false;
  const { dialog, downloads, field } = mockExport(t, (document) => {
    if (fail) throw new Error("脱敏失败");
    return JSON.parse(
      JSON.stringify(document).replaceAll("alice", "[redacted]")
    );
  });
  for (const exportFile of [exportSessionJson, exportSessionMarkdown]) {
    const exporting = exportFile(detailFixture());
    await waitForPreview(dialog);
    const preview = field("pre").textContent;
    assert.doesNotMatch(preview, /alice/);
    assert.match(preview, /\[redacted\]/);
    assert.equal(field("#export-preview-custom-redaction").hidden, false);
    dialog.close("download");
    await exporting;
    assert.equal(await downloads.at(-1).text(), preview);
  }
  fail = true;
  await assert.rejects(exportSessionJson(detailFixture()), /脱敏失败/);
  assert.equal(downloads.length, 2);
  assert.equal(dialog.open, false);
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
