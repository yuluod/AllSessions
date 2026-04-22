import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { createHttpServer } from "../server/http-server.js";
import { SessionStore } from "../server/session-store.js";

async function createTempSessionDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "codex-http-test-"));
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
