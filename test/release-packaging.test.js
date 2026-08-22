import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { buildUpdaterManifest } from "../scripts/build-updater-manifest.mjs";
import { releaseFileName, updaterFileName } from "../scripts/collect-tauri-artifact.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");

test("跨平台安装包名称保持稳定且 macOS 使用 mac", () => {
  assert.equal(releaseFileName({ platform: "windows", arch: "x64", version: "1.2.3" }), "AllSessions-1.2.3-windows-x64-setup.exe");
  assert.equal(releaseFileName({ platform: "mac", arch: "arm64", version: "1.2.3" }), "AllSessions-1.2.3-mac-arm64.dmg");
  assert.equal(releaseFileName({ platform: "linux", arch: "x64", version: "1.2.3" }), "AllSessions-1.2.3-linux-x64.deb");
});

test("更新安装包复用公开文件名且 macOS 使用独立更新压缩包", () => {
  assert.equal(updaterFileName({ platform: "windows", arch: "x64", version: "1.2.3" }), "AllSessions-1.2.3-windows-x64-setup.exe");
  assert.equal(updaterFileName({ platform: "mac", arch: "arm64", version: "1.2.3" }), "AllSessions-1.2.3-mac-arm64.app.tar.gz");
  assert.equal(updaterFileName({ platform: "mac", arch: "x64", version: "1.2.3" }), "AllSessions-1.2.3-mac-x64.app.tar.gz");
  assert.equal(updaterFileName({ platform: "linux", arch: "x64", version: "1.2.3" }), "AllSessions-1.2.3-linux-x64.deb");
});

test("更新清单同时包含所有桌面平台及安装器别名", () => {
  const names = [
    "AllSessions-0.0.8-mac-arm64.app.tar.gz",
    "AllSessions-0.0.8-mac-x64.app.tar.gz",
    "AllSessions-0.0.8-linux-x64.deb",
    "AllSessions-0.0.8-windows-x64-setup.exe"
  ];
  const metadata = {
    tagName: "v0.0.8",
    publishedAt: "2026-08-13T00:00:00Z",
    body: "修复更新",
    assets: names.map((name) => ({ name, url: `https://example.com/${name}` }))
  };
  const signatures = Object.fromEntries(names.map((name) => [`${name}.sig`, `signature:${name}`]));

  const manifest = buildUpdaterManifest({ metadata, signatures, version: "0.0.8" });

  assert.deepEqual(
    Object.keys(manifest.platforms).sort(),
    [
      "darwin-aarch64",
      "darwin-aarch64-app",
      "darwin-x86_64",
      "darwin-x86_64-app",
      "linux-x86_64",
      "linux-x86_64-deb",
      "windows-x86_64",
      "windows-x86_64-nsis"
    ]
  );
  assert.equal(
    manifest.platforms["darwin-aarch64"].url,
    "https://example.com/AllSessions-0.0.8-mac-arm64.app.tar.gz"
  );
});

test("更新清单缺少任一目标平台时拒绝发布", () => {
  assert.throws(
    () => buildUpdaterManifest({
      metadata: {
        tagName: "v0.0.8",
        publishedAt: "2026-08-13T00:00:00Z",
        assets: [{ name: "AllSessions_0.0.8_x64-setup.exe", url: "https://example.com/windows.exe" }]
      },
      signatures: { "AllSessions_0.0.8_x64-setup.exe.sig": "signature" },
      version: "0.0.8"
    }),
    /更新清单缺少平台/
  );
});

test("更新清单不会保留 GitHub 草稿资源的临时地址", () => {
  const names = [
    "AllSessions-0.0.15-mac-arm64.app.tar.gz",
    "AllSessions-0.0.15-mac-x64.app.tar.gz",
    "AllSessions-0.0.15-linux-x64.deb",
    "AllSessions-0.0.15-windows-x64-setup.exe"
  ];
  const metadata = {
    tagName: "v0.0.15",
    publishedAt: "2026-08-21T00:00:00Z",
    assets: names.map((name) => ({
      name,
      url: `https://github.com/yuluod/AllSessions/releases/download/untagged-draft/${name}`
    }))
  };
  const signatures = Object.fromEntries(names.map((name) => [`${name}.sig`, `signature:${name}`]));

  const manifest = buildUpdaterManifest({ metadata, signatures, version: "0.0.15" });

  assert.equal(
    manifest.platforms["windows-x86_64"].url,
    "https://github.com/yuluod/AllSessions/releases/download/v0.0.15/AllSessions-0.0.15-windows-x64-setup.exe"
  );
  assert.ok(Object.values(manifest.platforms).every(({ url }) => !url.includes("/untagged-")));
});

test("桌面运行时完全由 Rust 与 Tauri 提供", async () => {
  const [config, cargo, rustSource, backend, mainSource, updater, workflow] = await Promise.all([
    readFile(path.join(projectRoot, "src-tauri", "tauri.conf.json"), "utf8"),
    readFile(path.join(projectRoot, "src-tauri", "Cargo.toml"), "utf8"),
    readFile(path.join(projectRoot, "src-tauri", "src", "lib.rs"), "utf8"),
    readFile(path.join(projectRoot, "src-tauri", "src", "backend.rs"), "utf8"),
    readFile(path.join(projectRoot, "src-tauri", "src", "main.rs"), "utf8"),
    readFile(path.join(projectRoot, "src-tauri", "src", "updater.rs"), "utf8"),
    readFile(path.join(projectRoot, ".github", "workflows", "release.yml"), "utf8")
  ]);

  assert.doesNotMatch(config, /externalBin|binaries\/node|server\//);
  assert.match(config, /"frontendDist": "\.\.\/dist"/);
  assert.match(config, /"beforeBuildCommand": "pnpm build"/);
  assert.match(config, /"withGlobalTauri": true/);
  assert.match(config, /"installMode": "currentUser"/);
  assert.doesNotMatch(config, /"csp": null/);
  assert.match(cargo, /rusqlite/);
  assert.match(cargo, /notify =/);
  assert.match(rustSource, /TrayIconBuilder/);
  assert.match(rustSource, /generate_handler!\[request_json\]/);
  assert.match(backend, /sessions-changed/);
  assert.doesNotMatch(rustSource, /sidecar|TcpListener|ALLSESSIONS_INSTANCE_TOKEN/);
  assert.match(mainSource, /windows_subsystem = "windows"/);
  assert.match(rustSource, /tauri_plugin_updater::Builder/);
  assert.match(
    rustSource,
    /MenuItem::with_id\(app, "settings", "设置…"/
  );
  assert.match(
    rustSource,
    /"settings" => show_settings\(app\)/
  );
  assert.match(
    rustSource,
    /fn show_settings[\s\S]*show_main_window\(app\)[\s\S]*emit\("open-settings"/
  );
  assert.match(
    rustSource,
    /check_updates_on_startup[\s\S]*updater::check_for_updates_silently/
  );
  assert.match(updater, /检查或安装更新失败/);
  assert.match(updater, /download_and_install/);
  assert.match(
    updater,
    /mode == UpdateCheckMode::Silent[\s\S]*return/
  );
  assert.match(
    updater,
    /mode == UpdateCheckMode::Interactive[\s\S]*当前版本 v\{\} 已是最新版本/
  );
  assert.match(config, /"createUpdaterArtifacts": true/);
  assert.match(config, /releases\/latest\/download\/latest\.json/);
  assert.match(workflow, /libwebkit2gtk-4\.1-dev/);
  assert.match(workflow, /tauri-apps\/tauri-action@v0/);
  assert.match(workflow, /TAURI_SIGNING_PRIVATE_KEY/);
});

test("原生更新确认使用中文文案且托盘图标符合状态栏规范", async () => {
  const [rustSource, updater] = await Promise.all([
    readFile(path.join(projectRoot, "src-tauri", "src", "lib.rs"), "utf8"),
    readFile(path.join(projectRoot, "src-tauri", "src", "updater.rs"), "utf8")
  ]);

  assert.match(
    updater,
    /MessageDialogButtons::OkCancelCustom\([\s\S]*"立即下载并安装"[\s\S]*"暂不"/
  );
  assert.doesNotMatch(updater, /MessageDialogButtons::YesNo/);
  assert.match(rustSource, /fn transparent_tray_icon\(\)/);
  assert.match(rustSource, /\.icon\(transparent_tray_icon\(\)\?\)/);
  assert.match(rustSource, /\.icon_as_template\(true\)/);
  assert.doesNotMatch(rustSource, /app\.default_window_icon/);
});

test("安装包包含 Rust 许可证且发布依赖质量门禁", async () => {
  const [config, releaseWorkflow, ciWorkflow, packageJson, notices] = await Promise.all([
    readFile(path.join(projectRoot, "src-tauri", "tauri.conf.json"), "utf8"),
    readFile(path.join(projectRoot, ".github", "workflows", "release.yml"), "utf8"),
    readFile(path.join(projectRoot, ".github", "workflows", "ci.yml"), "utf8"),
    readFile(path.join(projectRoot, "package.json"), "utf8"),
    readFile(path.join(projectRoot, "THIRD_PARTY_NOTICES.md"), "utf8")
  ]);

  assert.match(config, /THIRD_PARTY_NOTICES\.md/);
  assert.doesNotMatch(config, /third-party\/node/);
  assert.match(releaseWorkflow, /quality:[\s\S]*pnpm licenses:check[\s\S]*pnpm test[\s\S]*pnpm lint[\s\S]*pnpm build/);
  assert.match(releaseWorkflow, /build-installers:[\s\S]*needs: quality/);
  assert.match(releaseWorkflow, /publish:[\s\S]*needs: build-installers/);
  assert.match(ciWorkflow, /pull_request:[\s\S]*pnpm licenses:check[\s\S]*cargo test/);
  assert.match(packageJson, /"licenses:check"/);
  assert.doesNotMatch(notices, /## Node\.js/);
  assert.match(notices, /## Rust dependencies/);
  assert.match(notices, /\| tauri \| 2\.\d+\.\d+ \| (?:Apache|MIT)/);
});

test("macOS 构建号独立于显示版本且发布会汇总更新清单", async () => {
  const [configText, packageText, workflow] = await Promise.all([
    readFile(path.join(projectRoot, "src-tauri", "tauri.conf.json"), "utf8"),
    readFile(path.join(projectRoot, "package.json"), "utf8"),
    readFile(path.join(projectRoot, ".github", "workflows", "release.yml"), "utf8")
  ]);
  const config = JSON.parse(configText);
  const packageJson = JSON.parse(packageText);
  const [major, minor, patch] = packageJson.version.split(".").map(Number);
  const expectedBuildNumber = String(major * 1_000_000 + minor * 1_000 + patch);

  assert.equal(config.bundle.macOS.bundleVersion, expectedBuildNumber);
  assert.match(workflow, /bundles: app,dmg/);
  assert.match(workflow, /actions\/upload-artifact@v7/);
  assert.match(workflow, /actions\/download-artifact@v8/);
  assert.match(workflow, /path: release\/\*/);
  assert.doesNotMatch(workflow, /path: \|[\s\S]*release\/bundle\/\*\*/);
  assert.match(workflow, /EXISTING_ASSET_URLS[\s\S]*gh api --method DELETE/);
  assert.doesNotMatch(workflow, /gh release upload[^\n]*--clobber/);
  assert.match(workflow, /publish:[\s\S]*needs: build-installers/);
  assert.match(workflow, /publish:[\s\S]*build-updater-manifest\.mjs[\s\S]*gh release upload/);
  const uploadStep =
    workflow.match(/- name: 上传全部安装包到草稿[\s\S]*?- name: 生成并上传完整更新清单/)?.[0] ?? "";
  assert.doesNotMatch(uploadStep, /\.sig/);
  assert.match(
    workflow,
    /build-updater-manifest\.mjs release-metadata\.json release-assets latest\.json/
  );
  assert.doesNotMatch(workflow, /gh release download[\s\S]*--pattern '\*\.sig'/);
  assert.match(workflow, /gh release create[\s\S]*--draft/);
  assert.match(workflow, /gh release edit[\s\S]*--draft=false/);
  assert.doesNotMatch(
    workflow.match(/build-installers:[\s\S]*?\n[ ]{2}publish:/)?.[0] ?? "",
    /gh release (?:create|upload|edit)/
  );
});
