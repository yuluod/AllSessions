import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertReleaseVersion,
  installerFileName,
  packageArchitecture,
  parseCliArguments,
  prepareReleasePayload
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
  await writeFixtureFile(rootDir, "package.json", '{"name":"allsessions","version":"1.2.3"}');
  await writeFixtureFile(rootDir, "README.md");
  await writeFixtureFile(rootDir, "README.zh-CN.md");
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
    "AllSessions-1.2.3-darwin-arm64.pkg"
  );
  assert.equal(
    installerFileName({ platform: "linux", arch: "x64", version: "1.2.3" }),
    "AllSessions-1.2.3-linux-x64.deb"
  );
});

test("发布标签必须与 package.json 版本一致", () => {
  assert.doesNotThrow(() => assertReleaseVersion("1.2.3", "v1.2.3"));
  assert.throws(() => assertReleaseVersion("1.2.3", "v1.2.4"), /does not match/);
  assert.throws(() => assertReleaseVersion("invalid"), /Invalid release version/);
});

test("Windows 发布载荷包含独立运行时和隐藏窗口启动器", async (t) => {
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
  assert.match(await readFile(path.join(staging.payloadDir, "AllSessions.cmd"), "utf8"), /ALLSESSIONS_OPEN_BROWSER=1/);
  assert.match(await readFile(path.join(staging.payloadDir, "AllSessions.vbs"), "utf8"), /WScript\.Shell/);
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
});
