import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { SessionIndexCache } from "../server/session-index-cache.js";

test("索引缓存使用逐行格式保存并可释放初始化副本", async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "allsessions-index-cache-"));
  const cacheFile = path.join(rootDir, "session-index.json");
  t.after(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  const cache = new SessionIndexCache(cacheFile);
  cache.set(
    "/tmp/one.jsonl",
    "codex",
    { size: 100, mtimeMs: 1234.9 },
    { id: "one", source_kind: "codex" },
    "第一条索引正文"
  );
  cache.set(
    "/tmp/two.jsonl",
    "codex",
    { size: 200, mtimeMs: 5678.1 },
    { id: "two", source_kind: "codex" },
    "第二条索引正文"
  );
  await cache.save();

  const lines = (await fs.readFile(cacheFile, "utf8")).trim().split("\n");
  assert.equal(lines.length, 3);
  assert.deepEqual(JSON.parse(lines[0]), { version: 7 });
  assert.equal(JSON.parse(lines[1]).file_path, "/tmp/one.jsonl");
  assert.equal(JSON.parse(lines[2]).file_path, "/tmp/two.jsonl");

  const restored = new SessionIndexCache(cacheFile);
  await restored.load();
  assert.equal(
    restored.get("/tmp/two.jsonl", "codex", { size: 200, mtimeMs: 5678.9 }).index_text,
    "第二条索引正文"
  );

  restored.release();
  assert.equal(restored.entries.size, 0);
});

test("旧版单行缓存只探测版本头，不加载整份内容", async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "allsessions-index-cache-"));
  const cacheFile = path.join(rootDir, "session-index.json");
  t.after(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  await fs.writeFile(
    cacheFile,
    JSON.stringify({ version: 3, entries: [{ index_text: "x".repeat(1024 * 1024) }] }),
    "utf8"
  );

  const cache = new SessionIndexCache(cacheFile);
  await cache.load();
  assert.equal(cache.entries.size, 0);
});
