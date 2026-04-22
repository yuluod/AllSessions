import test from "node:test";
import assert from "node:assert/strict";

import { parseSessionContent } from "../server/session-parser.js";

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
        model_provider: "newapi"
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
  assert.equal(detail.summary.model_provider, "newapi");
  assert.equal(detail.summary.cwd, "/tmp/project-a");
  assert.equal(detail.summary.event_count, 3);
  assert.equal(detail.conversation_messages.length, 2);
  assert.equal(detail.conversation_messages[0].role, "user");
  assert.match(detail.conversation_messages[1].text, /查看会话/);
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

test("非 message 类型的 response_item 不产生对话消息", () => {
  const content = JSON.stringify({
    timestamp: "2026-04-21T10:00:00.000Z",
    type: "response_item",
    payload: { type: "function_call", name: "read_file" }
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
      payload: { type: "tool_call", tool_name: "read_file", arguments: "/tmp/test.js" }
    }),
    JSON.stringify({
      timestamp: "2026-04-21T10:00:02.000Z",
      type: "event_msg",
      payload: { type: "tool_result", output: "file contents here" }
    })
  ].join("\n");

  const detail = parseSessionContent(content, "/tmp/tools.jsonl");
  assert.equal(detail.conversation_messages.length, 2);
  assert.equal(detail.conversation_messages[0].role, "tool");
  assert.match(detail.conversation_messages[0].text, /read_file/);
  assert.equal(detail.conversation_messages[1].text, "file contents here");
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
