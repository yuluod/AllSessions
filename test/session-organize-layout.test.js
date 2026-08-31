import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

test("会话整理面板受详情工具栏边界约束", async () => {
  const styles = await fs.readFile(
    path.join(rootDir, "public/styles/workspace.css"),
    "utf8"
  );

  assert.match(styles, /\.detail-topbar-right\s*\{[^}]*position: relative;/);
  assert.match(styles, /\.session-organize-menu\s*\{[^}]*position: static;/);
  assert.match(
    styles,
    /\.session-organize-body\s*\{[^}]*left: 0;[^}]*right: auto;[^}]*width: min\(360px, 100%\);/
  );
});
