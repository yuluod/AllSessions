import { spawn } from "node:child_process";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(scriptDir, "..");

const applicationEntries = ["server", "public", "package.json", "README.md", "README.zh-CN.md", "LICENSE"];
const supportedPlatforms = new Set(["win32", "darwin", "linux"]);
const supportedArchitectures = new Set(["x64", "arm64"]);

function usage() {
  return [
    "Usage: node scripts/build-release.mjs [options]",
    "",
    "Options:",
    "  --platform <win32|darwin|linux>  Target platform (default: current platform)",
    "  --arch <x64|arm64>               Target architecture (default: current architecture)",
    "  --output <directory>              Artifact output directory (default: release)",
    "  --runtime-dir <directory>         Node runtime root for a cross-platform build",
    "  --version <version>               Override the version from package.json",
    "  --prepare-only                    Create the staged application without an installer",
    "  --help                            Show this help"
  ].join("\n");
}

export function parseCliArguments(argv) {
  const options = {
    platform: process.platform,
    arch: process.arch,
    output: path.resolve(process.cwd(), "release"),
    prepareOnly: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      options.help = true;
      continue;
    }
    if (argument === "--prepare-only") {
      options.prepareOnly = true;
      continue;
    }
    if (!argument.startsWith("--")) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${argument}`);
    }
    if (argument === "--platform") {
      options.platform = value;
    } else if (argument === "--arch") {
      options.arch = value;
    } else if (argument === "--output") {
      options.output = path.resolve(value);
    } else if (argument === "--runtime-dir") {
      options.runtimeDir = path.resolve(value);
    } else if (argument === "--version") {
      options.version = value;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
    index += 1;
  }

  if (!supportedPlatforms.has(options.platform)) {
    throw new Error(`Unsupported platform: ${options.platform}`);
  }
  if (!supportedArchitectures.has(options.arch)) {
    throw new Error(`Unsupported architecture: ${options.arch}`);
  }
  return options;
}

export function assertReleaseVersion(version, tagName = "") {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid release version: ${version}`);
  }
  if (tagName && tagName !== `v${version}`) {
    throw new Error(`Tag ${tagName} does not match package version v${version}`);
  }
}

export function packageArchitecture(platform, arch) {
  if (!supportedPlatforms.has(platform) || !supportedArchitectures.has(arch)) {
    throw new Error(`Unsupported target: ${platform}/${arch}`);
  }
  if (platform === "linux") {
    return arch === "x64" ? "amd64" : "arm64";
  }
  return arch;
}

export function installerFileName({ platform, arch, version }) {
  const suffix = `${platform === "win32" ? "windows" : platform}-${arch}`;
  if (platform === "win32") return `AllSessions-${version}-${suffix}-setup.exe`;
  if (platform === "darwin") return `AllSessions-${version}-${suffix}.pkg`;
  if (platform === "linux") return `AllSessions-${version}-${suffix}.deb`;
  throw new Error(`Unsupported platform: ${platform}`);
}

function runtimeExecutableRelativePath(platform) {
  return platform === "win32" ? "node.exe" : path.join("bin", "node");
}

async function pathExists(filePath) {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function requirePath(filePath, description) {
  if (!(await pathExists(filePath))) {
    throw new Error(`${description} was not found: ${filePath}`);
  }
}

export async function resolveRuntimeDirectory({ platform, runtimeDir, executablePath = process.execPath }) {
  if (runtimeDir) {
    const resolved = path.resolve(runtimeDir);
    await requirePath(path.join(resolved, runtimeExecutableRelativePath(platform)), "Node runtime executable");
    return resolved;
  }
  if (platform !== process.platform) {
    throw new Error("Cross-platform builds require --runtime-dir with the target Node runtime");
  }
  const resolved = platform === "win32"
    ? path.dirname(executablePath)
    : path.dirname(path.dirname(executablePath));
  await requirePath(path.join(resolved, runtimeExecutableRelativePath(platform)), "Node runtime executable");
  return resolved;
}

function windowsLauncher() {
  return [
    "@echo off",
    "setlocal",
    "set \"ALLSESSIONS_OPEN_BROWSER=1\"",
    "\"%~dp0runtime\\node.exe\" \"%~dp0server\\index.js\" %*"
  ].join("\r\n");
}

function windowsBackgroundLauncher() {
  return [
    "Set fileSystem = CreateObject(\"Scripting.FileSystemObject\")",
    "appRoot = fileSystem.GetParentFolderName(WScript.ScriptFullName)",
    "CreateObject(\"WScript.Shell\").Run Chr(34) & appRoot & \"\\AllSessions.cmd\" & Chr(34), 0, False"
  ].join("\r\n");
}

function unixLauncher() {
  return [
    "#!/usr/bin/env sh",
    "set -eu",
    "APP_ROOT=\"$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)\"",
    "export ALLSESSIONS_OPEN_BROWSER=1",
    "exec \"$APP_ROOT/runtime/bin/node\" \"$APP_ROOT/server/index.js\" \"$@\""
  ].join("\n");
}

function macApplicationLauncher() {
  return [
    "#!/usr/bin/env sh",
    "set -eu",
    "APP_ROOT=\"$(CDPATH= cd -- \"$(dirname -- \"$0\")/../Resources/app\" && pwd)\"",
    "export ALLSESSIONS_OPEN_BROWSER=1",
    "exec \"$APP_ROOT/runtime/bin/node\" \"$APP_ROOT/server/index.js\" \"$@\""
  ].join("\n");
}

function macInfoPlist(version) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>AllSessions</string>
  <key>CFBundleIdentifier</key>
  <string>com.allsessions.app</string>
  <key>CFBundleName</key>
  <string>AllSessions</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
  <key>CFBundleVersion</key>
  <string>${version}</string>
</dict>
</plist>
`;
}

async function createLaunchers(payloadDir, platform) {
  if (platform === "win32") {
    await writeFile(path.join(payloadDir, "AllSessions.cmd"), windowsLauncher(), "utf8");
    await writeFile(path.join(payloadDir, "AllSessions.vbs"), windowsBackgroundLauncher(), "utf8");
    return;
  }
  const launcherPath = path.join(payloadDir, "allsessions");
  await writeFile(launcherPath, unixLauncher(), "utf8");
  await chmod(launcherPath, 0o755);
}

async function createMacApplication(payloadDir, workDir, version) {
  const macRoot = path.join(workDir, "mac-root");
  const appContents = path.join(macRoot, "AllSessions.app", "Contents");
  const resourceDirectory = path.join(appContents, "Resources", "app");
  const executableDirectory = path.join(appContents, "MacOS");

  await rm(macRoot, { recursive: true, force: true });
  await mkdir(resourceDirectory, { recursive: true });
  await cp(payloadDir, resourceDirectory, { recursive: true, force: true });
  await mkdir(executableDirectory, { recursive: true });
  const executablePath = path.join(executableDirectory, "AllSessions");
  await writeFile(executablePath, macApplicationLauncher(), "utf8");
  await chmod(executablePath, 0o755);
  await writeFile(path.join(appContents, "Info.plist"), macInfoPlist(version), "utf8");

  return macRoot;
}

export async function prepareReleasePayload({
  rootDir = projectRoot,
  outputDir,
  platform,
  arch,
  version,
  runtimeDir
}) {
  packageArchitecture(platform, arch);
  if (!runtimeDir && arch !== process.arch) {
    throw new Error("Cross-architecture builds require --runtime-dir with the target Node runtime");
  }
  const workDir = path.join(path.resolve(outputDir), "work", `${platform}-${arch}`);
  const payloadDir = path.join(workDir, "payload");
  const runtimeSource = await resolveRuntimeDirectory({ platform, runtimeDir });

  await rm(payloadDir, { recursive: true, force: true });
  await mkdir(payloadDir, { recursive: true });
  for (const entry of applicationEntries) {
    const source = path.join(rootDir, entry);
    await requirePath(source, "Application file");
    await cp(source, path.join(payloadDir, entry), { recursive: true, force: true });
  }
  await cp(runtimeSource, path.join(payloadDir, "runtime"), { recursive: true, force: true });
  await requirePath(
    path.join(payloadDir, "runtime", runtimeExecutableRelativePath(platform)),
    "Bundled Node runtime executable"
  );
  await createLaunchers(payloadDir, platform);

  const packageRoot = platform === "darwin"
    ? await createMacApplication(payloadDir, workDir, version)
    : payloadDir;
  return { workDir, payloadDir, packageRoot };
}

function innoScript({ payloadDir, outputDir, arch, version }) {
  const innoArchitecture = arch === "x64" ? "x64compatible" : "arm64";
  return `#define MyAppName "AllSessions"
#define MyAppVersion "${version}"
#define MySourceDir "${payloadDir}"
#define MyOutputDir "${outputDir}"

[Setup]
AppId={{E812A8DC-B651-4E10-B99B-A071BFC24353}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher=AllSessions
DefaultDirName={autopf}\\AllSessions
DefaultGroupName=AllSessions
DisableProgramGroupPage=yes
OutputDir={#MyOutputDir}
OutputBaseFilename=AllSessions-${version}-windows-${arch}-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=${innoArchitecture}
ArchitecturesInstallIn64BitMode=${innoArchitecture}

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional shortcuts:"

[Files]
Source: "{#MySourceDir}\\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\\AllSessions"; Filename: "{app}\\AllSessions.vbs"; WorkingDir: "{app}"
Name: "{autodesktop}\\AllSessions"; Filename: "{app}\\AllSessions.vbs"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\\AllSessions.vbs"; Description: "Launch AllSessions"; Flags: nowait postinstall skipifsilent
`;
}

function runCommand(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with ${signal || `code ${code}`}`));
    });
  });
}

async function createWindowsInstaller({ payloadDir, workDir, outputDir, arch, version }) {
  const scriptPath = path.join(workDir, "installer.iss");
  await writeFile(scriptPath, innoScript({ payloadDir, outputDir, arch, version }), "utf8");
  await runCommand(process.env.ISCC_PATH || "ISCC.exe", [scriptPath], workDir);
}

async function createMacInstaller({ packageRoot, outputDir, arch, version }) {
  const artifactPath = path.join(outputDir, installerFileName({ platform: "darwin", arch, version }));
  await runCommand(
    "pkgbuild",
    [
      "--root",
      packageRoot,
      "--identifier",
      "com.allsessions.app",
      "--version",
      version,
      "--install-location",
      "/Applications",
      artifactPath
    ],
    packageRoot
  );
}

async function createLinuxInstaller({ payloadDir, workDir, outputDir, arch, version }) {
  const debRoot = path.join(workDir, "deb-root");
  const appDirectory = path.join(debRoot, "opt", "AllSessions");
  const executableDirectory = path.join(debRoot, "usr", "bin");
  const desktopDirectory = path.join(debRoot, "usr", "share", "applications");
  const controlDirectory = path.join(debRoot, "DEBIAN");
  const artifactPath = path.join(outputDir, installerFileName({ platform: "linux", arch, version }));

  await rm(debRoot, { recursive: true, force: true });
  await mkdir(appDirectory, { recursive: true });
  await cp(payloadDir, appDirectory, { recursive: true, force: true });
  await mkdir(executableDirectory, { recursive: true });
  await symlink("/opt/AllSessions/allsessions", path.join(executableDirectory, "allsessions"));
  await mkdir(desktopDirectory, { recursive: true });
  await writeFile(
    path.join(desktopDirectory, "allsessions.desktop"),
    [
      "[Desktop Entry]",
      "Type=Application",
      "Name=AllSessions",
      "Comment=Local AI session viewer",
      "Exec=/opt/AllSessions/allsessions",
      "Terminal=false",
      "Categories=Development;Utility;"
    ].join("\n"),
    "utf8"
  );
  await mkdir(controlDirectory, { recursive: true });
  await writeFile(
    path.join(controlDirectory, "control"),
    [
      "Package: allsessions",
      `Version: ${version}`,
      "Section: utils",
      "Priority: optional",
      `Architecture: ${packageArchitecture("linux", arch)}`,
      "Maintainer: AllSessions <maintainers@allsessions.local>",
      "Description: Local AI session viewer",
      " AllSessions reads local Codex, Claude Code, and Gemini CLI session histories."
    ].join("\n"),
    "utf8"
  );
  await runCommand("dpkg-deb", ["--root-owner-group", "--build", debRoot, artifactPath], workDir);
}

export async function createInstaller({ platform, arch, version, ...staging }) {
  const outputDir = path.resolve(staging.outputDir);
  await mkdir(outputDir, { recursive: true });
  if (platform === "win32") {
    await createWindowsInstaller({ ...staging, outputDir, arch, version });
  } else if (platform === "darwin") {
    await createMacInstaller({ ...staging, outputDir, arch, version });
  } else if (platform === "linux") {
    await createLinuxInstaller({ ...staging, outputDir, arch, version });
  } else {
    throw new Error(`Unsupported platform: ${platform}`);
  }
  const artifactPath = path.join(outputDir, installerFileName({ platform, arch, version }));
  await requirePath(artifactPath, "Installer artifact");
  return artifactPath;
}

async function readProjectVersion(rootDir) {
  const manifest = JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8"));
  if (!manifest.version || typeof manifest.version !== "string") {
    throw new Error("package.json must contain a version string");
  }
  return manifest.version;
}

async function main() {
  const options = parseCliArguments(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const version = options.version || await readProjectVersion(projectRoot);
  const tagName = process.env.RELEASE_TAG
    || (process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : "");
  assertReleaseVersion(version, tagName);

  const staging = await prepareReleasePayload({
    rootDir: projectRoot,
    outputDir: options.output,
    platform: options.platform,
    arch: options.arch,
    version,
    runtimeDir: options.runtimeDir
  });
  if (options.prepareOnly) {
    console.log(`Release payload prepared: ${staging.packageRoot}`);
    return;
  }
  const artifactPath = await createInstaller({
    ...staging,
    outputDir: options.output,
    platform: options.platform,
    arch: options.arch,
    version
  });
  console.log(`Installer created: ${artifactPath}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error("Release build failed:", error);
    process.exitCode = 1;
  });
}
