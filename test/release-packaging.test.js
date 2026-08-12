import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { releaseFileName } from "../scripts/collect-tauri-artifact.mjs";
import { parseTargetArgument, sidecarFileName } from "../scripts/prepare-tauri-sidecar.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");

test("Tauri sidecar 使用目标三元组命名", () => {
  assert.equal(sidecarFileName("x86_64-pc-windows-msvc"), "node-x86_64-pc-windows-msvc.exe");
  assert.equal(sidecarFileName("aarch64-apple-darwin"), "node-aarch64-apple-darwin");
  assert.equal(parseTargetArgument(["--target", "x86_64-unknown-linux-gnu"]), "x86_64-unknown-linux-gnu");
  assert.throws(() => parseTargetArgument(["--target"]), /缺少目标三元组/);
});

test("跨平台安装包名称保持稳定且 macOS 使用 mac", () => {
  assert.equal(
    releaseFileName({ platform: "windows", arch: "x64", version: "1.2.3" }),
    "AllSessions-1.2.3-windows-x64-setup.exe"
  );
  assert.equal(
    releaseFileName({ platform: "mac", arch: "arm64", version: "1.2.3" }),
    "AllSessions-1.2.3-mac-arm64.dmg"
  );
  assert.equal(
    releaseFileName({ platform: "linux", arch: "x64", version: "1.2.3" }),
    "AllSessions-1.2.3-linux-x64.deb"
  );
});

test("桌面能力统一由 Tauri 提供", async () => {
  const [config, cargo, rustSource, updater, workflow] = await Promise.all([
    readFile(path.join(projectRoot, "src-tauri", "tauri.conf.json"), "utf8"),
    readFile(path.join(projectRoot, "src-tauri", "Cargo.toml"), "utf8"),
    readFile(path.join(projectRoot, "src-tauri", "src", "lib.rs"), "utf8"),
    readFile(path.join(projectRoot, "src-tauri", "src", "updater.rs"), "utf8"),
    readFile(path.join(projectRoot, ".github", "workflows", "release.yml"), "utf8")
  ]);

  assert.match(config, /"externalBin": \["binaries\/node"\]/);
  assert.match(config, /"installMode": "currentUser"/);
  assert.match(cargo, /features = \["tray-icon", "image-png"\]/);
  assert.match(rustSource, /TrayIconBuilder/);
  assert.match(rustSource, /sidecar\("node"\)/);
  assert.match(rustSource, /tauri_plugin_updater::Builder/);
  assert.match(updater, /检查或安装更新失败/);
  assert.match(updater, /download_and_install/);
  assert.match(config, /"createUpdaterArtifacts": true/);
  assert.match(config, /releases\/latest\/download\/latest\.json/);
  assert.match(cargo, /tauri-plugin-updater = "2\.10"/);
  assert.match(workflow, /libwebkit2gtk-4\.1-dev/);
  assert.match(workflow, /tauri-apps\/tauri-action@v0/);
  assert.match(workflow, /TAURI_SIGNING_PRIVATE_KEY/);
  assert.match(workflow, /updaterJsonPreferNsis: true/);
  assert.doesNotMatch(workflow, /actions\/(?:checkout|setup-node)@v4/);
});
