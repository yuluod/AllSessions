import test from "node:test";
import assert from "node:assert/strict";

import { ByteLruCache } from "../server/byte-lru-cache.js";

test("详情缓存按字节预算淘汰，而不是固定缓存若干大会话", () => {
  const cache = new ByteLruCache(100);
  cache.set("a", { id: "a" }, 60);
  cache.set("b", { id: "b" }, 30);
  assert.equal(cache.get("a").id, "a");

  cache.set("c", { id: "c" }, 40);

  assert.equal(cache.has("a"), true);
  assert.equal(cache.has("b"), false);
  assert.equal(cache.has("c"), true);
  assert.equal(cache.bytes, 100);
});

test("单项超过缓存预算时直接返回但不驻留缓存", () => {
  const cache = new ByteLruCache(100);
  const cached = cache.set("huge", { id: "huge" }, 101);

  assert.equal(cached, false);
  assert.equal(cache.has("huge"), false);
  assert.equal(cache.bytes, 0);
});
