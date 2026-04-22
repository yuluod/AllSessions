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

  const store = new SessionStore({ sessionRoot: rootDir });
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

  const store = new SessionStore({ sessionRoot: rootDir });
  const missingDir = path.join(rootDir, "missing");

  store._watchDir(missingDir);

  assert.equal(store._watchedDirs.has(missingDir), false);
});

test("stopWatching 会清空 watchedDirs", async (t) => {
  const rootDir = await createTempSessionDir();
  t.after(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  const nestedDir = path.join(rootDir, "2026", "04", "21");
  await fs.mkdir(nestedDir, { recursive: true });

  const store = new SessionStore({ sessionRoot: rootDir });
  await store.watch();

  assert.ok(store._watchedDirs.has(rootDir));
  assert.ok(store._watchedDirs.has(nestedDir));

  store.stopWatching();

  assert.equal(store._watchedDirs.size, 0);
});
