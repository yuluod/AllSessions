#!/usr/bin/env node
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MIGRATION_NAME = "codex-history-provider-migration-v1";
const TARGET_PROVIDER = "custom";
const PRESERVED_PROVIDERS = new Set(["openai", TARGET_PROVIDER]);
const PROVIDER_RE = /^[a-zA-Z0-9_.:-]+$/;

function usage() {
  return `Usage:
  node scripts/migrate-codex-provider-to-custom.mjs [--dry-run]
  node scripts/migrate-codex-provider-to-custom.mjs --apply [--codex-home <path>] [--backup-root <path>] [--providers a,b,c]
  node scripts/migrate-codex-provider-to-custom.mjs --rollback <backup-dir> [--codex-home <path>]

Options:
  --dry-run              Preview changes only. This is the default.
  --apply                Write sqlite/jsonl changes after creating a backup.
  --codex-home <path>    Codex home directory. Default: ~/.codex
  --backup-root <path>   Backup root. Default: ~/.cc-switch/backups
  --providers <list>     Comma-separated provider names to migrate.
  --rollback <dir>       Restore sqlite/jsonl files from a migration backup.
`;
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function assertSafeProvider(provider) {
  if (!provider || !PROVIDER_RE.test(provider)) {
    throw new Error(`Invalid provider name: ${provider}`);
  }
  return provider;
}

function assertMigratableProvider(provider) {
  assertSafeProvider(provider);
  if (PRESERVED_PROVIDERS.has(provider)) {
    throw new Error(`Refusing to migrate preserved provider: ${provider}`);
  }
  return provider;
}

function sqlString(value) {
  assertSafeProvider(value);
  return `'${value}'`;
}

function parseProviders(value) {
  if (!value) return null;
  const providers = value
    .split(",")
    .map((provider) => provider.trim())
    .filter(Boolean)
    .map(assertMigratableProvider);
  return Array.from(new Set(providers)).sort();
}

function parseArgs(argv) {
  const options = {
    apply: false,
    codexHome: path.join(os.homedir(), ".codex"),
    backupRoot: path.join(os.homedir(), ".cc-switch", "backups"),
    providers: null,
    rollback: null,
    sqliteBin: "sqlite3"
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      options.apply = false;
    } else if (arg === "--apply") {
      options.apply = true;
    } else if (arg === "--codex-home") {
      options.codexHome = path.resolve(argv[++index] || "");
    } else if (arg === "--backup-root") {
      options.backupRoot = path.resolve(argv[++index] || "");
    } else if (arg === "--providers") {
      options.providers = parseProviders(argv[++index] || "");
    } else if (arg === "--rollback") {
      options.rollback = path.resolve(argv[++index] || "");
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function copyIfExists(source, target) {
  if (!(await pathExists(source))) return false;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(source, target);
  return true;
}

async function runSqlite(sqliteBin, dbPath, sql, { json = false } = {}) {
  const args = json ? ["-batch", "-json", dbPath, sql] : ["-batch", dbPath, sql];
  const { stdout } = await execFileAsync(sqliteBin, args, { maxBuffer: 1024 * 1024 * 20 });
  if (!json) return stdout;
  const trimmed = stdout.trim();
  return trimmed ? JSON.parse(trimmed) : [];
}

async function readProviderCounts({ sqliteBin = "sqlite3", dbPath }) {
  const rows = await runSqlite(
    sqliteBin,
    dbPath,
    "select model_provider as provider, count(*) as count from threads group by model_provider order by count(*) desc, model_provider asc;",
    { json: true }
  );
  return rows.map((row) => ({
    provider: String(row.provider || ""),
    count: Number(row.count || 0)
  }));
}

function defaultProvidersFromCounts(providerCounts) {
  return providerCounts
    .map((row) => row.provider)
    .filter((provider) => provider && !PRESERVED_PROVIDERS.has(provider))
    .map(assertSafeProvider)
    .sort();
}

async function listJsonlFiles(rootDir) {
  const files = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") {
        return;
      }
      throw error;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && fullPath.endsWith(".jsonl")) {
        files.push(fullPath);
      }
    }
  }

  await walk(rootDir);
  return files.sort();
}

function rewriteJsonlContent(content, providers) {
  const providerSet = new Set(providers);
  const lines = content.split(/\r?\n/);
  let replacements = 0;

  const nextLines = lines.map((line) => {
    if (!line.trim()) return line;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      return line;
    }

    const payload = record && typeof record === "object" ? record.payload : null;
    if (
      record.type === "session_meta" &&
      payload &&
      typeof payload === "object" &&
      providerSet.has(payload.model_provider)
    ) {
      payload.model_provider = TARGET_PROVIDER;
      replacements++;
      return JSON.stringify(record);
    }

    return line;
  });

  return {
    content: nextLines.join("\n"),
    replacements
  };
}

async function planJsonlChanges(codexHome, providers) {
  const roots = [
    path.join(codexHome, "sessions"),
    path.join(codexHome, "archived_sessions")
  ];
  const files = (await Promise.all(roots.map((root) => listJsonlFiles(root)))).flat();
  const changes = [];

  for (const filePath of files) {
    const content = await fs.readFile(filePath, "utf8");
    const result = rewriteJsonlContent(content, providers);
    if (result.replacements > 0) {
      changes.push({ filePath, replacements: result.replacements });
    }
  }

  return { scanned: files.length, changes };
}

async function backupStateFiles(codexHome, backupDir) {
  const sqliteDir = path.join(backupDir, "sqlite");
  const copied = [];
  for (const name of ["state_5.sqlite", "state_5.sqlite-shm", "state_5.sqlite-wal"]) {
    const source = path.join(codexHome, name);
    const target = path.join(sqliteDir, name);
    if (await copyIfExists(source, target)) {
      copied.push(name);
    }
  }
  return copied;
}

async function backupJsonlFile(codexHome, backupDir, filePath) {
  const relative = path.relative(codexHome, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to backup file outside codex home: ${filePath}`);
  }
  const target = path.join(backupDir, "jsonl", relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(filePath, target);
}

async function writeJsonlChange(filePath, providers) {
  const content = await fs.readFile(filePath, "utf8");
  const result = rewriteJsonlContent(content, providers);
  if (result.replacements === 0) return 0;
  const tempPath = `${filePath}.provider-migration-${Date.now()}.tmp`;
  await fs.writeFile(tempPath, result.content, "utf8");
  await fs.rename(tempPath, filePath);
  return result.replacements;
}

async function writeBackupMetadata(backupDir, metadata) {
  await fs.writeFile(
    path.join(backupDir, "metadata.json"),
    JSON.stringify(metadata, null, 2),
    "utf8"
  );
}

async function updateSqliteProviders({ sqliteBin, dbPath, providers }) {
  if (providers.length === 0) return;
  const providerList = providers.map(sqlString).join(", ");
  await runSqlite(
    sqliteBin,
    dbPath,
    `begin immediate;
update threads set model_provider = '${TARGET_PROVIDER}' where model_provider in (${providerList});
commit;`
  );
}

export async function runMigration(options = {}) {
  const codexHome = path.resolve(options.codexHome || path.join(os.homedir(), ".codex"));
  const backupRoot = path.resolve(options.backupRoot || path.join(os.homedir(), ".cc-switch", "backups"));
  const sqliteBin = options.sqliteBin || "sqlite3";
  const dbPath = path.join(codexHome, "state_5.sqlite");
  const apply = options.apply === true;

  const providerCounts = await readProviderCounts({ sqliteBin, dbPath });
  const providers = options.providers
    ? options.providers.map(assertMigratableProvider).sort()
    : defaultProvidersFromCounts(providerCounts);
  const targetProviderSet = new Set(providers);
  const threadMatches = providerCounts
    .filter((row) => targetProviderSet.has(row.provider))
    .reduce((sum, row) => sum + row.count, 0);
  const jsonlPlan = await planJsonlChanges(codexHome, providers);

  const summary = {
    dryRun: !apply,
    codexHome,
    providers,
    providerCounts,
    threadMatches,
    jsonlFilesScanned: jsonlPlan.scanned,
    jsonlFilesToChange: jsonlPlan.changes.length,
    jsonlSessionMetaReplacements: jsonlPlan.changes.reduce((sum, change) => sum + change.replacements, 0),
    backupDir: null
  };

  if (!apply) {
    return summary;
  }

  const backupDir = path.join(backupRoot, MIGRATION_NAME, nowStamp());
  summary.backupDir = backupDir;
  await fs.mkdir(backupDir, { recursive: true });
  const sqliteBackups = await backupStateFiles(codexHome, backupDir);
  for (const change of jsonlPlan.changes) {
    await backupJsonlFile(codexHome, backupDir, change.filePath);
  }
  await writeBackupMetadata(backupDir, {
    migration: MIGRATION_NAME,
    codexHome,
    createdAt: new Date().toISOString(),
    providers,
    sqliteBackups,
    jsonlBackups: jsonlPlan.changes.map((change) => path.relative(codexHome, change.filePath))
  });

  await updateSqliteProviders({ sqliteBin, dbPath, providers });
  for (const change of jsonlPlan.changes) {
    await writeJsonlChange(change.filePath, providers);
  }

  return summary;
}

async function copyTree(sourceDir, targetDir) {
  if (!(await pathExists(sourceDir))) return 0;
  let count = 0;
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const source = path.join(dir, entry.name);
      const relative = path.relative(sourceDir, source);
      const target = path.join(targetDir, relative);
      if (entry.isDirectory()) {
        await walk(source);
      } else if (entry.isFile()) {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(source, target);
        count++;
      }
    }
  }
  await walk(sourceDir);
  return count;
}

export async function rollbackMigration(options = {}) {
  if (!options.backupDir) {
    throw new Error("rollback requires backupDir");
  }
  const backupDir = path.resolve(options.backupDir);
  const metadataPath = path.join(backupDir, "metadata.json");
  let metadata = {};
  if (await pathExists(metadataPath)) {
    metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
  }
  const codexHome = path.resolve(options.codexHome || metadata.codexHome || path.join(os.homedir(), ".codex"));

  const restoredSqlite = await copyTree(path.join(backupDir, "sqlite"), codexHome);
  const restoredJsonl = await copyTree(path.join(backupDir, "jsonl"), codexHome);

  return {
    backupDir,
    codexHome,
    restoredSqlite,
    restoredJsonl
  };
}

function formatSummary(summary) {
  return [
    `Mode: ${summary.dryRun ? "dry-run" : "apply"}`,
    `Codex home: ${summary.codexHome}`,
    `Providers to migrate: ${summary.providers.join(", ") || "(none)"}`,
    `Matching sqlite threads: ${summary.threadMatches}`,
    `JSONL files scanned: ${summary.jsonlFilesScanned}`,
    `JSONL files to change: ${summary.jsonlFilesToChange}`,
    `JSONL session_meta replacements: ${summary.jsonlSessionMetaReplacements}`,
    summary.backupDir ? `Backup: ${summary.backupDir}` : null
  ].filter(Boolean).join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (options.rollback) {
    const result = await rollbackMigration({ backupDir: options.rollback, codexHome: options.codexHome });
    console.log(`Rollback restored sqlite files: ${result.restoredSqlite}`);
    console.log(`Rollback restored JSONL files: ${result.restoredJsonl}`);
    return;
  }

  const summary = await runMigration(options);
  console.log(formatSummary(summary));
  if (summary.dryRun) {
    console.log("No files were changed. Re-run with --apply after quitting Codex App.");
  }
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
