import test from "node:test";
import assert from "node:assert/strict";

import http from "node:http";

import {
  assertLocalOnlyHost,
  assertValidPort,
  isLoopbackHost,
  listenForHttpRequests
} from "../server/server-binding.js";

test("本地查看器只允许明确的 loopback 监听地址", () => {
  for (const host of ["127.0.0.1", "127.0.0.2", "localhost", "::1", "::ffff:127.0.0.1"]) {
    assert.equal(isLoopbackHost(host), true, host);
    assert.doesNotThrow(() => assertLocalOnlyHost(host));
  }
});

test("拒绝会把无认证会话接口暴露到网络的监听地址", () => {
  for (const host of ["0.0.0.0", "::", "192.168.1.10", "example.com", ""]) {
    assert.equal(isLoopbackHost(host), false, host);
    assert.throws(() => assertLocalOnlyHost(host), /local-only|loopback/i);
  }
});

test("端口必须是有效的非零 TCP 端口", () => {
  assert.doesNotThrow(() => assertValidPort(3210));
  assert.doesNotThrow(() => assertValidPort(65_535));
  for (const port of [0, -1, 65_536, 3210.5, Number.NaN]) {
    assert.throws(() => assertValidPort(port), /PORT must be an integer/);
  }
});

test("监听失败会作为 Promise 拒绝而不是未处理 error 事件", async (t) => {
  const occupied = http.createServer();
  await new Promise((resolve) => occupied.listen(0, "127.0.0.1", resolve));
  t.after(() => occupied.close());
  const address = occupied.address();
  const candidate = http.createServer();
  t.after(() => candidate.close());

  await assert.rejects(
    listenForHttpRequests(candidate, { host: "127.0.0.1", port: address.port }),
    (error) => error?.code === "EADDRINUSE"
  );
});
