import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

function run(cmd, args, label) {
  console.log(`▸ ${label}`);
  execFileSync(cmd, args, {
    cwd: projectRoot,
    stdio: "inherit",
    encoding: "utf8",
  });
}

function computeBundleNumber(version) {
  const [major, minor, patch] = version.split(".").map(Number);
  return String(major * 1_000_000 + minor * 1_000 + patch);
}

async function updateJsonFile(filePath, updater) {
  const text = await fs.readFile(filePath, "utf8");
  const data = JSON.parse(text);
  updater(data);
  await fs.writeFile(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

async function updateCargoVersion(filePath, version) {
  const text = await fs.readFile(filePath, "utf8");
  const updated = text.replace(/^version = "[^"]*"/m, `version = "${version}"`);
  await fs.writeFile(filePath, updated, "utf8");
}

async function main() {
  const version = process.argv[2];
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    console.error("用法: pnpm release:prepare <version>  (例如 0.2.0)");
    process.exit(1);
  }

  const bundleNumber = computeBundleNumber(version);
  const cargoToml = path.join(projectRoot, "src-tauri", "Cargo.toml");
  const tauriConf = path.join(projectRoot, "src-tauri", "tauri.conf.json");
  const packageJson = path.join(projectRoot, "package.json");

  console.log(
    `\n准备发布 v${version} (macOS bundleVersion: ${bundleNumber})\n`
  );

  // 1. 更新版本号
  console.log("▸ 更新版本号");
  await updateJsonFile(packageJson, (data) => {
    data.version = version;
  });
  await updateJsonFile(tauriConf, (data) => {
    data.bundle.macOS.bundleVersion = bundleNumber;
  });
  await updateCargoVersion(cargoToml, version);

  // 2. 更新 Cargo.lock（仅更新本包版本条目，避免意外升级传递依赖）
  run(
    "cargo",
    ["update", "-p", "allsessions", "--manifest-path", "src-tauri/Cargo.toml"],
    "更新 Cargo.lock"
  );

  // 3. 拉取依赖源码（许可证生成需要源码缓存）
  run(
    "cargo",
    ["fetch", "--manifest-path", "src-tauri/Cargo.toml", "--locked"],
    "拉取 Rust 依赖源码"
  );

  // 4. 重新生成第三方许可证清单
  run(
    "node",
    ["scripts/generate-third-party-notices.mjs"],
    "生成 THIRD_PARTY_NOTICES.md"
  );

  console.log(`\n✓ 版本号、Cargo.lock 和许可证清单已更新`);
  console.log(`\n下一步:`);
  console.log(`  1. 编辑 CHANGELOG.md 添加 [${version}] 版本段落`);
  console.log(
    `  2. git add -A && git commit -m "chore(release): prepare v${version}"`
  );
  console.log(`  3. git tag v${version}`);
  console.log(`  4. git push && git push origin v${version}\n`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
