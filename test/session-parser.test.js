import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  parseCodexContent as parseSessionContent,
  parseCodexFile,
  parseCodexFileSummary
} from "../server/parsers/codex.js";
import { parseGeminiSessions } from "../server/parsers/index.js";
import { parseCodexArchivedFile } from "../server/parsers/codex.js";
import {
  parseClaudeCodeFile,
  parseClaudeCodeFileSummary
} from "../server/parsers/claude-code.js";

async function createTempSessionDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "codex-session-viewer-"));
}

test("能从标准会话中提取摘要和对话消息", () => {
  const content = [
    JSON.stringify({
      timestamp: "2026-04-21T10:00:00.000Z",
      type: "session_meta",
      payload: {
        id: "session-1",
        timestamp: "2026-04-21T10:00:00.000Z",
        cwd: "/tmp/project-a",
        source: "cli",
        originator: "codex_cli_rs",
        model_provider: "current_provider"
      }
    }),
    JSON.stringify({
      timestamp: "2026-04-21T10:00:01.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "你好" }]
      }
    }),
    JSON.stringify({
      timestamp: "2026-04-21T10:00:02.000Z",
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: "你好，我可以帮你查看会话。"
      }
    })
  ].join("\n");

  const detail = parseSessionContent(content, "/tmp/session-1.jsonl");

  assert.equal(detail.summary.id, "session-1");
  assert.equal(detail.summary.model_provider, "current_provider");
  assert.equal(detail.summary.cwd, "/tmp/project-a");
  assert.equal(detail.summary.event_count, 3);
  assert.equal(detail.summary.title, "你好");
  assert.equal(detail.summary.preview_text, "你好，我可以帮你查看会话。");
  assert.equal(detail.summary.message_count, 2);
  assert.deepEqual(detail.summary.role_counts, { user: 1, assistant: 1 });
  assert.equal(detail.summary.tool_count, 0);
  assert.equal(detail.conversation_messages.length, 2);
  assert.equal(detail.conversation_messages[0].role, "user");
  assert.match(detail.conversation_messages[1].text, /查看会话/);
});

test("Codex 同一消息的 event_msg 与 response_item 记录只展示一次", () => {
  const content = [
    JSON.stringify({
      timestamp: "2026-04-21T10:00:01.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "重复的用户问题" }]
      }
    }),
    JSON.stringify({
      timestamp: "2026-04-21T10:00:01.010Z",
      type: "event_msg",
      payload: { type: "user_message", message: "重复的用户问题" }
    }),
    JSON.stringify({
      timestamp: "2026-04-21T10:00:02.000Z",
      type: "event_msg",
      payload: { type: "agent_message", message: "重复的助手回答" }
    }),
    JSON.stringify({
      timestamp: "2026-04-21T10:00:02.010Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "重复的助手回答" }]
      }
    })
  ].join("\n");

  const detail = parseSessionContent(content, "/tmp/duplicate-messages.jsonl");

  assert.deepEqual(
    detail.conversation_messages.map((message) => [message.role, message.text]),
    [
      ["user", "重复的用户问题"],
      ["assistant", "重复的助手回答"]
    ]
  );
  assert.equal(detail.summary.message_count, 2);
  assert.deepEqual(detail.summary.role_counts, { user: 1, assistant: 1 });
});

test("用户确实连续发送相同内容时仍保留两条消息", () => {
  const content = [
    JSON.stringify({
      timestamp: "2026-04-21T10:00:01.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "再试一次" }]
      }
    }),
    JSON.stringify({
      timestamp: "2026-04-21T10:00:01.010Z",
      type: "event_msg",
      payload: { type: "user_message", message: "再试一次" }
    }),
    JSON.stringify({
      timestamp: "2026-04-21T10:01:01.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "再试一次" }]
      }
    }),
    JSON.stringify({
      timestamp: "2026-04-21T10:01:01.010Z",
      type: "event_msg",
      payload: { type: "user_message", message: "再试一次" }
    })
  ].join("\n");

  const detail = parseSessionContent(content, "/tmp/repeated-user-message.jsonl");

  assert.equal(detail.conversation_messages.length, 2);
  assert.equal(detail.summary.message_count, 2);
});

test("Codex 启动摘要逐行解析并限制保留的搜索正文", async (t) => {
  const rootDir = await createTempSessionDir();
  t.after(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  const filePath = path.join(rootDir, "large-session.jsonl");
  const content = [
    JSON.stringify({
      timestamp: "2026-04-21T10:00:00.000Z",
      type: "session_meta",
      payload: {
        id: "large-session",
        timestamp: "2026-04-21T10:00:00.000Z",
        cwd: "/tmp/large",
        source: "cli",
        model_provider: "custom"
      }
    }),
    JSON.stringify({
      timestamp: "2026-04-21T10:00:01.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "大型会话问题" }
    }),
    JSON.stringify({
      timestamp: "2026-04-21T10:00:02.000Z",
      type: "event_msg",
      payload: { type: "tool_result", call_id: "large-tool", output: "x".repeat(300_000) }
    }),
    JSON.stringify({
      timestamp: "2026-04-21T10:00:03.000Z",
      type: "event_msg",
      payload: { type: "agent_message", message: "大型会话回答" }
    })
  ].join("\n");
  await fs.writeFile(filePath, content, "utf8");

  const detail = await parseCodexFileSummary(filePath, { maxConversationTextChars: 1024 });

  assert.equal(detail.summary.event_count, 4);
  assert.equal(detail.summary.message_count, 3);
  assert.deepEqual(detail.summary.role_counts, { user: 1, tool: 1, assistant: 1 });
  assert.equal(detail.summary.tool_count, 1);
  assert.equal(detail.summary.title, "大型会话问题");
  assert.equal(detail.summary.preview_text, "大型会话回答");
  assert.equal(detail.raw_events.length, 0);
  assert.ok(detail.conversation_messages.reduce((sum, message) => sum + message.text.length, 0) <= 1024);
});

test("Codex 大会话详情使用首尾窗口并截断超长正文", async (t) => {
  const rootDir = await createTempSessionDir();
  t.after(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  const filePath = path.join(rootDir, "bounded-detail.jsonl");
  const records = [
    {
      timestamp: "2026-04-21T10:00:00.000Z",
      type: "session_meta",
      payload: { id: "bounded-detail", cwd: "/tmp/bounded", model_provider: "custom" }
    }
  ];
  for (let index = 0; index < 12; index += 1) {
    records.push({
      timestamp: `2026-04-21T10:00:${String(index + 1).padStart(2, "0")}.000Z`,
      type: "event_msg",
      payload: { type: "user_message", message: `消息-${index}-${"x".repeat(80)}` }
    });
  }
  await fs.writeFile(filePath, records.map((record) => JSON.stringify(record)).join("\n"), "utf8");

  const detail = await parseCodexFile(filePath, {
    maxConversationMessages: 4,
    maxRawEvents: 6,
    maxMessageTextChars: 20,
    maxRawEventLineChars: 100
  });

  assert.equal(detail.summary.message_count, 12);
  assert.equal(detail.summary.detail_truncated, true);
  assert.equal(detail.truncation.messages.omitted, 8);
  assert.equal(detail.truncation.raw_events.omitted, 7);
  assert.equal(detail.conversation_messages.length, 5);
  assert.equal(detail.conversation_messages[2].is_truncation_marker, true);
  assert.ok(
    detail.conversation_messages
      .filter((message) => !message.is_truncation_marker)
      .every((message) => message.text.length <= 20)
  );
  assert.equal(detail.raw_events.length, 7);
  assert.equal(detail.raw_events[3].type, "viewer_truncation");
  assert.equal(detail.raw_events.at(-1).payload.truncated, true);
});

test("会话标题跳过应用注入的上下文消息", () => {
  const content = [
    JSON.stringify({
      timestamp: "2026-04-21T10:00:00.000Z",
      type: "session_meta",
      payload: { id: "context-title", cwd: "/tmp/context", model_provider: "custom" }
    }),
    JSON.stringify({
      timestamp: "2026-04-21T10:00:01.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "<recommended_plugins>injected context</recommended_plugins>" }
    }),
    JSON.stringify({
      timestamp: "2026-04-21T10:00:02.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "真正需要解决的会话问题" }
    })
  ].join("\n");

  const detail = parseSessionContent(content, "/tmp/context-title.jsonl");

  assert.equal(detail.summary.title, "真正需要解决的会话问题");
  assert.equal(detail.summary.message_count, 1);
  assert.equal(detail.summary.context_count, 1);
  assert.equal(detail.conversation_messages[0].synthetic_context, true);
});

test("Codex developer 指令标记为系统上下文", () => {
  const content = [
    JSON.stringify({
      timestamp: "2026-04-21T10:00:00.000Z",
      type: "session_meta",
      payload: { id: "developer-context", cwd: "/tmp/context", model_provider: "custom" }
    }),
    JSON.stringify({
      timestamp: "2026-04-21T10:00:01.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "You are the primary agent." }]
      }
    }),
    JSON.stringify({
      timestamp: "2026-04-21T10:00:02.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "真正的用户问题" }
    })
  ].join("\n");

  const detail = parseSessionContent(content, "/tmp/developer-context.jsonl");

  assert.equal(detail.conversation_messages[0].synthetic_context, true);
  assert.equal(detail.summary.context_count, 1);
  assert.equal(detail.summary.message_count, 1);
  assert.equal(detail.summary.title, "真正的用户问题");
});

test("会话标题跳过应用附加的文件上下文", () => {
  const content = [
    JSON.stringify({
      timestamp: "2026-04-21T10:00:00.000Z",
      type: "session_meta",
      payload: { id: "file-context-title", cwd: "/tmp/file-context", model_provider: "custom" }
    }),
    JSON.stringify({
      timestamp: "2026-04-21T10:00:01.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "# Files mentioned by the user:\n\n## error.log\n\nSQLite failure" }
    }),
    JSON.stringify({
      timestamp: "2026-04-21T10:00:02.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "请分析这个数据库错误" }
    })
  ].join("\n");

  const detail = parseSessionContent(content, "/tmp/file-context-title.jsonl");

  assert.equal(detail.summary.title, "请分析这个数据库错误");
  assert.equal(detail.summary.message_count, 1);
  assert.equal(detail.summary.context_count, 1);
});

test("Markdown 标题标记不会进入会话标题", () => {
  const content = [
    JSON.stringify({
      timestamp: "2026-04-21T10:00:00.000Z",
      type: "session_meta",
      payload: { id: "markdown-title", cwd: "/tmp/markdown", model_provider: "custom" }
    }),
    JSON.stringify({
      timestamp: "2026-04-21T10:00:01.000Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        message: "## Code review guidelines:\n# Review Guidelines\n\nYou are acting as a reviewer."
      }
    })
  ].join("\n");

  const detail = parseSessionContent(content, "/tmp/markdown-title.jsonl");

  assert.equal(detail.summary.title, "Code review guidelines:");
});

test("只有应用注入上下文时会话标题回退到项目名", () => {
  const content = [
    JSON.stringify({
      timestamp: "2026-04-21T10:00:00.000Z",
      type: "session_meta",
      payload: { id: "only-context", cwd: "/tmp/project-name", model_provider: "custom" }
    }),
    JSON.stringify({
      timestamp: "2026-04-21T10:00:01.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "<recommended_plugins>injected context</recommended_plugins>" }
    })
  ].join("\n");

  const detail = parseSessionContent(content, "/tmp/only-context.jsonl");

  assert.equal(detail.summary.title, "project-name");
  assert.equal(detail.summary.message_count, 0);
  assert.equal(detail.summary.context_count, 1);
});

test("Codex 归档会话会保留 Codex 字段并打归档标记", async (t) => {
  const rootDir = await createTempSessionDir();
  t.after(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  const filePath = path.join(rootDir, "rollout-archived.jsonl");
  await fs.writeFile(
    filePath,
    JSON.stringify({
      timestamp: "2026-04-21T10:00:00.000Z",
      type: "session_meta",
      payload: {
        id: "archived-1",
        timestamp: "2026-04-21T10:00:00.000Z",
        cwd: "/tmp/archived",
        source: "cli",
        model_provider: "current_provider"
      }
    }),
    "utf8"
  );

  const detail = await parseCodexArchivedFile(filePath);

  assert.equal(detail.summary.id, "archived-1");
  assert.equal(detail.summary.model_provider, "current_provider");
  assert.equal(detail.summary.source, "cli");
  assert.equal(detail.summary.source_kind, "codex_archived");
  assert.equal(detail.summary.archived, true);
  assert.equal(detail.summary.archive_source, "codex");
  assert.equal(detail.summary.display_source, "Codex Archived");
});

test("Codex subagent source 对象会标记为隐藏会话", () => {
  const content = [
    JSON.stringify({
      timestamp: "2026-04-21T10:00:00.000Z",
      type: "session_meta",
      payload: {
        id: "subagent-1",
        timestamp: "2026-04-21T10:00:00.000Z",
        cwd: "/tmp/subagent",
        source: {
          subagent: {
            thread_spawn: "parent-thread"
          }
        },
        model_provider: "custom"
      }
    }),
    JSON.stringify({
      timestamp: "2026-04-21T10:00:01.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "隐藏会话问题" }
    })
  ].join("\n");

  const detail = parseSessionContent(content, "/tmp/subagent.jsonl");

  assert.equal(detail.summary.id, "subagent-1");
  assert.equal(detail.summary.source, "subagent");
  assert.deepEqual(detail.summary.source_detail, {
    subagent: {
      thread_spawn: "parent-thread"
    }
  });
  assert.equal(detail.summary.hidden, true);
  assert.equal(detail.summary.hidden_reason, "subagent");
  assert.equal(detail.summary.title, "隐藏会话问题");
});

test("Claude Code 摘要会从用户历史派生标题和统计", async (t) => {
  const rootDir = await createTempSessionDir();
  const sessionsDir = path.join(rootDir, "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  t.after(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  const filePath = path.join(sessionsDir, "claude-1.json");
  await fs.writeFile(
    filePath,
    JSON.stringify({
      sessionId: "claude-1",
      cwd: "/tmp/claude-project",
      startedAt: 1713670800000,
      entrypoint: "claude",
      kind: "default"
    }),
    "utf8"
  );
  await fs.writeFile(
    path.join(rootDir, "history.jsonl"),
    JSON.stringify({
      sessionId: "claude-1",
      timestamp: 1713670801000,
      display: "检查 Claude Code 历史"
    }),
    "utf8"
  );

  const detail = await parseClaudeCodeFile(filePath);

  assert.equal(detail.summary.title, "检查 Claude Code 历史");
  assert.equal(detail.summary.message_count, 1);
  assert.deepEqual(detail.summary.role_counts, { user: 1 });
  assert.equal(detail.summary.tool_count, 0);
});

test("Claude Code 项目转录解析完整对话、思考和工具调用", async (t) => {
  const rootDir = await createTempSessionDir();
  t.after(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });
  const filePath = path.join(rootDir, "claude-full.jsonl");
  const records = [
    {
      type: "user",
      uuid: "user-1",
      parentUuid: null,
      sessionId: "claude-full",
      timestamp: "2026-08-11T10:00:00.000Z",
      cwd: "/tmp/claude-full",
      gitBranch: "main",
      version: "1.2.3",
      entrypoint: "cli",
      message: { role: "user", content: "检查完整转录" }
    },
    {
      type: "assistant",
      uuid: "assistant-1",
      parentUuid: "user-1",
      sessionId: "claude-full",
      timestamp: "2026-08-11T10:00:01.000Z",
      message: {
        role: "assistant",
        model: "claude-sonnet-test",
        usage: { input_tokens: 12, output_tokens: 8 },
        content: [
          { type: "thinking", thinking: "内部分析" },
          { type: "text", text: "开始检查" },
          { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "README.md" } }
        ]
      }
    },
    {
      type: "user",
      uuid: "user-2",
      parentUuid: "assistant-1",
      sessionId: "claude-full",
      timestamp: "2026-08-11T10:00:02.000Z",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool-1", content: "读取结果", is_error: true }]
      }
    },
    {
      type: "system",
      subtype: "turn_duration",
      sessionId: "claude-full",
      timestamp: "2026-08-11T10:00:03.000Z",
      durationMs: 100
    }
  ];
  await fs.writeFile(filePath, records.map((record) => JSON.stringify(record)).join("\n"), "utf8");

  const detail = await parseClaudeCodeFile(filePath);

  assert.equal(detail.summary.id, "claude-full");
  assert.equal(detail.summary.title, "检查完整转录");
  assert.equal(detail.summary.model, "claude-sonnet-test");
  assert.equal(detail.summary.git_branch, "main");
  assert.equal(detail.summary.claude_code_version, "1.2.3");
  assert.equal(detail.summary.message_count, 4);
  assert.equal(detail.summary.context_count, 1);
  assert.deepEqual(detail.summary.role_counts, { user: 1, assistant: 1, tool: 2 });
  assert.equal(detail.summary.tool_count, 2);
  assert.equal(detail.raw_events.length, 4);
  assert.equal(detail.conversation_messages.length, 5);

  const thinking = detail.conversation_messages.find((message) => message.source_subtype === "thinking");
  assert.equal(thinking.synthetic_context, true);
  assert.equal(thinking.parent_uuid, "user-1");
  const toolCall = detail.conversation_messages.find((message) => message.tool_kind === "tool_call");
  const toolResult = detail.conversation_messages.find((message) => message.tool_kind === "tool_result");
  assert.equal(toolCall.tool_name, "Read");
  assert.equal(toolCall.tool_call_id, "tool-1");
  assert.equal(toolResult.tool_name, "Read");
  assert.equal(toolResult.is_error, true);
});

test("Claude Code 摘要流式解析并限制索引正文", async (t) => {
  const rootDir = await createTempSessionDir();
  t.after(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });
  const filePath = path.join(rootDir, "summary.jsonl");
  const records = [
    {
      type: "user",
      sessionId: "summary-session",
      timestamp: "2026-08-11T10:00:00.000Z",
      message: { role: "user", content: "摘要标题" }
    },
    {
      type: "assistant",
      sessionId: "summary-session",
      timestamp: "2026-08-11T10:00:01.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "很长的回答内容" }] }
    }
  ];
  await fs.writeFile(filePath, records.map((record) => JSON.stringify(record)).join("\n"), "utf8");

  const detail = await parseClaudeCodeFileSummary(filePath, { maxConversationTextChars: 6 });

  assert.equal(detail.summary.message_count, 2);
  assert.equal(detail.raw_events.length, 0);
  assert.equal(detail.conversation_messages.map((message) => message.text).join("").length, 6);
});

test("Claude Code 子代理转录默认标记为隐藏会话", async (t) => {
  const rootDir = await createTempSessionDir();
  t.after(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });
  const filePath = path.join(rootDir, "sidechain.jsonl");
  await fs.writeFile(filePath, JSON.stringify({
    type: "assistant",
    sessionId: "sidechain-session",
    isSidechain: true,
    uuid: "sidechain-1",
    timestamp: "2026-08-11T10:00:00.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "子代理结果" }] }
  }), "utf8");

  const detail = await parseClaudeCodeFile(filePath);

  assert.equal(detail.summary.hidden, true);
  assert.equal(detail.summary.hidden_reason, "subagent");
  assert.equal(detail.conversation_messages[0].sidechain, true);
  assert.equal(detail.conversation_messages[0].synthetic_context, true);
});

test("Claude Code 独立子代理文件使用唯一会话键", async (t) => {
  const rootDir = await createTempSessionDir();
  const subagentsDir = path.join(rootDir, "parent-session", "subagents");
  await fs.mkdir(subagentsDir, { recursive: true });
  t.after(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });
  const filePath = path.join(subagentsDir, "agent-worker.jsonl");
  await fs.writeFile(filePath, JSON.stringify({
    type: "assistant",
    sessionId: "parent-session",
    agentId: "worker",
    uuid: "agent-message",
    timestamp: "2026-08-11T10:00:00.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "子代理文件结果" }] }
  }), "utf8");

  const detail = await parseClaudeCodeFile(filePath);

  assert.equal(detail.summary.id, "parent-session:subagent:worker");
  assert.equal(detail.summary.parent_session_id, "parent-session");
  assert.equal(detail.summary.hidden, true);
  assert.equal(detail.conversation_messages[0].sidechain, true);
});

test("Claude Code 大会话详情限制消息、原始事件和单条正文", async (t) => {
  const rootDir = await createTempSessionDir();
  t.after(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });
  const filePath = path.join(rootDir, "large.jsonl");
  const records = Array.from({ length: 8 }, (_, index) => ({
    type: index % 2 === 0 ? "user" : "assistant",
    sessionId: "large-session",
    timestamp: `2026-08-11T10:00:0${index}.000Z`,
    message: {
      role: index % 2 === 0 ? "user" : "assistant",
      content: "x".repeat(80)
    }
  }));
  await fs.writeFile(filePath, records.map((record) => JSON.stringify(record)).join("\n"), "utf8");

  const detail = await parseClaudeCodeFile(filePath, {
    maxConversationMessages: 4,
    maxRawEvents: 4,
    maxMessageTextChars: 20,
    maxRawEventLineChars: 40
  });

  assert.equal(detail.summary.detail_truncated, true);
  assert.equal(detail.truncation.messages.total, 8);
  assert.equal(detail.truncation.messages.omitted, 4);
  assert.equal(detail.truncation.messages.text_truncated, 8);
  assert.equal(detail.truncation.raw_events.total, 8);
  assert.equal(detail.truncation.raw_events.omitted, 4);
});

test("遇到坏行和缺少 session_meta 时仍能回退生成详情", () => {
  const content = [
    "{\"timestamp\":\"2026-04-21T10:10:00.000Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"只剩消息\"}}",
    "{bad json"
  ].join("\n");

  const detail = parseSessionContent(content, "/tmp/rollout-sample-fallback.jsonl");

  assert.equal(detail.summary.id, "fallback");
  assert.equal(detail.summary.model_provider, "unknown");
  assert.equal(detail.summary.event_count, 2);
  assert.equal(detail.raw_events[1].type, "parse_error");
  assert.equal(detail.conversation_messages[0].role, "user");
});

test("空文件返回空结果", () => {
  const detail = parseSessionContent("", "/tmp/empty.jsonl");
  assert.equal(detail.summary.event_count, 0);
  assert.equal(detail.conversation_messages.length, 0);
  assert.equal(detail.raw_events.length, 0);
});

test("纯空行文件返回空结果", () => {
  const detail = parseSessionContent("\n\n  \n\n", "/tmp/blank-lines.jsonl");
  assert.equal(detail.summary.event_count, 0);
});

test("多条 session_meta 只取第一条", () => {
  const content = [
    JSON.stringify({
      timestamp: "2026-04-21T10:00:00.000Z",
      type: "session_meta",
      payload: { id: "first-id", model_provider: "openai" }
    }),
    JSON.stringify({
      timestamp: "2026-04-21T10:01:00.000Z",
      type: "session_meta",
      payload: { id: "second-id", model_provider: "anthropic" }
    })
  ].join("\n");

  const detail = parseSessionContent(content, "/tmp/multi-meta.jsonl");
  assert.equal(detail.summary.id, "first-id");
  assert.equal(detail.summary.model_provider, "openai");
});

test("未知 response_item 类型不产生对话消息", () => {
  const content = JSON.stringify({
    timestamp: "2026-04-21T10:00:00.000Z",
    type: "response_item",
    payload: { type: "reasoning", summary: [] }
  });

  const detail = parseSessionContent(content, "/tmp/non-msg.jsonl");
  assert.equal(detail.conversation_messages.length, 0);
  assert.equal(detail.raw_events.length, 1);
});

test("Unicode 内容正常解析", () => {
  const content = JSON.stringify({
    timestamp: "2026-04-21T10:00:00.000Z",
    type: "event_msg",
    payload: { type: "agent_message", message: "你好世界 🌍 こんにちは" }
  });

  const detail = parseSessionContent(content, "/tmp/unicode.jsonl");
  assert.equal(detail.conversation_messages[0].text, "你好世界 🌍 こんにちは");
});

test("tool_call 和 tool_result 事件类型正常解析", () => {
  const content = [
    JSON.stringify({
      timestamp: "2026-04-21T10:00:01.000Z",
      type: "event_msg",
      payload: { type: "tool_call", call_id: "call-1", tool_name: "read_file", arguments: "/tmp/test.js" }
    }),
    JSON.stringify({
      timestamp: "2026-04-21T10:00:02.000Z",
      type: "event_msg",
      payload: { type: "tool_result", call_id: "call-1", output: "file contents here" }
    })
  ].join("\n");

  const detail = parseSessionContent(content, "/tmp/tools.jsonl");
  assert.equal(detail.conversation_messages.length, 2);
  assert.equal(detail.conversation_messages[0].role, "tool");
  assert.equal(detail.conversation_messages[0].tool_name, "read_file");
  assert.equal(detail.conversation_messages[0].tool_kind, "tool_call");
  assert.equal(detail.conversation_messages[0].tool_call_id, "call-1");
  assert.equal(detail.conversation_messages[1].tool_name, "read_file");
  assert.equal(detail.conversation_messages[1].tool_kind, "tool_result");
  assert.equal(detail.conversation_messages[1].tool_call_id, "call-1");
  assert.equal(detail.summary.tool_count, 2);
  assert.equal(detail.summary.role_counts.tool, 2);
  assert.match(detail.conversation_messages[0].text, /read_file/);
  assert.equal(detail.conversation_messages[1].text, "file contents here");
});

test("response_item function_call 和 function_call_output 会配对工具名称", () => {
  const content = [
    JSON.stringify({
      timestamp: "2026-04-21T10:00:01.000Z",
      type: "response_item",
      payload: { type: "function_call", call_id: "call-2", name: "list_files", arguments: "{\"path\":\"/tmp\"}" }
    }),
    JSON.stringify({
      timestamp: "2026-04-21T10:00:02.000Z",
      type: "response_item",
      payload: { type: "function_call_output", call_id: "call-2", output: "a.js\nb.js" }
    })
  ].join("\n");

  const detail = parseSessionContent(content, "/tmp/function-tools.jsonl");

  assert.equal(detail.conversation_messages.length, 2);
  assert.equal(detail.conversation_messages[0].tool_name, "list_files");
  assert.equal(detail.conversation_messages[0].tool_kind, "tool_call");
  assert.equal(detail.conversation_messages[1].tool_name, "list_files");
  assert.equal(detail.conversation_messages[1].tool_kind, "tool_result");
});

test("error 类型事件正常解析", () => {
  const content = JSON.stringify({
    timestamp: "2026-04-21T10:00:00.000Z",
    type: "event_msg",
    payload: { type: "error", message: "something went wrong" }
  });

  const detail = parseSessionContent(content, "/tmp/error.jsonl");
  assert.equal(detail.conversation_messages[0].role, "system");
  assert.match(detail.conversation_messages[0].text, /something went wrong/);
});

test("Gemini 解析使用传入 rootDir 下的 brain 数据", async (t) => {
  const rootDir = await createTempSessionDir();
  t.after(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  const logsDir = path.join(rootDir, "tmp", "queue-a");
  const brainDir = path.join(rootDir, "antigravity", "brain", "gemini-custom-root");
  await fs.mkdir(logsDir, { recursive: true });
  await fs.mkdir(brainDir, { recursive: true });

  await fs.writeFile(
    path.join(logsDir, "logs.json"),
    JSON.stringify([
      {
        sessionId: "gemini-custom-root",
        messageId: 1,
        timestamp: "2026-04-21T10:00:00.000Z",
        type: "user",
        message: "日志里的 Gemini 提问"
      }
    ]),
    "utf8"
  );
  await fs.writeFile(path.join(brainDir, "prompt"), "自定义 rootDir 的 brain 提示", "utf8");
  await fs.writeFile(path.join(brainDir, "prompt.resolved"), "自定义 rootDir 的 brain 回复", "utf8");

  const sessions = await parseGeminiSessions(rootDir);

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].summary.title, "日志里的 Gemini 提问");
  assert.match(sessions[0].summary.preview_text, /自定义 rootDir 的 brain 回复/);
  assert.equal(sessions[0].summary.message_count, sessions[0].conversation_messages.length);
  assert.equal(sessions[0].conversation_messages.some((m) => m.text === "自定义 rootDir 的 brain 提示"), true);
  assert.equal(sessions[0].conversation_messages.some((m) => m.text === "自定义 rootDir 的 brain 回复"), true);
});
