import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const noticePath = path.join(projectRoot, "THIRD_PARTY_NOTICES.md");
const bundledNodeLicensePath = path.join(projectRoot, "third-party", "node", "LICENSE");

async function cargoPackages() {
  const lock = await fs.readFile(path.join(projectRoot, "src-tauri", "Cargo.lock"), "utf8");
  return lock.split("[[package]]").slice(1).map((block) => {
    const name = /^name = "([^"]+)"/m.exec(block)?.[1];
    const version = /^version = "([^"]+)"/m.exec(block)?.[1];
    const source = /^source = "([^"]+)"/m.exec(block)?.[1];
    return { name, version, source };
  }).filter((pkg) => pkg.name && pkg.version && pkg.source)
    .sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
}

async function registrySourceRoots() {
  const cargoHome = process.env.CARGO_HOME || path.join(os.homedir(), ".cargo");
  const sourceDir = path.join(cargoHome, "registry", "src");
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(sourceDir, entry.name));
}

async function licenseFromRegistrySource(pkg, roots) {
  for (const root of roots) {
    try {
      const manifest = await fs.readFile(path.join(root, `${pkg.name}-${pkg.version}`, "Cargo.toml"), "utf8");
      const license = /^license = "([^"]+)"/m.exec(manifest)?.[1];
      if (license) return license;
      const licenseFile = /^license-file = "([^"]+)"/m.exec(manifest)?.[1];
      if (licenseFile) return `LicenseRef-${licenseFile}`;
    } catch (error) {
      if (!error || typeof error !== "object" || error.code !== "ENOENT") throw error;
    }
  }
  throw new Error(`Cargo 源码缓存缺少 ${pkg.name} ${pkg.version} 的许可证元数据，请先运行 cargo fetch --locked`);
}

function renderNotice(packages) {
  const rows = packages.map((pkg) => `| ${pkg.name} | ${pkg.version} | ${pkg.license} |`).join("\n");
  return `# Third-Party Notices

AllSessions 的桌面安装包包含以下第三方软件。此清单由
\`pnpm licenses:generate\` 根据锁定依赖生成；发布前由 CI 验证。

## Node.js

桌面安装包会捆绑 Node.js ${process.version}。Node.js 使用 MIT 许可证，并包含其自身依赖的
第三方许可声明。完整许可证文本随安装包提供在 \`third-party/node/LICENSE\`。

来源：https://github.com/nodejs/node

## Rust dependencies

以下锁定依赖由 Tauri 桌面程序静态链接或用于其构建。每个 crate 的许可证正文随其源码包
发布，可按名称和版本在 https://crates.io 查看。

| Package | Version | License |
| --- | --- | --- |
${rows}
`;
}

const expectedNodeVersion = await fs.readFile(path.join(projectRoot, ".nvmrc"), "utf8").then((value) => value.trim());
if (process.version !== `v${expectedNodeVersion}`) {
  throw new Error(`许可证必须使用 Node v${expectedNodeVersion} 生成，当前为 ${process.version}`);
}

const nodeLicenseCandidates = [
  path.join(path.dirname(process.execPath), "LICENSE"),
  path.join(path.dirname(path.dirname(process.execPath)), "LICENSE")
];
let nodeLicense = null;
for (const candidate of nodeLicenseCandidates) {
  try {
    nodeLicense = await fs.readFile(candidate, "utf8");
    break;
  } catch (error) {
    if (!error || typeof error !== "object" || error.code !== "ENOENT") throw error;
  }
}
if (!nodeLicense) throw new Error(`当前 Node.js 安装缺少 LICENSE：${process.execPath}`);
const checkOnly = process.argv.includes("--check");
const packages = await cargoPackages();
const roots = await registrySourceRoots();
for (const pkg of packages) pkg.license = await licenseFromRegistrySource(pkg, roots);

const notice = renderNotice(packages);

if (checkOnly) {
  const [currentNotice, currentNodeLicense] = await Promise.all([
    fs.readFile(noticePath, "utf8"),
    fs.readFile(bundledNodeLicensePath, "utf8")
  ]);
  if (currentNotice !== notice || currentNodeLicense !== nodeLicense) {
    throw new Error("第三方许可证材料已过期，请运行 pnpm licenses:generate");
  }
} else {
  await fs.mkdir(path.dirname(bundledNodeLicensePath), { recursive: true });
  await Promise.all([
    fs.writeFile(noticePath, notice, "utf8"),
    fs.writeFile(bundledNodeLicensePath, nodeLicense, "utf8")
  ]);
}
