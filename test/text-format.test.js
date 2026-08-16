import assert from "node:assert/strict";
import test from "node:test";

import { normalizeNewlines } from "../scripts/text-format.mjs";

test("许可证清单比较忽略 Windows 与 Unix 换行差异", () => {
  assert.equal(normalizeNewlines("a\r\nb\rc\n"), "a\nb\nc\n");
});
