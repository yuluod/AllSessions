import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { parseGeminiSessions, parseGeminiSessionById } from "../server/parsers/gemini.js";

async function createTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "gemini-parser-test-"));
}

async function writeLogsJson(dir, entries) {
  const logsDir = path.join(dir, "tmp", "queue-1");
  await fs.mkdir(logsDir, { recursive: true });
  await fs.writeFile(path.join(logsDir, "logs.json"), JSON.stringify(entries), "utf8");
}

test("parseGeminiSessions 解析单 session 用户消息", async (t) => {
  const rootDir = await createTempDir();
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));

  await writeLogsJson(rootDir, [
    {
      sessionId: "sess-1",
      messageId: 1,
      timestamp: "2026-04-21T10:00:00.000Z",
      type: "user",
      message: "你好"
    }
  ]);

  const sessions = await parseGeminiSessions(rootDir);

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].summary.id, "sess-1");
  assert.equal(sessions[0].summary.source_kind, "gemini");
  assert.equal(sessions[0].summary.model_provider, "google");
  assert.equal(sessions[0].conversation_messages[0].role, "user");
  assert.equal(sessions[0].conversation_messages[0].text, "你好");
});

test("parseGeminiSessions 解析助手消息（model 类型）", async (t) => {
  const rootDir = await createTempDir();
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));

  await writeLogsJson(rootDir, [
    {
      sessionId: "sess-2",
      messageId: 1,
      timestamp: "2026-04-21T10:00:00.000Z",
      type: "user",
      message: "提问"
    },
    {
      sessionId: "sess-2",
      messageId: 2,
      timestamp: "2026-04-21T10:00:01.000Z",
      type: "model",
      message: "回答"
    }
  ]);

  const sessions = await parseGeminiSessions(rootDir);

  assert.equal(sessions.length, 1);
  const msgs = sessions[0].conversation_messages;
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, "user");
  assert.equal(msgs[1].role, "assistant");
  assert.equal(msgs[1].text, "回答");
});

test("parseGeminiSessions 多 session 在同一 logs.json 中聚合", async (t) => {
  const rootDir = await createTempDir();
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));

  await writeLogsJson(rootDir, [
    {
      sessionId: "sess-a",
      messageId: 1,
      timestamp: "2026-04-21T10:00:00.000Z",
      type: "user",
      message: "A 的消息"
    },
    {
      sessionId: "sess-b",
      messageId: 1,
      timestamp: "2026-04-21T10:01:00.000Z",
      type: "user",
      message: "B 的消息"
    }
  ]);

  const sessions = await parseGeminiSessions(rootDir);

  assert.equal(sessions.length, 2);
  const ids = new Set(sessions.map((s) => s.summary.id));
  assert.ok(ids.has("sess-a"));
  assert.ok(ids.has("sess-b"));
});

test("parseGeminiSessions 目录不存在返回空数组", async (t) => {
  const rootDir = await createTempDir();
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));

  const sessions = await parseGeminiSessions(rootDir);
  assert.deepEqual(sessions, []);
});

test("parseGeminiSessions 忽略 message 为空的 model 条目", async (t) => {
  const rootDir = await createTempDir();
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));

  await writeLogsJson(rootDir, [
    {
      sessionId: "sess-c",
      messageId: 1,
      timestamp: "2026-04-21T10:00:00.000Z",
      type: "user",
      message: "提问"
    },
    {
      sessionId: "sess-c",
      messageId: 2,
      timestamp: "2026-04-21T10:00:01.000Z",
      type: "model",
      message: "   "
    }
  ]);

  const sessions = await parseGeminiSessions(rootDir);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].conversation_messages.length, 1);
  assert.equal(sessions[0].conversation_messages[0].role, "user");
});

test("parseGeminiSessionById 返回指定 session 详情", async (t) => {
  const rootDir = await createTempDir();
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));

  await writeLogsJson(rootDir, [
    {
      sessionId: "target-session",
      messageId: 1,
      timestamp: "2026-04-21T10:00:00.000Z",
      type: "user",
      message: "目标会话"
    },
    {
      sessionId: "other-session",
      messageId: 1,
      timestamp: "2026-04-21T10:00:00.000Z",
      type: "user",
      message: "其他会话"
    }
  ]);

  const detail = await parseGeminiSessionById(rootDir, "target-session");

  assert.ok(detail !== null);
  assert.equal(detail.summary.id, "target-session");
  assert.equal(detail.conversation_messages[0].text, "目标会话");
});

test("parseGeminiSessionById 找不到返回 null", async (t) => {
  const rootDir = await createTempDir();
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));

  await writeLogsJson(rootDir, [
    {
      sessionId: "real-session",
      messageId: 1,
      timestamp: "2026-04-21T10:00:00.000Z",
      type: "user",
      message: "消息"
    }
  ]);

  const detail = await parseGeminiSessionById(rootDir, "non-existent-session");
  assert.equal(detail, null);
});

test("enrichWithBrain 补充 brain 目录内容", async (t) => {
  const rootDir = await createTempDir();
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));

  const brainDir = path.join(rootDir, "antigravity", "brain", "brain-session");
  await fs.mkdir(brainDir, { recursive: true });

  await writeLogsJson(rootDir, [
    {
      sessionId: "brain-session",
      messageId: 1,
      timestamp: "2026-04-21T10:00:00.000Z",
      type: "user",
      message: "日志消息"
    }
  ]);

  await fs.writeFile(path.join(brainDir, "prompt"), "brain 里的提示词", "utf8");
  await fs.writeFile(path.join(brainDir, "prompt.resolved"), "brain 里的回复", "utf8");

  const sessions = await parseGeminiSessions(rootDir);

  assert.equal(sessions.length, 1);
  const texts = sessions[0].conversation_messages.map((m) => m.text);
  assert.ok(texts.includes("brain 里的提示词"));
  assert.ok(texts.includes("brain 里的回复"));
});
