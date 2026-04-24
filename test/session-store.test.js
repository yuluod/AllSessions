import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { SessionStore } from "../server/session-store.js";

async function createTempSessionDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "codex-session-viewer-"));
}

test("SessionStore 能扫描目录并支持筛选和 facets", async (t) => {
  const rootDir = await createTempSessionDir();
  t.after(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  const firstDir = path.join(rootDir, "2026", "04", "21");
  const secondDir = path.join(rootDir, "2026", "04", "20");
  await fs.mkdir(firstDir, { recursive: true });
  await fs.mkdir(secondDir, { recursive: true });

  const sessionOne = [
    JSON.stringify({
      timestamp: "2026-04-21T09:00:00.000Z",
      type: "session_meta",
      payload: {
        id: "s-1",
        timestamp: "2026-04-21T09:00:00.000Z",
        cwd: "/tmp/a",
        source: "cli",
        originator: "desktop",
        model_provider: "newapi"
      }
    })
  ].join("\n");

  const sessionTwo = [
    JSON.stringify({
      timestamp: "2026-04-20T08:00:00.000Z",
      type: "session_meta",
      payload: {
        id: "s-2",
        timestamp: "2026-04-20T08:00:00.000Z",
        cwd: "/tmp/b",
        source: "cli",
        originator: "desktop",
        model_provider: "right_code"
      }
    })
  ].join("\n");

  await fs.writeFile(path.join(firstDir, "one.jsonl"), sessionOne, "utf8");
  await fs.writeFile(path.join(secondDir, "two.jsonl"), sessionTwo, "utf8");

  const store = new SessionStore({ sources: [{ kind: "codex", rootDir, filePattern: "**/*.jsonl" }] });
  await store.initialize();

  const allResult = store.listSessions();
  assert.equal(allResult.sessions.length, 2);
  assert.equal(allResult.sessions[0].id, "s-1");

  const filtered = store.listSessions({ provider: "right_code", date: "2026-04-20", cwd: "/tmp/b" });
  assert.equal(filtered.sessions.length, 1);
  assert.equal(filtered.sessions[0].id, "s-2");

  const facets = store.getFacets();
  assert.deepEqual(facets.providers, ["newapi", "right_code"]);
  assert.deepEqual(facets.dates, ["2026-04-21", "2026-04-20"]);
  assert.deepEqual(facets.cwds, ["/tmp/a", "/tmp/b"]);

  const detail = await store.getSessionDetail("s-1");
  assert.equal(detail.summary.id, "s-1");
});

test("_watchDir 创建失败时不会污染 watchedDirs", async (t) => {
  const rootDir = await createTempSessionDir();
  t.after(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  const store = new SessionStore({ sources: [{ kind: "codex", rootDir, filePattern: "**/*.jsonl" }] });
  const missingDir = path.join(rootDir, "missing");

  store._watchDir(missingDir, { kind: "codex", rootDir, filePattern: "**/*.jsonl" });

  assert.equal(store._watchedDirs.has(missingDir), false);
});

test("stopWatching 会清空 watchedDirs", async (t) => {
  const rootDir = await createTempSessionDir();
  t.after(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  const nestedDir = path.join(rootDir, "2026", "04", "21");
  await fs.mkdir(nestedDir, { recursive: true });

  const store = new SessionStore({ sources: [{ kind: "codex", rootDir, filePattern: "**/*.jsonl" }] });
  await store.watch();

  assert.ok(store._watchedDirs.has(rootDir));
  assert.ok(store._watchedDirs.has(nestedDir));

  store.stopWatching();

  assert.equal(store._watchedDirs.size, 0);
});

test("多来源同 raw id 不串", async (t) => {
  const rootDir = await createTempSessionDir();
  const codexDir = path.join(rootDir, "codex");
  const claudeDir = path.join(rootDir, "claude", "sessions");
  await fs.mkdir(codexDir, { recursive: true });
  await fs.mkdir(claudeDir, { recursive: true });

  t.after(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  const codexSession = [
    JSON.stringify({
      timestamp: "2026-04-21T10:00:00.000Z",
      type: "session_meta",
      payload: {
        id: "shared-id",
        timestamp: "2026-04-21T10:00:00.000Z",
        cwd: "/tmp/codex",
        source: "cli",
        model_provider: "openai"
      }
    })
  ].join("\n");

  await fs.writeFile(path.join(codexDir, "session.jsonl"), codexSession, "utf8");

  const claudeSession = JSON.stringify({
    sessionId: "shared-id",
    cwd: "/tmp/claude",
    startedAt: 1713670800000,
    entrypoint: "claude",
    kind: "default"
  });

  await fs.writeFile(path.join(claudeDir, "shared-id.json"), claudeSession, "utf8");

  const store = new SessionStore({
    sources: [
      { kind: "codex", rootDir: codexDir, filePattern: "**/*.jsonl" },
      { kind: "claude_code", rootDir: claudeDir, filePattern: "sessions/*.json" }
    ]
  });
  await store.initialize();

  assert.equal(store.listSessions().sessions.length, 2);

  const codexKey = "codex:shared-id";
  const claudeKey = "claude_code:shared-id";

  const codexDetail = await store.getSessionDetail(codexKey);
  assert.equal(codexDetail.summary.source_kind, "codex");
  assert.equal(codexDetail.summary.cwd, "/tmp/codex");

  const claudeDetail = await store.getSessionDetail(claudeKey);
  assert.equal(claudeDetail.summary.source_kind, "claude_code");
  assert.equal(claudeDetail.summary.cwd, "/tmp/claude");

  const filtered = store.listSessions({ source_kind: "claude_code" });
  assert.equal(filtered.sessions.length, 1);
  assert.equal(filtered.sessions[0]._key, claudeKey);

  const facets = store.getFacets();
  assert.deepEqual(facets.source_kinds, ["claude_code", "codex"]);
});

test("Gemini logs 变更会重建 Gemini 来源索引", async (t) => {
  const rootDir = await createTempSessionDir();
  const queueDir = path.join(rootDir, "tmp", "queue-a");
  await fs.mkdir(queueDir, { recursive: true });

  t.after(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  const logsPath = path.join(queueDir, "logs.json");
  await fs.writeFile(
    logsPath,
    JSON.stringify([
      {
        sessionId: "gemini-session",
        messageId: 1,
        timestamp: "2026-04-21T10:00:00.000Z",
        type: "user",
        message: "第一次提问"
      }
    ]),
    "utf8"
  );

  const source = { kind: "gemini", rootDir, filePattern: "tmp/*/logs.json" };
  const store = new SessionStore({ sources: [source] });
  await store.initialize();

  assert.equal(store.listSessions().sessions.length, 1);
  assert.equal(store.search("第一次").length, 1);

  const events = [];
  store.onChange((event) => events.push(event));

  await fs.writeFile(
    logsPath,
    JSON.stringify([
      {
        sessionId: "gemini-session",
        messageId: 1,
        timestamp: "2026-04-21T10:00:00.000Z",
        type: "user",
        message: "第二次提问"
      }
    ]),
    "utf8"
  );

  store._pendingChanges.add(logsPath);
  await store._processPendingChanges();

  assert.equal(store.listSessions().sessions.length, 1);
  assert.equal(store.search("第一次").length, 0);
  assert.equal(store.search("第二次").length, 1);
  assert.equal(events.some((event) => event.type === "session-updated"), true);
});
