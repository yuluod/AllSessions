import assert from "node:assert/strict";
import test from "node:test";

globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
};

const { sessionTimestamp } = await import("../public/session-format.js");

test("会话列表优先展示最近活动时间", () => {
  assert.equal(
    sessionTimestamp({
      timestamp: "2026-08-20T12:53:50Z",
      last_timestamp: "2026-08-24T14:51:00Z",
    }),
    "2026-08-24T14:51:00Z"
  );
  assert.equal(
    sessionTimestamp({ timestamp: "2026-08-20T12:53:50Z" }),
    "2026-08-20T12:53:50Z"
  );
});
