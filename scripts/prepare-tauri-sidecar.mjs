import { chmod, copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function parseTargetArgument(argv) {
  const targetIndex = argv.indexOf("--target");
  if (targetIndex === -1) return undefined;
  const target = argv[targetIndex + 1];
  if (!target || target.startsWith("--")) throw new Error("--target 缺少目标三元组");
  return target;
}

export function hostTargetTriple() {
  return execFileSync("rustc", ["--print", "host-tuple"], { encoding: "utf8" }).trim();
}

export function sidecarFileName(target) {
  return `node-${target}${target.includes("windows") ? ".exe" : ""}`;
}

export async function prepareSidecar({ target = hostTargetTriple(), executable = process.execPath } = {}) {
  if (!/^[A-Za-z0-9_.-]+$/.test(target)) throw new Error(`无效的目标三元组：${target}`);
  const binariesDir = path.join(projectRoot, "src-tauri", "binaries");
  const destination = path.join(binariesDir, sidecarFileName(target));
  await mkdir(binariesDir, { recursive: true });
  await copyFile(executable, destination);
  if (!target.includes("windows")) await chmod(destination, 0o755);
  return destination;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = parseTargetArgument(process.argv.slice(2));
  const destination = await prepareSidecar({ target });
  console.log(`Node sidecar 已准备：${destination}`);
}
