import { copyFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function releaseFileName({ platform, arch, version }) {
  if (platform === "windows") return `AllSessions-${version}-windows-${arch}-setup.exe`;
  if (platform === "mac") return `AllSessions-${version}-mac-${arch}.dmg`;
  if (platform === "linux") return `AllSessions-${version}-linux-${arch}.deb`;
  throw new Error(`不支持的发布平台：${platform}`);
}

export function updaterFileName({ platform, arch, version }) {
  if (platform === "windows") return releaseFileName({ platform, arch, version });
  if (platform === "mac") return `AllSessions-${version}-mac-${arch}.app.tar.gz`;
  if (platform === "linux") return releaseFileName({ platform, arch, version });
  throw new Error(`不支持的发布平台：${platform}`);
}

async function findFiles(root, extension) {
  const entries = await readdir(root, { withFileTypes: true });
  const matches = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) matches.push(...await findFiles(fullPath, extension));
    else if (entry.name.endsWith(extension)) matches.push(fullPath);
  }
  return matches;
}

async function directoryExists(directory) {
  try {
    return (await stat(directory)).isDirectory();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function collectArtifact({ target, platform, arch, output = "release" }) {
  const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  const extension = platform === "windows" ? ".exe" : platform === "mac" ? ".dmg" : ".deb";
  const targetRoot = path.join(projectRoot, "src-tauri", "target");
  const crossTargetRoot = path.join(targetRoot, target, "release", "bundle");
  const bundleRoot = await directoryExists(crossTargetRoot)
    ? crossTargetRoot
    : path.join(targetRoot, "release", "bundle");
  const matches = await findFiles(bundleRoot, extension);
  if (matches.length !== 1) throw new Error(`期望找到 1 个 ${extension} 安装包，实际找到 ${matches.length} 个`);
  const outputDir = path.resolve(projectRoot, output);
  await mkdir(outputDir, { recursive: true });

  const stableDestination = path.join(outputDir, releaseFileName({ platform, arch, version: packageJson.version }));
  const updaterDestination = path.join(outputDir, updaterFileName({ platform, arch, version: packageJson.version }));
  const updaterMatches = platform === "mac" ? await findFiles(bundleRoot, ".app.tar.gz") : matches;
  if (updaterMatches.length !== 1) throw new Error(`期望找到 1 个 ${platform} 更新包，实际找到 ${updaterMatches.length} 个`);
  const updaterSource = updaterMatches[0];
  const copies = new Map([
    [stableDestination, matches[0]],
    [updaterDestination, updaterSource],
    [`${updaterDestination}.sig`, `${updaterSource}.sig`]
  ]);

  await Promise.all([...copies].map(([destination, source]) => copyFile(source, destination)));
  return [...copies.keys()];
}

function valueAfter(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1 || !argv[index + 1]) throw new Error(`${name} 缺少参数`);
  return argv[index + 1];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const destinations = await collectArtifact({
    target: valueAfter(argv, "--target"),
    platform: valueAfter(argv, "--platform"),
    arch: valueAfter(argv, "--arch")
  });
  console.log(`发布安装包已收集：${destinations.join(", ")}`);
}
