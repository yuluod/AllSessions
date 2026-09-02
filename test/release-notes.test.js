import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { extractReleaseNotes } from "../scripts/extract-release-notes.mjs";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

test("发布说明只提取标签对应的更新日志", async () => {
  const changelog = await readFile(path.join(rootDir, "CHANGELOG.md"), "utf8");
  const notes = extractReleaseNotes(changelog, "v0.0.5");

  assert.match(notes, /Windows 托盘支持检查 GitHub Release 更新/);
  assert.match(notes, /mac-arm64\.pkg/);
  assert.doesNotMatch(notes, /\[0\.0\.4\]/);
});

test("更新日志缺少对应版本时阻止发布", () => {
  assert.throws(
    () =>
      extractReleaseNotes("# 更新日志\n\n## [0.0.4]\n\n- 旧版本\n", "v0.0.5"),
    /does not contain version 0\.0\.5/
  );
});

test("发布工作流使用当前版本更新日志", async () => {
  const workflow = await readFile(
    path.join(rootDir, ".github", "workflows", "release.yml"),
    "utf8"
  );

  assert.match(
    workflow,
    /extract-release-notes\.mjs "\$RELEASE_TAG" CHANGELOG\.md release-notes\.md/
  );
  assert.match(
    workflow,
    /gh release (?:create|edit)[\s\S]*--notes-file release-notes\.md/
  );
});
