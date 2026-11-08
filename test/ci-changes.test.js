import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  checkFormatting,
  requiresPackaging,
} from "../scripts/check-ci-changes.mjs";

test("打包配置、源码、依赖和工作流变更触发安装包验证", () => {
  for (const file of [
    "src-tauri/tauri.conf.json",
    "src-tauri/src/lib.rs",
    "src-tauri/icons/icon.icns",
    "scripts/collect-tauri-artifact.mjs",
    ".github/workflows/ci.yml",
    ".github/tauri-ci.json",
    "package.json",
    "pnpm-lock.yaml",
    ".nvmrc",
    "rust-toolchain.toml",
    "vite.config.js",
    "CHANGELOG.md",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
  ]) {
    assert.equal(requiresPackaging([file]), true, file);
  }
  assert.equal(requiresPackaging([]), false);
  assert.equal(
    requiresPackaging(["README.md", "public/app.js", "test/layout.test.js"]),
    false
  );
});

test("格式检查识别失败文件并跳过无解析器文件", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "allsessions-ci-format-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const valid = path.join(root, "valid.json");
  const invalid = path.join(root, "含空格 bad.json");
  const binary = path.join(root, "icon.icns");
  await writeFile(valid, '{ "enabled": true }\r\n');
  await writeFile(invalid, '{"enabled":true}');
  await writeFile(binary, Buffer.from([0, 255, 1]));

  await checkFormatting([valid, binary]);
  await assert.rejects(checkFormatting([invalid]), (error) => {
    assert.ok(error.message.includes(invalid));
    return true;
  });
  await assert.rejects(checkFormatting([path.join(root, "missing.json")]));
});
