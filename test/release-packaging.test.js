import assert from "node:assert/strict";
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertReleaseVersion,
  debianControlFile,
  innoScript,
  installerFileName,
  packageArchitecture,
  parseCliArguments,
  pngToIcoBuffer,
  prepareReleasePayload,
  projectRoot
} from "../scripts/build-release.mjs";

async function writeFixtureFile(rootDir, relativePath, content = "fixture") {
  const target = path.join(rootDir, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

async function createApplicationFixture(t) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "allsessions-release-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  await writeFixtureFile(rootDir, "server/index.js");
  await writeFixtureFile(rootDir, "public/index.html");
  await mkdir(path.join(rootDir, "public", "assets"), { recursive: true });
  await cp(
    path.join(projectRoot, "public", "assets", "allsessions-icon-v2.png"),
    path.join(rootDir, "public", "assets", "allsessions-icon-v2.png")
  );
  await writeFixtureFile(rootDir, "package.json", '{"name":"allsessions","version":"1.2.3"}');
  await writeFixtureFile(rootDir, "README.md");
  await writeFixtureFile(rootDir, "README.zh-CN.md");
  await writeFixtureFile(rootDir, "CHANGELOG.md");
  await writeFixtureFile(rootDir, "LICENSE");
  return rootDir;
}

test("发布参数和安装包命名保持可预测", () => {
  assert.deepEqual(parseCliArguments(["--platform", "linux", "--arch", "x64", "--prepare-only"]), {
    platform: "linux",
    arch: "x64",
    output: path.resolve(process.cwd(), "release"),
    prepareOnly: true
  });
  assert.equal(packageArchitecture("linux", "x64"), "amd64");
  assert.equal(packageArchitecture("linux", "arm64"), "arm64");
  assert.equal(
    installerFileName({ platform: "win32", arch: "x64", version: "1.2.3" }),
    "AllSessions-1.2.3-windows-x64-setup.exe"
  );
  assert.equal(
    installerFileName({ platform: "darwin", arch: "arm64", version: "1.2.3" }),
    "AllSessions-1.2.3-mac-arm64.pkg"
  );
  assert.equal(
    installerFileName({ platform: "linux", arch: "x64", version: "1.2.3" }),
    "AllSessions-1.2.3-linux-x64.deb"
  );
  assert.match(debianControlFile({ arch: "x64", version: "1.2.3" }), /Architecture: amd64\n/);
  assert.equal(debianControlFile({ arch: "x64", version: "1.2.3" }).endsWith("\n"), true);
  assert.match(debianControlFile({ arch: "x64", version: "1.2.3" }), /Depends: .*libayatana-appindicator3-1/);
});

test("发布标签必须与 package.json 版本一致", () => {
  assert.doesNotThrow(() => assertReleaseVersion("1.2.3", "v1.2.3"));
  assert.throws(() => assertReleaseVersion("1.2.3", "v1.2.4"), /does not match/);
  assert.throws(() => assertReleaseVersion("invalid"), /Invalid release version/);
});

test("Windows 安装器使用自有原生启动器", () => {
  const script = innoScript({
    payloadDir: "C:\\payload",
    outputDir: "C:\\release",
    arch: "x64",
    version: "1.2.3"
  });

  assert.doesNotMatch(script, /wscript\.exe|AllSessions\.vbs/);
  assert.equal((script.match(/Filename: "\{app\}\\AllSessions\.exe"/g) || []).length, 3);
  assert.match(script, /SetupIconFile=\{#MySourceDir\}\\AllSessions\.ico/);
  assert.match(script, /AppMutex=Local\\AllSessions\.Tray/);
});

test("PNG Logo 会转换为 Windows ICO 容器", async () => {
  const png = await readFile(path.join(projectRoot, "public", "assets", "allsessions-icon-v2.png"));
  const icon = pngToIcoBuffer(png);

  assert.equal(icon.readUInt16LE(2), 1);
  assert.equal(icon.readUInt16LE(4), 1);
  assert.equal(icon.readUInt32LE(18), 22);
  assert.deepEqual(icon.subarray(22), png);
});

test("Windows 托盘启动器提供 GitHub Release 更新检查", async () => {
  const source = await readFile(
    path.join(projectRoot, "packaging", "windows", "AllSessionsLauncher.cs"),
    "utf8"
  );

  assert.match(source, /检查更新/);
  assert.match(source, /repos\/yuluod\/AllSessions\/releases\/latest/);
  assert.match(source, /ReadCurrentVersion\(\)/);
  assert.match(source, /ThreadPool\.QueueUserWorkItem/);
  assert.match(source, /DownloadFile\(downloadUri, partialPath\)/);
  assert.match(source, /ValidateInstaller\(partialPath, asset\)/);
  assert.match(source, /SHA256\.Create\(\)/);
  assert.match(source, /ProcessStartInfo\(installerPath\)/);
});

test("macOS 和 Linux 启动器提供托盘更新安装", async () => {
  const [macSource, linuxSource, buildSource, workflow] = await Promise.all([
    readFile(path.join(projectRoot, "packaging", "macos", "AllSessionsLauncher.swift"), "utf8"),
    readFile(path.join(projectRoot, "packaging", "linux", "AllSessionsLauncher.c"), "utf8"),
    readFile(path.join(projectRoot, "scripts", "build-release.mjs"), "utf8"),
    readFile(path.join(projectRoot, ".github", "workflows", "release.yml"), "utf8")
  ]);

  assert.match(macSource, /NSStatusBar\.system\.statusItem/);
  assert.match(macSource, /检查更新/);
  assert.match(macSource, /-mac-/);
  assert.match(linuxSource, /app_indicator_new_with_path/);
  assert.match(linuxSource, /检查更新/);
  assert.match(linuxSource, /-linux-/);
  assert.match(buildSource, /"swiftc"/);
  assert.match(buildSource, /"-parse-as-library"/);
  assert.match(buildSource, /"gcc"/);
  assert.match(workflow, /libayatana-appindicator3-dev/);
  assert.doesNotMatch(workflow, /actions\/(?:checkout|setup-node)@v4/);
  assert.equal((workflow.match(/actions\/checkout@v5/g) || []).length, 2);
  assert.equal((workflow.match(/actions\/setup-node@v5/g) || []).length, 2);
  assert.equal((workflow.match(/node-version: 24/g) || []).length, 2);
});

test("Windows 发布载荷包含独立运行时、命令行入口和应用图标", async (t) => {
  const rootDir = await createApplicationFixture(t);
  const outputDir = path.join(rootDir, "release");
  const runtimeDir = path.join(rootDir, "node-runtime");
  await writeFixtureFile(runtimeDir, "node.exe", "node");

  const staging = await prepareReleasePayload({
    rootDir,
    outputDir,
    platform: "win32",
    arch: "x64",
    version: "1.2.3",
    runtimeDir
  });

  await access(path.join(staging.payloadDir, "runtime", "node.exe"));
  await access(path.join(staging.payloadDir, "server", "index.js"));
  await access(path.join(staging.payloadDir, "public", "index.html"));
  await access(path.join(staging.payloadDir, "CHANGELOG.md"));
  await access(path.join(staging.payloadDir, "AllSessions.ico"));
  assert.match(await readFile(path.join(staging.payloadDir, "AllSessions.cmd"), "utf8"), /ALLSESSIONS_OPEN_BROWSER=1/);
});

test("macOS 发布载荷会生成可安装的应用程序包", async (t) => {
  const rootDir = await createApplicationFixture(t);
  const outputDir = path.join(rootDir, "release");
  const runtimeDir = path.join(rootDir, "node-runtime");
  await writeFixtureFile(runtimeDir, path.join("bin", "node"), "node");

  const staging = await prepareReleasePayload({
    rootDir,
    outputDir,
    platform: "darwin",
    arch: "arm64",
    version: "1.2.3",
    runtimeDir
  });

  await access(path.join(staging.packageRoot, "AllSessions.app", "Contents", "Resources", "app", "server", "index.js"));
  const plist = await readFile(
    path.join(staging.packageRoot, "AllSessions.app", "Contents", "Info.plist"),
    "utf8"
  );
  assert.match(plist, /com\.allsessions\.app/);
  assert.match(plist, /<key>LSUIElement<\/key>\s*<true\/>/);
});
