import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { promisify } from "node:util";

import { createHttpServer } from "../server/http-server.js";
import { SessionStore } from "../server/session-store.js";

const execFileAsync = promisify(execFile);

async function createTempSessionDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "codex-http-test-"));
}

async function runSqlite(dbPath, sql, { json = false } = {}) {
  const args = json ? ["-batch", "-json", dbPath, sql] : ["-batch", dbPath, sql];
  const { stdout } = await execFileAsync("sqlite3", args);
  if (!json) return stdout;
  const trimmed = stdout.trim();
  return trimmed ? JSON.parse(trimmed) : [];
}

async function setupServer(t) {
  const rootDir = await createTempSessionDir();
  const publicDir = path.join(rootDir, "public");
  await fs.mkdir(publicDir);

  const sessionDir = path.join(rootDir, "sessions");
  await fs.mkdir(sessionDir, { recursive: true });

  const sessionContent = [
    JSON.stringify({
      timestamp: "2026-04-21T10:00:00.000Z",
      type: "session_meta",
      payload: {
        id: "test-1",
        timestamp: "2026-04-21T10:00:00.000Z",
        cwd: "/tmp/test",
        source: "cli",
        model_provider: "testapi"
      }
    }),
    JSON.stringify({
      timestamp: "2026-04-21T10:00:01.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "hello" }
    })
  ].join("\n");
  await fs.writeFile(path.join(sessionDir, "session.jsonl"), sessionContent, "utf8");

  await fs.writeFile(path.join(publicDir, "index.html"), "<html>test</html>", "utf8");
  await fs.writeFile(path.join(publicDir, "styles.css"), "body{margin:0}", "utf8");

  const store = new SessionStore({ sources: [{ kind: "codex", rootDir: sessionDir, filePattern: "**/*.jsonl" }] });
  await store.initialize();

  const server = createHttpServer({ store, publicDir, sessionRoots: [sessionDir] });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  t.after(async () => {
    server.close();
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  return { server, address, store };
}

async function setupServerWithCodexArchive(t) {
  const rootDir = await createTempSessionDir();
  const publicDir = path.join(rootDir, "public");
  await fs.mkdir(publicDir);

  const sessionDir = path.join(rootDir, "sessions");
  const archivedDir = path.join(rootDir, "archived_sessions");
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.mkdir(archivedDir, { recursive: true });

  const activeSession = [
    JSON.stringify({
      timestamp: "2026-04-21T10:00:00.000Z",
      type: "session_meta",
      payload: {
        id: "active-http",
        timestamp: "2026-04-21T10:00:00.000Z",
        cwd: "/tmp/http-active",
        source: "cli",
        model_provider: "testapi"
      }
    }),
    JSON.stringify({
      timestamp: "2026-04-21T10:00:01.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "visible hello" }
    })
  ].join("\n");

  const archivedSession = [
    JSON.stringify({
      timestamp: "2026-04-20T10:00:00.000Z",
      type: "session_meta",
      payload: {
        id: "archived-http",
        timestamp: "2026-04-20T10:00:00.000Z",
        cwd: "/tmp/http-archived",
        source: "cli",
        model_provider: "testapi"
      }
    }),
    JSON.stringify({
      timestamp: "2026-04-20T10:00:01.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "archived hello" }
    })
  ].join("\n");

  await fs.writeFile(path.join(sessionDir, "active.jsonl"), activeSession, "utf8");
  await fs.writeFile(path.join(archivedDir, "archived.jsonl"), archivedSession, "utf8");
  await fs.writeFile(path.join(publicDir, "index.html"), "<html>test</html>", "utf8");

  const store = new SessionStore({
    sources: [
      { kind: "codex", rootDir: sessionDir, filePattern: "**/*.jsonl" },
      { kind: "codex_archived", rootDir: archivedDir, filePattern: "**/*.jsonl" }
    ]
  });
  await store.initialize();

  const server = createHttpServer({ store, publicDir, sessionRoots: [sessionDir, archivedDir] });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  t.after(async () => {
    server.close();
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  return { address };
}

async function setupServerWithCodexMigration(t) {
  const rootDir = await createTempSessionDir();
  const publicDir = path.join(rootDir, "public");
  const codexHome = path.join(rootDir, "codex");
  const sessionDir = path.join(codexHome, "sessions");
  const archivedDir = path.join(codexHome, "archived_sessions");
  const backupRoot = path.join(rootDir, "backups");
  await fs.mkdir(publicDir);
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.mkdir(archivedDir, { recursive: true });

  const dbPath = path.join(codexHome, "state_5.sqlite");
  await runSqlite(dbPath, `
    create table threads (
      id text primary key,
      model_provider text not null,
      archived integer not null default 0
    );
    insert into threads (id, model_provider, archived) values ('active-third', 'newapi', 0);
    insert into threads (id, model_provider, archived) values ('archived-third', 'right_code', 1);
    insert into threads (id, model_provider, archived) values ('official', 'openai', 0);
    insert into threads (id, model_provider, archived) values ('existing-custom', 'custom', 0);
  `);

  const activeFile = path.join(sessionDir, "active.jsonl");
  const archivedFile = path.join(archivedDir, "archived.jsonl");
  await fs.writeFile(
    activeFile,
    JSON.stringify({
      timestamp: "2026-06-01T10:00:00.000Z",
      type: "session_meta",
      payload: { id: "active-third", model_provider: "newapi", cwd: "/tmp/http-migration" }
    }),
    "utf8"
  );
  await fs.writeFile(
    archivedFile,
    JSON.stringify({
      timestamp: "2026-06-01T09:00:00.000Z",
      type: "session_meta",
      payload: { id: "archived-third", model_provider: "right_code", cwd: "/tmp/http-archived" }
    }),
    "utf8"
  );
  await fs.writeFile(path.join(publicDir, "index.html"), "<html>test</html>", "utf8");

  const store = new SessionStore({
    sources: [{ kind: "codex", rootDir: sessionDir, filePattern: "**/*.jsonl" }]
  });
  await store.initialize();

  const server = createHttpServer({
    store,
    publicDir,
    sessionRoots: [sessionDir],
    codexMigrationOptions: { codexHome, backupRoot }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  t.after(async () => {
    server.close();
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  return { address, dbPath, activeFile };
}

function fetchFromServer(port, path) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode, headers: res.headers, body });
      });
    }).on("error", reject);
  });
}

function postJsonToServer(port, path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload)
      }
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const responseBody = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode, headers: res.headers, body: responseBody });
      });
    });
    req.on("error", reject);
    req.end(payload);
  });
}

async function providerCounts(dbPath) {
  const rows = await runSqlite(
    dbPath,
    "select model_provider as provider, count(*) as count from threads group by model_provider order by provider;",
    { json: true }
  );
  return Object.fromEntries(rows.map((row) => [row.provider, row.count]));
}

async function readSessionMetaProvider(filePath) {
  const line = (await fs.readFile(filePath, "utf8")).split(/\r?\n/).find((item) => item.trim());
  return JSON.parse(line).payload.model_provider;
}

test("GET /api/sessions 返回会话列表", async (t) => {
  const { address } = await setupServer(t);
  const res = await fetchFromServer(address.port, "/api/sessions");
  assert.equal(res.status, 200);

  const data = JSON.parse(res.body);
  assert.ok(Array.isArray(data.sessions));
  assert.equal(data.sessions.length, 1);
  assert.equal(data.sessions[0].id, "test-1");
  assert.equal(typeof data.has_more, "boolean");
});

test("GET /api/facets 返回过滤选项", async (t) => {
  const { address } = await setupServer(t);
  const res = await fetchFromServer(address.port, "/api/facets");
  assert.equal(res.status, 200);

  const data = JSON.parse(res.body);
  assert.deepEqual(data.providers, ["testapi"]);
  assert.ok(Array.isArray(data.dates));
  assert.ok(Array.isArray(data.cwds));
});

test("GET /api/sessions/:id 返回会话详情", async (t) => {
  const { address } = await setupServer(t);
  const res = await fetchFromServer(address.port, "/api/sessions/test-1");
  assert.equal(res.status, 200);

  const data = JSON.parse(res.body);
  assert.equal(data.summary.id, "test-1");
  assert.ok(Array.isArray(data.conversation_messages));
  assert.ok(Array.isArray(data.raw_events));
});

test("GET /api/sessions/:id 不存在返回 404", async (t) => {
  const { address } = await setupServer(t);
  const res = await fetchFromServer(address.port, "/api/sessions/nonexistent");
  assert.equal(res.status, 404);
});

test("GET /api/sessions/:id 无效 ID 返回 400", async (t) => {
  const { address } = await setupServer(t);
  const res = await fetchFromServer(address.port, "/api/sessions/bad!id%00");
  assert.equal(res.status, 400);
});

test("GET /api/sessions/:id 非法百分号编码返回 400", async (t) => {
  const { address } = await setupServer(t);
  const res = await fetchFromServer(address.port, "/api/sessions/%E0%A4%A");
  assert.equal(res.status, 400);
});

test("GET /styles.css 返回 CSS 文件", async (t) => {
  const { address } = await setupServer(t);
  const res = await fetchFromServer(address.port, "/styles.css");
  assert.equal(res.status, 200);
  assert.match(res.headers["content-type"], /text\/css/);
});

test("路径穿越返回 403", async (t) => {
  const { address } = await setupServer(t);
  const res = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port: address.port,
      path: "/%2e%2e/%2e%2e/etc/passwd",
      method: "GET"
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode }));
    });
    req.on("error", reject);
    req.end();
  });
  assert.ok(res.status === 403 || res.status === 404);
});

test("GET /api/refresh 刷新后返回 ok", async (t) => {
  const { address } = await setupServer(t);
  const res = await fetchFromServer(address.port, "/api/refresh");
  assert.equal(res.status, 200);

  const data = JSON.parse(res.body);
  assert.equal(data.ok, true);
  assert.equal(data.count, 1);
});

test("GET /api/sessions 支持过滤", async (t) => {
  const { address } = await setupServer(t);
  const res = await fetchFromServer(address.port, "/api/sessions?provider=testapi");
  const data = JSON.parse(res.body);
  assert.equal(data.sessions.length, 1);

  const res2 = await fetchFromServer(address.port, "/api/sessions?provider=nonexistent");
  const data2 = JSON.parse(res2.body);
  assert.equal(data2.sessions.length, 0);
});

test("GET /api/facets 返回 source_kinds", async (t) => {
  const { address } = await setupServer(t);
  const res = await fetchFromServer(address.port, "/api/facets");
  const data = JSON.parse(res.body);
  assert.ok(Array.isArray(data.source_kinds));
  assert.deepEqual(data.source_kinds, ["codex"]);
});

test("GET /api/sessions 支持 source_kind 过滤", async (t) => {
  const { address } = await setupServer(t);
  const res = await fetchFromServer(address.port, "/api/sessions?source_kind=codex");
  const data = JSON.parse(res.body);
  assert.equal(data.sessions.length, 1);

  const res2 = await fetchFromServer(address.port, "/api/sessions?source_kind=claude_code");
  const data2 = JSON.parse(res2.body);
  assert.equal(data2.sessions.length, 0);
});

test("GET /api/search 返回来源并支持筛选", async (t) => {
  const { address } = await setupServer(t);
  const res = await fetchFromServer(address.port, "/api/search?q=hello&provider=testapi");
  assert.equal(res.status, 200);

  const data = JSON.parse(res.body);
  assert.equal(data.query, "hello");
  assert.equal(data.sessions.length, 1);
  assert.ok(Array.isArray(data.session_roots));

  const filteredOut = await fetchFromServer(address.port, "/api/search?q=hello&provider=nonexistent");
  assert.equal(filteredOut.status, 200);
  assert.equal(JSON.parse(filteredOut.body).sessions.length, 0);
});

test("Codex 归档会话默认隐藏，show_codex_archived 后通过 HTTP 可见", async (t) => {
  const { address } = await setupServerWithCodexArchive(t);

  const defaultList = await fetchFromServer(address.port, "/api/sessions");
  assert.equal(defaultList.status, 200);
  assert.deepEqual(JSON.parse(defaultList.body).sessions.map((session) => session.id), ["active-http"]);

  const archiveList = await fetchFromServer(address.port, "/api/sessions?show_codex_archived=true");
  assert.equal(archiveList.status, 200);
  const archiveData = JSON.parse(archiveList.body);
  assert.equal(archiveData.sessions.length, 2);
  assert.equal(archiveData.sessions.some((session) => session._key === "codex_archived:archived-http"), true);

  const defaultSearch = await fetchFromServer(address.port, "/api/search?q=archived");
  assert.equal(defaultSearch.status, 200);
  assert.equal(JSON.parse(defaultSearch.body).sessions.length, 0);

  const archiveSearch = await fetchFromServer(address.port, "/api/search?q=archived&show_codex_archived=true");
  assert.equal(archiveSearch.status, 200);
  assert.equal(JSON.parse(archiveSearch.body).sessions.length, 1);

  const defaultStats = await fetchFromServer(address.port, "/api/stats");
  assert.equal(JSON.parse(defaultStats.body).total, 1);

  const archiveStats = await fetchFromServer(address.port, "/api/stats?show_codex_archived=true");
  assert.equal(JSON.parse(archiveStats.body).total, 2);
});

test("Codex provider 迁移 HTTP 接口支持预览、确认执行和回滚", async (t) => {
  const { address, dbPath, activeFile } = await setupServerWithCodexMigration(t);

  const preview = await fetchFromServer(address.port, "/api/codex-provider-migration/preview");
  assert.equal(preview.status, 200);
  const previewData = JSON.parse(preview.body);
  assert.deepEqual(previewData.providers, ["newapi", "right_code"]);
  assert.equal(previewData.threadMatches, 2);
  assert.equal(await readSessionMetaProvider(activeFile), "newapi");

  const blocked = await postJsonToServer(address.port, "/api/codex-provider-migration/apply", {});
  assert.equal(blocked.status, 400);

  const applied = await postJsonToServer(address.port, "/api/codex-provider-migration/apply", {
    confirmedCodexAppClosed: true
  });
  assert.equal(applied.status, 200);
  const appliedData = JSON.parse(applied.body);
  assert.ok(appliedData.backupDir);
  assert.equal((await providerCounts(dbPath)).custom, 3);
  assert.equal(await readSessionMetaProvider(activeFile), "custom");

  const rollback = await postJsonToServer(address.port, "/api/codex-provider-migration/rollback", {
    confirmedCodexAppClosed: true,
    backupDir: appliedData.backupDir
  });
  assert.equal(rollback.status, 200);
  assert.equal((await providerCounts(dbPath)).newapi, 1);
  assert.equal(await readSessionMetaProvider(activeFile), "newapi");
});

test("GET /api/sessions/:_key 用组合 key 返回详情", async (t) => {
  const { address } = await setupServer(t);
  const res = await fetchFromServer(address.port, "/api/sessions/codex%3Atest-1");
  assert.equal(res.status, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.summary.id, "test-1");
  assert.equal(data.summary._key, "codex:test-1");
});

test("ETag 缓存：第二次请求返回 304", async (t) => {
  const { address } = await setupServer(t);

  const res1 = await fetchFromServer(address.port, "/styles.css");
  assert.equal(res1.status, 200);
  const etag = res1.headers["etag"];
  assert.ok(etag);

  const res2 = await new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${address.port}/styles.css`, { headers: { "If-None-Match": etag } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.on("error", reject);
  });
  assert.equal(res2.status, 304);
});
