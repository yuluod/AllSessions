import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { parseFileSummary } from "../server/parsers/index.js";
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
        model_provider: "current_provider"
      }
    }),
    JSON.stringify({
      timestamp: "2026-04-21T09:00:01.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "项目 A 的问题" }
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
        model_provider: "legacy_provider_a"
      }
    }),
    JSON.stringify({
      timestamp: "2026-04-20T08:00:01.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "项目 B 的问题" }
    })
  ].join("\n");

  await fs.writeFile(path.join(firstDir, "one.jsonl"), sessionOne, "utf8");
  await fs.writeFile(path.join(secondDir, "two.jsonl"), sessionTwo, "utf8");

  const store = new SessionStore({ sources: [{ kind: "codex", rootDir, filePattern: "**/*.jsonl" }] });
  await store.initialize();

  const allResult = store.listSessions();
  assert.equal(allResult.sessions.length, 2);
  assert.equal(allResult.sessions[0].id, "s-1");

  const filtered = store.listSessions({ provider: "legacy_provider_a", date: "2026-04-20", cwd: "/tmp/b" });
  assert.equal(filtered.sessions.length, 1);
  assert.equal(filtered.sessions[0].id, "s-2");

  const facets = store.getFacets();
  assert.deepEqual(facets.providers, ["current_provider", "legacy_provider_a"]);
  assert.deepEqual(facets.dates, ["2026-04-21", "2026-04-20"]);
  assert.deepEqual(facets.cwds, ["/tmp/a", "/tmp/b"]);
  assert.equal(facets.projects.length, 2);
  assert.deepEqual(facets.projects[0], {
    name: "a",
    path: "/tmp/a",
    count: 1,
    last_timestamp: "2026-04-21T09:00:01.000Z",
    providers: ["current_provider"],
    source_kinds: ["codex"]
  });

  const stats = store.getStats();
  assert.equal(stats.total, 2);
  assert.equal(stats.total_events, 4);

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

test("watch 每个来源根目录只创建一个递归 watcher", async (t) => {
  const rootDir = await createTempSessionDir();
  t.after(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  const nestedDir = path.join(rootDir, "2026", "04", "21");
  await fs.mkdir(nestedDir, { recursive: true });

  const store = new SessionStore({ sources: [{ kind: "codex", rootDir, filePattern: "**/*.jsonl" }] });
  t.after(() => store.stopWatching());
  await store.watch();

  assert.ok(store._watchedDirs.has(rootDir));
  assert.equal(store._watchedDirs.has(nestedDir), false);
  assert.equal(store._watchers.length, 1);

  store.stopWatching();

  assert.equal(store._watchedDirs.size, 0);
});

test("initialize 和 watch 只访问来源声明的精确目录", async (t) => {
  const rootDir = await createTempSessionDir();
  const sessionsDir = path.join(rootDir, "sessions");
  const unrelatedSessionsDir = path.join(rootDir, "plugins", "cache", "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  await fs.mkdir(unrelatedSessionsDir, { recursive: true });

  t.after(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  await fs.writeFile(
    path.join(sessionsDir, "valid.json"),
    JSON.stringify({
      sessionId: "valid-session",
      cwd: "/tmp/valid",
      startedAt: 1713670800000,
      entrypoint: "claude"
    }),
    "utf8"
  );
  await fs.writeFile(
    path.join(unrelatedSessionsDir, "unrelated.json"),
    JSON.stringify({
      sessionId: "unrelated-session",
      cwd: "/tmp/unrelated",
      startedAt: 1713670800000,
      entrypoint: "claude"
    }),
    "utf8"
  );

  const source = {
    kind: "claude_code",
    rootDir,
    filePattern: "sessions/*.json",
    discoveryRoots: [sessionsDir],
    watchRoots: [sessionsDir]
  };
  const store = new SessionStore({ sources: [source] });
  t.after(() => store.stopWatching());
  await store.initialize();
  await store.watch();

  assert.deepEqual(store.listSessions().sessions.map((session) => session.id), ["valid-session"]);
  assert.deepEqual([...store._watchedDirs], [sessionsDir]);

  store.stopWatching();
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

test("搜索结果会继续遵守筛选条件", async (t) => {
  const rootDir = await createTempSessionDir();
  const sessionDir = path.join(rootDir, "sessions");
  await fs.mkdir(sessionDir, { recursive: true });

  t.after(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  const firstSession = [
    JSON.stringify({
      timestamp: "2026-04-21T10:00:00.000Z",
      type: "session_meta",
      payload: {
        id: "search-1",
        timestamp: "2026-04-21T10:00:00.000Z",
        cwd: "/tmp/search-a",
        source: "cli",
        model_provider: "openai"
      }
    }),
    JSON.stringify({
      timestamp: "2026-04-21T10:00:01.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "共享搜索词" }
    })
  ].join("\n");

  const secondSession = [
    JSON.stringify({
      timestamp: "2026-04-21T11:00:00.000Z",
      type: "session_meta",
      payload: {
        id: "search-2",
        timestamp: "2026-04-21T11:00:00.000Z",
        cwd: "/tmp/search-b",
        source: "cli",
        model_provider: "anthropic"
      }
    }),
    JSON.stringify({
      timestamp: "2026-04-21T11:00:01.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "共享搜索词" }
    })
  ].join("\n");

  await fs.writeFile(path.join(sessionDir, "first.jsonl"), firstSession, "utf8");
  await fs.writeFile(path.join(sessionDir, "second.jsonl"), secondSession, "utf8");

  const store = new SessionStore({ sources: [{ kind: "codex", rootDir: sessionDir, filePattern: "**/*.jsonl" }] });
  await store.initialize();

  assert.equal(store.search("共享搜索词").length, 2);

  const filtered = store.search("共享搜索词", { provider: "openai", cwd: "/tmp/search-a" });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].id, "search-1");

  const pathMatch = store.search("search-a");
  assert.equal(pathMatch.length, 1);
  assert.equal(pathMatch[0].id, "search-1");
  assert.match(pathMatch[0].search_snippet, /search-a/);

  const providerMatch = store.search("anthropic");
  assert.equal(providerMatch.length, 1);
  assert.equal(providerMatch[0].id, "search-2");

  const singleChineseToken = store.search("共");
  assert.equal(singleChineseToken.length, 2);
});

test("Codex 归档会话默认隐藏，开启 show_codex_archived 后可见", async (t) => {
  const rootDir = await createTempSessionDir();
  const sessionsDir = path.join(rootDir, "sessions");
  const archivedDir = path.join(rootDir, "archived_sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  await fs.mkdir(archivedDir, { recursive: true });

  t.after(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  const activeSession = [
    JSON.stringify({
      timestamp: "2026-04-21T10:00:00.000Z",
      type: "session_meta",
      payload: {
        id: "active-codex",
        timestamp: "2026-04-21T10:00:00.000Z",
        cwd: "/tmp/active",
        source: "cli",
        model_provider: "openai"
      }
    }),
    JSON.stringify({
      timestamp: "2026-04-21T10:00:01.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "可见搜索词" }
    })
  ].join("\n");

  const archivedSession = [
    JSON.stringify({
      timestamp: "2026-04-20T10:00:00.000Z",
      type: "session_meta",
      payload: {
        id: "archived-codex",
        timestamp: "2026-04-20T10:00:00.000Z",
        cwd: "/tmp/archived",
        source: "cli",
        model_provider: "openai"
      }
    }),
    JSON.stringify({
      timestamp: "2026-04-20T10:00:01.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "归档搜索词" }
    })
  ].join("\n");

  await fs.writeFile(path.join(sessionsDir, "active.jsonl"), activeSession, "utf8");
  await fs.writeFile(path.join(archivedDir, "archived.jsonl"), archivedSession, "utf8");

  const store = new SessionStore({
    sources: [
      { kind: "codex", rootDir: sessionsDir, filePattern: "**/*.jsonl" },
      { kind: "codex_archived", rootDir: archivedDir, filePattern: "**/*.jsonl" }
    ]
  });
  await store.initialize();

  assert.equal(store.listSessions().sessions.length, 1);
  assert.equal(store.search("归档搜索词").length, 0);
  assert.equal(store.getStats().total, 1);

  const visible = store.listSessions({ show_codex_archived: true }).sessions;
  assert.equal(visible.length, 2);
  assert.equal(visible.some((session) => session._key === "codex_archived:archived-codex"), true);
  assert.equal(store.search("归档搜索词", { show_codex_archived: true }).length, 1);
  assert.equal(store.getStats({ show_codex_archived: true }).total, 2);

  const detail = await store.getSessionDetail("codex_archived:archived-codex");
  assert.equal(detail.summary.archived, true);
  assert.equal(detail.summary.archive_source, "codex");
});

test("hidden subagent 会话默认隐藏，开启 show_hidden 后可见", async (t) => {
  const rootDir = await createTempSessionDir();
  await fs.mkdir(rootDir, { recursive: true });

  t.after(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  const visibleSession = [
    JSON.stringify({
      timestamp: "2026-04-21T10:00:00.000Z",
      type: "session_meta",
      payload: {
        id: "visible-codex",
        timestamp: "2026-04-21T10:00:00.000Z",
        cwd: "/tmp/visible",
        source: "cli",
        model_provider: "openai"
      }
    }),
    JSON.stringify({
      timestamp: "2026-04-21T10:00:01.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "普通搜索词" }
    })
  ].join("\n");

  const hiddenSession = [
    JSON.stringify({
      timestamp: "2026-04-20T10:00:00.000Z",
      type: "session_meta",
      payload: {
        id: "hidden-subagent",
        timestamp: "2026-04-20T10:00:00.000Z",
        cwd: "/tmp/hidden",
        source: {
          subagent: {
            thread_spawn: "parent"
          }
        },
        model_provider: "custom"
      }
    }),
    JSON.stringify({
      timestamp: "2026-04-20T10:00:01.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "隐藏搜索词" }
    })
  ].join("\n");

  await fs.writeFile(path.join(rootDir, "visible.jsonl"), visibleSession, "utf8");
  await fs.writeFile(path.join(rootDir, "hidden.jsonl"), hiddenSession, "utf8");

  const store = new SessionStore({ sources: [{ kind: "codex", rootDir, filePattern: "**/*.jsonl" }] });
  await store.initialize();

  assert.equal(store.listSessions().sessions.length, 1);
  assert.equal(store.search("隐藏搜索词").length, 0);
  assert.equal(store.getStats().total, 1);

  const visible = store.listSessions({ show_hidden: true }).sessions;
  assert.equal(visible.length, 2);
  assert.equal(visible.some((session) => session._key === "codex:hidden-subagent"), true);
  assert.equal(store.search("隐藏搜索词", { show_hidden: true }).length, 1);
  assert.equal(store.getStats({ show_hidden: true }).total, 2);

  const facets = store.getFacets();
  assert.deepEqual(facets.hidden_reasons, ["subagent"]);

  const detail = await store.getSessionDetail("codex:hidden-subagent");
  assert.equal(detail.summary.hidden, true);
  assert.equal(detail.summary.hidden_reason, "subagent");
});

test("坏 Claude Code 元数据不会阻断其他会话初始化", async (t) => {
  const rootDir = await createTempSessionDir();
  const sessionsDir = path.join(rootDir, "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });

  t.after(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  await fs.writeFile(path.join(sessionsDir, "broken.json"), "{bad json", "utf8");
  await fs.writeFile(
    path.join(sessionsDir, "valid.json"),
    JSON.stringify({
      sessionId: "valid-claude",
      cwd: "/tmp/claude-valid",
      startedAt: 1713670800000,
      entrypoint: "claude",
      kind: "default"
    }),
    "utf8"
  );

  const store = new SessionStore({
    sources: [{ kind: "claude_code", rootDir, filePattern: "sessions/*.json" }]
  });
  await store.initialize();

  const sessions = store.listSessions().sessions;
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, "valid-claude");
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

test("SessionStore 重启时复用未变化文件的私有索引缓存", async (t) => {
  const rootDir = await createTempSessionDir();
  t.after(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  const filePath = path.join(rootDir, "cached.jsonl");
  const cacheFile = path.join(rootDir, "cache", "session-index.json");
  const source = { kind: "codex", rootDir, filePattern: "**/*.jsonl" };
  const initialContent = [
    JSON.stringify({
      timestamp: "2026-04-21T10:00:00.000Z",
      type: "session_meta",
      payload: { id: "cached", cwd: "/tmp/cache", model_provider: "custom" }
    }),
    JSON.stringify({
      timestamp: "2026-04-21T10:00:01.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "缓存中的搜索文本" }
    })
  ].join("\n");
  await fs.writeFile(filePath, initialContent, "utf8");

  const first = new SessionStore({ sources: [source], indexCacheFile: cacheFile });
  await first.initialize();
  assert.deepEqual(first.cacheStats, { hits: 0, misses: 1 });
  assert.equal(first._indexCache.entries.size, 0);

  const second = new SessionStore({ sources: [source], indexCacheFile: cacheFile });
  await second.initialize();
  assert.deepEqual(second.cacheStats, { hits: 1, misses: 0 });
  assert.equal(second._indexCache.entries.size, 0);
  assert.equal(second.search("缓存中的搜索文本").length, 1);

  await fs.appendFile(
    filePath,
    `\n${JSON.stringify({
      timestamp: "2026-04-21T10:00:02.000Z",
      type: "event_msg",
      payload: { type: "agent_message", message: "文件变化后重新解析" }
    })}`,
    "utf8"
  );
  const third = new SessionStore({ sources: [source], indexCacheFile: cacheFile });
  await third.initialize();
  assert.deepEqual(third.cacheStats, { hits: 0, misses: 1 });
  assert.equal(third.search("文件变化后重新解析").length, 1);

  const cacheMode = (await fs.stat(cacheFile)).mode & 0o777;
  assert.equal(cacheMode, 0o600);
});

test("文件变更处理通过单写者队列串行执行", async (t) => {
  const rootDir = await createTempSessionDir();
  t.after(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });
  const filePath = path.join(rootDir, "serial.jsonl");
  const content = (message) => [
    JSON.stringify({
      timestamp: "2026-04-21T10:00:00.000Z",
      type: "session_meta",
      payload: { id: "serial", cwd: "/tmp/serial", model_provider: "custom" }
    }),
    JSON.stringify({
      timestamp: "2026-04-21T10:00:01.000Z",
      type: "event_msg",
      payload: { type: "user_message", message }
    })
  ].join("\n");
  await fs.writeFile(filePath, content("第一次"), "utf8");

  const store = new SessionStore({
    sources: [{ kind: "codex", rootDir, filePattern: "**/*.jsonl" }]
  });
  await store.initialize();
  let active = 0;
  let maxActive = 0;
  store._parseFileSummary = async (...args) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 15));
    try {
      return await parseFileSummary(...args);
    } finally {
      active -= 1;
    }
  };

  await fs.writeFile(filePath, content("第二次"), "utf8");
  store._pendingChanges.add(filePath);
  const first = store.flushPendingChanges();
  await new Promise((resolve) => setTimeout(resolve, 2));
  await fs.writeFile(filePath, content("第三次"), "utf8");
  store._pendingChanges.add(filePath);
  const second = store.flushPendingChanges();
  await Promise.all([first, second]);

  assert.equal(maxActive, 1);
  assert.equal(store.search("第三次").length, 1);
});

test("Gemini 重载失败时保留上一版可用索引", async (t) => {
  const rootDir = await createTempSessionDir();
  const queueDir = path.join(rootDir, "tmp", "queue-a");
  await fs.mkdir(queueDir, { recursive: true });
  t.after(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(queueDir, "logs.json"), JSON.stringify([{
    sessionId: "gemini-stable",
    messageId: 1,
    timestamp: "2026-04-21T10:00:00.000Z",
    type: "user",
    message: "保留的内容"
  }]), "utf8");

  const source = { kind: "gemini", rootDir, filePattern: "tmp/*/logs.json" };
  const store = new SessionStore({ sources: [source] });
  await store.initialize();
  store._parseGeminiSessions = async () => {
    throw new Error("transient parse failure");
  };

  await assert.rejects(store._reloadGeminiSource(source), /transient parse failure/);
  assert.equal(store.search("保留的内容").length, 1);
  assert.equal(store.listSessions().sessions.length, 1);
});
