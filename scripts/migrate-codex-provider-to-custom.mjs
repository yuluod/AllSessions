#!/usr/bin/env node
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fss from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MIGRATION_NAME = "codex-history-provider-rebucket-v2";
const BUILTIN_PROVIDERS = new Set([
  "amazon-bedrock",
  "azure",
  "lmstudio",
  "ollama",
  "ollama-chat",
  "openai",
  "oss"
]);
const PROTECTED_SOURCE_PROVIDERS = new Set([...BUILTIN_PROVIDERS, "custom"]);
const PROVIDER_RE = /^[a-zA-Z0-9_.:-]{1,128}$/;

export class CodexProviderRepairError extends Error {
  constructor(code, message, statusCode = 500) {
    super(message);
    this.name = "CodexProviderRepairError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function repairError(code, message, statusCode = 500) {
  return new CodexProviderRepairError(code, message, statusCode);
}

function usage() {
  return `Usage:
  node scripts/codex-provider-repair.mjs [--dry-run]
  node scripts/codex-provider-repair.mjs --apply --plan-id <sha256> --confirm-codex-closed
  node scripts/codex-provider-repair.mjs --rollback <backup-dir> --confirm-codex-closed

Options:
  --dry-run              Preview a Codex-only history rebucket plan. This is the default.
  --apply                Apply the exact plan produced by dry-run.
  --plan-id <sha256>     Plan fingerprint returned by dry-run.
  --confirm-codex-closed Confirm that Codex App is closed.
  --codex-home <path>    Codex home directory. Default: ~/.codex
  --backup-root <path>   Backup root. Default: ~/.codex/backups
  --providers <list>     Required comma-separated source provider ids for a repair plan.
  --rollback <dir>       Restore a v2 snapshot or provider fields from a v3 backup.
`;
}

function nowStamp() {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(4).toString("hex")}`;
}

function hashValue(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hashJson(value) {
  return hashValue(JSON.stringify(value));
}

function isBuiltinProvider(provider) {
  return BUILTIN_PROVIDERS.has(String(provider || "").toLowerCase());
}

function isProtectedSourceProvider(provider) {
  return PROTECTED_SOURCE_PROVIDERS.has(String(provider || "").toLowerCase());
}

function assertSafeProvider(provider) {
  if (!provider || !PROVIDER_RE.test(provider)) {
    throw repairError("invalid_provider", `Invalid provider name: ${provider}`, 400);
  }
  return provider;
}

function assertSourceProvider(provider, targetProvider = null) {
  assertSafeProvider(provider);
  if (isProtectedSourceProvider(provider) || provider === targetProvider) {
    throw repairError("protected_provider", `Refusing to migrate protected provider: ${provider}`, 400);
  }
  return provider;
}

function parseProviders(value) {
  if (!value) return null;
  return Array.from(new Set(
    value.split(",").map((provider) => provider.trim()).filter(Boolean).map(assertSafeProvider)
  )).sort();
}

function requireArgValue(argv, index, arg) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw repairError("missing_argument", `${arg} requires a value`, 400);
  }
  return value;
}

function parseArgs(argv) {
  const options = {
    apply: false,
    codexHome: path.join(os.homedir(), ".codex"),
    backupRoot: path.join(os.homedir(), ".codex", "backups"),
    providers: null,
    rollback: null,
    planId: null,
    confirmedCodexClosed: false,
    sqliteBin: "sqlite3"
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      options.apply = false;
    } else if (arg === "--apply") {
      options.apply = true;
    } else if (arg === "--confirm-codex-closed") {
      options.confirmedCodexClosed = true;
    } else if (arg === "--codex-home") {
      options.codexHome = path.resolve(requireArgValue(argv, index, arg));
      index++;
    } else if (arg === "--backup-root") {
      options.backupRoot = path.resolve(requireArgValue(argv, index, arg));
      index++;
    } else if (arg === "--providers") {
      options.providers = parseProviders(requireArgValue(argv, index, arg));
      index++;
    } else if (arg === "--plan-id") {
      options.planId = requireArgValue(argv, index, arg);
      index++;
    } else if (arg === "--rollback") {
      options.rollback = path.resolve(requireArgValue(argv, index, arg));
      index++;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw repairError("unknown_argument", `Unknown argument: ${arg}`, 400);
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

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function dotCommandPath(filePath) {
  return `'${String(filePath).replaceAll("'", "''")}'`;
}

async function runSqlite(sqliteBin, dbPath, sql, { json = false, readonly = false } = {}) {
  const args = ["-batch"];
  if (readonly) args.push("-readonly");
  if (json) args.push("-json");
  args.push(dbPath, sql);
  const { stdout } = await execFileAsync(sqliteBin, args, { maxBuffer: 1024 * 1024 * 100 });
  if (!json) return stdout;
  const trimmed = stdout.trim();
  return trimmed ? JSON.parse(trimmed) : [];
}

async function backupSqliteDatabase(sqliteBin, sourcePath, backupPath) {
  await fs.mkdir(path.dirname(backupPath), { recursive: true });
  await fs.rm(backupPath, { force: true });
  await runSqlite(sqliteBin, sourcePath, `.backup ${dotCommandPath(backupPath)}`);
  await fs.chmod(backupPath, 0o600);
}

async function restoreSqliteDatabase(sqliteBin, targetPath, backupPath) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await runSqlite(sqliteBin, targetPath, `.restore ${dotCommandPath(backupPath)}`);
}

async function readFileSnapshot(filePath) {
  try {
    const [content, stat] = await Promise.all([fs.readFile(filePath), fs.stat(filePath)]);
    return {
      exists: true,
      content,
      hash: hashValue(content),
      mode: stat.mode & 0o777
    };
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return { exists: false, content: null, hash: null, mode: null };
    }
    throw error;
  }
}

async function hashFile(filePath) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fss.createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function assertFileHash(filePath, expectedHash) {
  let actualHash;
  try {
    actualHash = await hashFile(filePath);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      throw repairError("artifact_changed", `File changed during migration: ${filePath}`, 409);
    }
    throw error;
  }
  if (actualHash !== expectedHash) {
    throw repairError("artifact_changed", `File changed during migration: ${filePath}`, 409);
  }
}

function atomicTempPath(filePath) {
  return path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.migration-${process.pid}-${crypto.randomUUID()}.tmp`
  );
}

async function atomicReplace(filePath, mode, writer) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = atomicTempPath(filePath);
  try {
    await writer(tempPath);
    await fs.chmod(tempPath, mode);
    const handle = await fs.open(tempPath, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function atomicWrite(filePath, content, mode = 0o600) {
  await atomicReplace(filePath, mode, async (tempPath) => {
    await fs.writeFile(tempPath, content, { flag: "wx", mode });
  });
}

async function atomicCopyFile(sourcePath, filePath, mode = 0o600) {
  await atomicReplace(filePath, mode, async (tempPath) => {
    await fs.copyFile(sourcePath, tempPath, fss.constants.COPYFILE_EXCL);
  });
}

function splitLinesPreservingEndings(content) {
  if (!content) return [];
  return content.match(/.*(?:\r\n|\n|$)/g).filter((line) => line.length > 0);
}

function parseStringAssignment(line, key) {
  const match = line.match(new RegExp(`^(\\s*${key}\\s*=\\s*)(["'])([^"'\\r\\n]+)\\2(\\s*(?:#.*)?(?:\\r\\n|\\n)?)$`));
  if (!match) return null;
  return { value: match[3] };
}

function parseProviderSectionHeader(line) {
  const match = line.match(/^(\s*\[\s*model_providers\s*\.\s*)(?:"([^"]+)"|'([^']+)'|([a-zA-Z0-9_:-]+))(?=\s*(?:\.|\]))/);
  return match ? (match[2] ?? match[3] ?? match[4]) : null;
}

function readTopLevelTomlString(configText, key) {
  for (const line of splitLinesPreservingEndings(configText)) {
    if (/^\s*\[/.test(line)) break;
    const assignment = parseStringAssignment(line, key);
    if (assignment) return assignment.value.trim();
  }
  return null;
}

function configDefinesProvider(configText, provider) {
  return splitLinesPreservingEndings(configText)
    .some((line) => parseProviderSectionHeader(line) === provider);
}

function resolveUserPath(rawPath) {
  if (rawPath === "~") return os.homedir();
  if (rawPath.startsWith("~/") || rawPath.startsWith("~\\")) {
    return path.join(os.homedir(), rawPath.slice(2));
  }
  return path.resolve(rawPath);
}

function stateDatabaseCandidates(codexHome, configText, env = process.env) {
  const paths = [path.join(codexHome, "state_5.sqlite")];
  const configuredHome = readTopLevelTomlString(configText, "sqlite_home");
  const selectedHome = configuredHome || env.CODEX_SQLITE_HOME || "";
  if (selectedHome) {
    const customPath = path.join(resolveUserPath(selectedHome), "state_5.sqlite");
    if (!paths.includes(customPath)) paths.push(customPath);
  }
  return paths;
}

async function listJsonlFiles(rootDir) {
  const files = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") return;
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

function sessionMetaAssignmentFromLine(line) {
  if (!line.includes('"session_meta"') || !line.includes('"model_provider"')) return null;
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }
  const payload = record?.type === "session_meta" ? record.payload : null;
  const provider = payload?.model_provider;
  if (typeof provider !== "string" || !provider) return null;
  return {
    sessionId: typeof payload.id === "string" ? payload.id : null,
    provider
  };
}

async function scanJsonlFile(filePath) {
  const stat = await fs.stat(filePath);
  const hash = crypto.createHash("sha256");
  const input = fss.createReadStream(filePath);
  input.on("data", (chunk) => hash.update(chunk));
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  const assignments = [];
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    const assignment = sessionMetaAssignmentFromLine(line);
    if (assignment) assignments.push({ ...assignment, lineNumber });
  }
  return {
    filePath,
    hash: hash.digest("hex"),
    mode: stat.mode & 0o777,
    assignments
  };
}

async function scanJsonlFiles(codexHome) {
  const roots = [path.join(codexHome, "sessions"), path.join(codexHome, "archived_sessions")];
  const files = (await Promise.all(roots.map((root) => listJsonlFiles(root)))).flat().sort();
  const snapshots = [];
  const providerCounts = new Map();
  for (const filePath of files) {
    const snapshot = await scanJsonlFile(filePath);
    for (const assignment of snapshot.assignments) {
      providerCounts.set(assignment.provider, (providerCounts.get(assignment.provider) || 0) + 1);
    }
    snapshots.push(snapshot);
  }
  return { snapshots, providerCounts };
}

async function readStateDatabasePlan(sqliteBin, dbPath) {
  if (!(await pathExists(dbPath))) return null;
  const columns = await runSqlite(sqliteBin, dbPath, "pragma table_info(threads);", { json: true, readonly: true });
  if (!columns.some((column) => column.name === "model_provider")) {
    return { dbPath, invalid: true, reason: "threads.model_provider is missing" };
  }
  const rows = await runSqlite(
    sqliteBin,
    dbPath,
    "select id, model_provider from threads order by id;",
    { json: true, readonly: true }
  );
  const providerCounts = new Map();
  for (const row of rows) {
    const provider = String(row.model_provider || "");
    if (provider) providerCounts.set(provider, (providerCounts.get(provider) || 0) + 1);
  }
  return { dbPath, invalid: false, rows, providerCounts, hash: hashJson(rows) };
}

function aggregateProviderCounts(plans) {
  const counts = new Map();
  for (const plan of plans) {
    if (!plan || plan.invalid) continue;
    for (const [provider, count] of plan.providerCounts) {
      counts.set(provider, (counts.get(provider) || 0) + count);
    }
  }
  return counts;
}

function countRowsForProviders(providerCounts, providers) {
  return providers.reduce((sum, provider) => sum + (providerCounts.get(provider) || 0), 0);
}

function mapCounts(counts) {
  return Array.from(counts, ([provider, count]) => ({ provider, count }))
    .sort((a, b) => b.count - a.count || a.provider.localeCompare(b.provider));
}

async function buildMigrationPlan(options = {}) {
  const codexHome = path.resolve(options.codexHome || path.join(os.homedir(), ".codex"));
  const backupRoot = path.resolve(options.backupRoot || path.join(codexHome, "backups"));
  const sqliteBin = options.sqliteBin || "sqlite3";
  const configPath = path.join(codexHome, "config.toml");
  const configSnapshot = await readFileSnapshot(configPath);
  const configText = configSnapshot.exists ? configSnapshot.content.toString("utf8") : "";
  const targetProvider = configSnapshot.exists ? readTopLevelTomlString(configText, "model_provider") : null;
  const blockers = [];
  const warnings = [];
  let targetProviderEligible = false;

  if (!configSnapshot.exists) {
    blockers.push({ code: "codex_config_missing", message: `Codex config not found: ${configPath}` });
  } else if (!targetProvider) {
    blockers.push({ code: "active_provider_missing", message: "Codex config has no active model_provider" });
  } else if (!PROVIDER_RE.test(targetProvider)) {
    blockers.push({ code: "active_provider_invalid", message: `Unsupported active provider id: ${targetProvider}` });
  } else if (isBuiltinProvider(targetProvider)) {
    blockers.push({
      code: "active_provider_builtin",
      message: `Refusing to move third-party history into built-in provider ${targetProvider}`
    });
  } else if (!configDefinesProvider(configText, targetProvider)) {
    blockers.push({
      code: "active_provider_undefined",
      message: `Codex config does not define [model_providers.${targetProvider}]`
    });
  } else {
    targetProviderEligible = true;
    warnings.push({
      code: "current_provider_only",
      message: `This repair restores visibility only for the active provider ${targetProvider}; switching providers may require another repair`
    });
  }

  const statePlans = [];
  for (const dbPath of stateDatabaseCandidates(codexHome, configText, options.env || process.env)) {
    const statePlan = await readStateDatabasePlan(sqliteBin, dbPath);
    if (!statePlan) continue;
    statePlans.push(statePlan);
    if (statePlan.invalid) {
      blockers.push({ code: "codex_state_schema_unsupported", message: `${dbPath}: ${statePlan.reason}` });
    }
  }
  if (statePlans.length === 0) {
    warnings.push({ code: "codex_state_db_missing", message: "No Codex state_5.sqlite database was found" });
  }

  const jsonlScan = await scanJsonlFiles(codexHome);
  const stateProviderCounts = aggregateProviderCounts(statePlans);
  const discovered = new Set([...stateProviderCounts.keys(), ...jsonlScan.providerCounts.keys()]);
  for (const provider of discovered) {
    if (!PROVIDER_RE.test(provider)) {
      blockers.push({ code: "invalid_provider_id", message: `Unsupported provider id in history: ${provider}` });
    }
  }

  const candidateProviders = targetProviderEligible
    ? Array.from(discovered)
      .filter((provider) => PROVIDER_RE.test(provider) && !isProtectedSourceProvider(provider) && provider !== targetProvider)
      .sort()
    : [];
  const hasExplicitProviderSelection = Array.isArray(options.providers);
  let providers = [];
  if (targetProviderEligible && hasExplicitProviderSelection) {
    providers = Array.from(new Set(
      options.providers.map((provider) => assertSourceProvider(provider, targetProvider))
    )).sort();
    for (const provider of providers) {
      if (!discovered.has(provider) && options.allowMissingSelectedProviders !== true) {
        blockers.push({
          code: "source_provider_not_found",
          message: `Selected source provider was not found in Codex history: ${provider}`
        });
      }
    }
    if (providers.length === 0 && candidateProviders.length > 0) {
      blockers.push({
        code: "source_provider_selection_required",
        message: "Select one or more source providers, then preview the exact repair plan"
      });
    }
  } else if (targetProviderEligible && candidateProviders.length > 0) {
    blockers.push({
      code: "source_provider_selection_required",
      message: "Select one or more source providers, then preview the exact repair plan"
    });
  }

  const jsonlChanges = [];
  if (targetProvider) {
    const providerSet = new Set(providers);
    for (const snapshot of jsonlScan.snapshots) {
      const originalAssignments = snapshot.assignments
        .filter((assignment) => providerSet.has(assignment.provider));
      if (originalAssignments.length > 0) {
        jsonlChanges.push({
          filePath: snapshot.filePath,
          originalHash: snapshot.hash,
          mode: snapshot.mode,
          replacements: originalAssignments.length,
          originalAssignments
        });
      }
    }
  }

  for (const statePlan of statePlans) {
    statePlan.threadMatches = statePlan.invalid ? 0 : countRowsForProviders(statePlan.providerCounts, providers);
  }
  const threadMatches = statePlans.reduce((sum, plan) => sum + (plan.threadMatches || 0), 0);
  const jsonlSessionMetaReplacements = jsonlChanges.reduce((sum, change) => sum + change.replacements, 0);
  const hasChanges = Boolean(threadMatches || jsonlSessionMetaReplacements);
  const planId = hashJson({
    migration: MIGRATION_NAME,
    targetProvider,
    providers,
    providerSelectionExplicit: hasExplicitProviderSelection,
    codexConfig: { path: configPath, hash: configSnapshot.hash },
    stateDatabases: statePlans.map((plan) => ({ path: plan.dbPath, hash: plan.hash || null })),
    jsonlFiles: jsonlScan.snapshots.map((snapshot) => ({ path: snapshot.filePath, hash: snapshot.hash }))
  });
  const mappingFor = (provider) => ({
    source: provider,
    target: targetProvider,
    threads: stateProviderCounts.get(provider) || 0,
    jsonl: jsonlScan.providerCounts.get(provider) || 0
  });
  const mappings = providers.map(mappingFor);
  const candidateMappings = candidateProviders.map(mappingFor);

  const summary = {
    dryRun: true,
    migration: MIGRATION_NAME,
    codexOnly: true,
    targetProvider,
    codexHome,
    backupRoot,
    providers,
    candidateProviders,
    candidateMappings,
    mappings,
    providerCounts: mapCounts(stateProviderCounts),
    threadMatches,
    stateDatabases: statePlans.map((plan) => ({ path: plan.dbPath, threadMatches: plan.threadMatches || 0 })),
    jsonlFilesScanned: jsonlScan.snapshots.length,
    jsonlFilesToChange: jsonlChanges.length,
    jsonlSessionMetaReplacements,
    codexConfig: {
      path: configPath,
      status: configSnapshot.exists ? "read_only" : "missing",
      activeProvider: targetProvider,
      modified: false
    },
    blockers,
    warnings,
    canApply: blockers.length === 0,
    hasChanges,
    selectionRequired: targetProviderEligible && candidateProviders.length > 0 && providers.length === 0,
    temporaryForCurrentProvider: true,
    planId,
    backupDir: null
  };

  return {
    summary,
    sqliteBin,
    codexHome,
    backupRoot,
    env: { CODEX_SQLITE_HOME: (options.env || process.env).CODEX_SQLITE_HOME },
    configPath,
    configHash: configSnapshot.hash,
    targetProvider,
    providers,
    statePlans,
    jsonlChanges
  };
}

async function updateStateDatabases(plan) {
  if (plan.providers.length === 0) return;
  const providerList = plan.providers.map(sqlLiteral).join(", ");
  for (const statePlan of plan.statePlans) {
    if (!statePlan.threadMatches) continue;
    const current = await readStateDatabasePlan(plan.sqliteBin, statePlan.dbPath);
    if (!current || current.invalid || current.hash !== statePlan.hash) {
      throw repairError(
        "artifact_changed",
        `State database changed during migration: ${statePlan.dbPath}`,
        409
      );
    }
    await runSqlite(
      plan.sqliteBin,
      statePlan.dbPath,
      `begin immediate;
update threads set model_provider = ${sqlLiteral(plan.targetProvider)} where model_provider in (${providerList});
commit;`
    );
  }
}

function assertPathInside(rootPath, targetPath, label) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(targetPath));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw repairError("path_outside_allowed_root", `${label} is outside the allowed directory: ${targetPath}`, 400);
  }
}

async function createBackup(plan) {
  const backupDir = path.join(plan.backupRoot, MIGRATION_NAME, nowStamp());
  await fs.mkdir(backupDir, { recursive: true, mode: 0o700 });
  await fs.chmod(backupDir, 0o700);
  const assets = [];

  for (const statePlan of plan.statePlans) {
    if (!statePlan.threadMatches) continue;
    const relativeBackup = path.join(
      "sqlite",
      `${hashValue(statePlan.dbPath).slice(0, 16)}-state_5.sqlite`
    );
    await backupSqliteDatabase(plan.sqliteBin, statePlan.dbPath, path.join(backupDir, relativeBackup));
    assets.push({
      kind: "state_db",
      target: statePlan.dbPath,
      backup: relativeBackup,
      hash: statePlan.hash
    });
  }

  for (const change of plan.jsonlChanges) {
    assertPathInside(plan.codexHome, change.filePath, "JSONL file");
    const relativeBackup = path.join("jsonl", path.relative(plan.codexHome, change.filePath));
    const backupPath = path.join(backupDir, relativeBackup);
    await fs.mkdir(path.dirname(backupPath), { recursive: true });
    await fs.copyFile(change.filePath, backupPath);
    await fs.chmod(backupPath, 0o600);
    await assertFileHash(backupPath, change.originalHash);
    assets.push({
      kind: "jsonl",
      target: change.filePath,
      backup: relativeBackup,
      hash: change.originalHash,
      mode: change.mode,
      assignments: change.originalAssignments
    });
  }

  const sourceProviderSet = new Set(plan.providers);
  const manifestPath = "provider-manifest.json";
  const manifestContent = `${JSON.stringify({
    migration: MIGRATION_NAME,
    version: 1,
    createdAt: new Date().toISOString(),
    planId: plan.summary.planId,
    targetProvider: plan.targetProvider,
    sourceProviders: plan.providers,
    stateDatabases: plan.statePlans
      .filter((statePlan) => statePlan.threadMatches > 0)
      .map((statePlan) => ({
        path: statePlan.dbPath,
        threads: statePlan.rows
          .filter((row) => sourceProviderSet.has(String(row.model_provider || "")))
          .map((row) => ({ id: row.id, provider: row.model_provider }))
      })),
    jsonlFiles: plan.jsonlChanges.map((change) => ({
      path: change.filePath,
      sessions: change.originalAssignments
    }))
  }, null, 2)}\n`;
  await fs.writeFile(path.join(backupDir, manifestPath), manifestContent, {
    encoding: "utf8",
    mode: 0o600
  });

  const metadata = {
    migration: MIGRATION_NAME,
    version: 3,
    status: "prepared",
    createdAt: new Date().toISOString(),
    codexHome: plan.codexHome,
    targetProvider: plan.targetProvider,
    providers: plan.providers,
    planId: plan.summary.planId,
    manifest: {
      backup: manifestPath,
      hash: hashValue(manifestContent)
    },
    assets
  };
  await fs.writeFile(
    path.join(backupDir, "metadata.json"),
    JSON.stringify(metadata, null, 2),
    { encoding: "utf8", mode: 0o600 }
  );
  return { backupDir, metadata };
}

async function updateBackupStatus(backupDir, metadata, status, extra = {}) {
  const nextMetadata = { ...metadata, ...extra, status, updatedAt: new Date().toISOString() };
  await atomicWrite(
    path.join(backupDir, "metadata.json"),
    `${JSON.stringify(nextMetadata, null, 2)}\n`,
    0o600
  );
  return nextMetadata;
}

async function verifyBackupAssets({ backupDir, metadata, sqliteBin }) {
  for (const asset of metadata.assets) {
    const backupPath = path.join(backupDir, asset.backup);
    if (asset.kind === "state_db") {
      const snapshot = await readStateDatabasePlan(sqliteBin, backupPath);
      if (!snapshot || snapshot.invalid || snapshot.hash !== asset.hash) {
        throw repairError(
          "backup_verification_failed",
          `State database backup verification failed: ${backupPath}`,
          409
        );
      }
      continue;
    }

    let backupHash;
    try {
      backupHash = await hashFile(backupPath);
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") {
        throw repairError(
          "backup_verification_failed",
          `JSONL backup verification failed: ${backupPath}`,
          409
        );
      }
      throw error;
    }
    if (backupHash !== asset.hash) {
      throw repairError(
        "backup_verification_failed",
        `JSONL backup verification failed: ${backupPath}`,
        409
      );
    }
  }
}

function originalProviderRows(statePlan, providers) {
  const providerSet = new Set(providers);
  return statePlan.rows.filter((row) => providerSet.has(String(row.model_provider || "")));
}

async function restoreSqliteProviderFields(sqliteBin, targetPath, backupPath, providers) {
  const [original, current] = await Promise.all([
    readStateDatabasePlan(sqliteBin, backupPath),
    readStateDatabasePlan(sqliteBin, targetPath)
  ]);
  if (!original || original.invalid || !current || current.invalid) {
    throw repairError("restore_verification_failed", `Cannot read state database for rollback: ${targetPath}`, 409);
  }

  const rows = originalProviderRows(original, providers);
  const currentIds = new Set(current.rows.map((row) => String(row.id)));
  if (rows.some((row) => !currentIds.has(String(row.id)))) {
    throw repairError("rollback_target_changed", `State database threads changed after repair: ${targetPath}`, 409);
  }
  if (rows.length === 0) return;

  const providerList = providers.map(sqlLiteral).join(", ");
  await runSqlite(
    sqliteBin,
    targetPath,
    `attach database ${sqlLiteral(backupPath)} as migration_backup;
begin immediate;
update threads
set model_provider = (
  select original.model_provider
  from migration_backup.threads as original
  where original.id = threads.id
)
where exists (
  select 1
  from migration_backup.threads as original
  where original.id = threads.id
    and original.model_provider in (${providerList})
);
commit;
detach database migration_backup;`
  );

  const restored = await readStateDatabasePlan(sqliteBin, targetPath);
  const restoredById = new Map(restored.rows.map((row) => [String(row.id), String(row.model_provider || "")]));
  if (rows.some((row) => restoredById.get(String(row.id)) !== String(row.model_provider || ""))) {
    throw repairError("restore_verification_failed", `Provider rollback verification failed: ${targetPath}`);
  }
}

async function transformJsonlFileAtomic(filePath, mode, transform, validate) {
  await atomicReplace(filePath, mode || 0o600, async (tempPath) => {
    const input = fss.createReadStream(filePath, { encoding: "utf8" });
    const handle = await fs.open(tempPath, "wx", mode || 0o600);
    let pending = "";
    let lineNumber = 0;
    try {
      for await (const chunk of input) {
        pending += chunk;
        let cursor = 0;
        let newlineIndex;
        while ((newlineIndex = pending.indexOf("\n", cursor)) >= 0) {
          lineNumber += 1;
          const segment = pending.slice(cursor, newlineIndex + 1);
          await handle.writeFile(transform(segment, lineNumber));
          cursor = newlineIndex + 1;
        }
        pending = pending.slice(cursor);
      }
      if (pending) {
        lineNumber += 1;
        await handle.writeFile(transform(pending, lineNumber));
      }
      validate?.();
      await handle.sync();
    } finally {
      await handle.close();
    }
  });
}

function restoreJsonlSegment(segment, assignment, targetProvider, filePath) {
  const newline = segment.endsWith("\r\n") ? "\r\n" : segment.endsWith("\n") ? "\n" : "";
  const line = newline ? segment.slice(0, -newline.length) : segment;
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    throw repairError("rollback_target_changed", `Session metadata changed after repair: ${filePath}`, 409);
  }
  const payload = record?.type === "session_meta" && record.payload && typeof record.payload === "object"
    ? record.payload
    : null;
  if (!payload ||
    (assignment.sessionId && payload.id !== assignment.sessionId) ||
    (payload.model_provider !== targetProvider && payload.model_provider !== assignment.provider)) {
    throw repairError("rollback_target_changed", `Session metadata changed after repair: ${filePath}`, 409);
  }
  if (payload.model_provider === assignment.provider) return segment;
  payload.model_provider = assignment.provider;
  return `${JSON.stringify(record)}${newline}`;
}

async function restoreJsonlProviderFields(asset, targetProvider) {
  const assignments = new Map(asset.assignments.map((assignment) => [assignment.lineNumber, assignment]));
  const seen = new Set();
  await transformJsonlFileAtomic(
    asset.target,
    asset.mode,
    (segment, lineNumber) => {
      const assignment = assignments.get(lineNumber);
      if (!assignment) return segment;
      seen.add(lineNumber);
      return restoreJsonlSegment(segment, assignment, targetProvider, asset.target);
    },
    () => {
      if (seen.size !== assignments.size) {
        throw repairError("rollback_target_changed", `Session metadata changed after repair: ${asset.target}`, 409);
      }
    }
  );
}

async function restoreAssets({ backupDir, metadata, sqliteBin }) {
  await verifyBackupAssets({ backupDir, metadata, sqliteBin });
  let restoredSqlite = 0;
  let restoredJsonl = 0;
  for (const asset of metadata.assets.filter((item) => item.kind === "state_db")) {
    await restoreSqliteProviderFields(
      sqliteBin,
      asset.target,
      path.join(backupDir, asset.backup),
      metadata.providers
    );
    restoredSqlite++;
  }
  for (const asset of metadata.assets.filter((item) => item.kind === "jsonl")) {
    await restoreJsonlProviderFields(asset, metadata.targetProvider);
    restoredJsonl++;
  }
  return { restoredSqlite, restoredJsonl };
}

async function restoreLegacyAssets({ backupDir, metadata, sqliteBin }) {
  await verifyBackupAssets({ backupDir, metadata, sqliteBin });
  let restoredSqlite = 0;
  let restoredJsonl = 0;
  for (const asset of metadata.assets.filter((item) => item.kind === "state_db")) {
    await restoreSqliteDatabase(sqliteBin, asset.target, path.join(backupDir, asset.backup));
    const restored = await readStateDatabasePlan(sqliteBin, asset.target);
    if (!restored || restored.invalid || restored.hash !== asset.hash) {
      throw repairError(
        "restore_verification_failed",
        `Restored state database verification failed: ${asset.target}`
      );
    }
    restoredSqlite += 1;
  }
  for (const asset of metadata.assets.filter((item) => item.kind === "jsonl")) {
    await atomicCopyFile(
      path.join(backupDir, asset.backup),
      asset.target,
      asset.mode || 0o600
    );
    await assertFileHash(asset.target, asset.hash);
    restoredJsonl += 1;
  }
  return { restoredSqlite, restoredJsonl };
}

function rewriteJsonlSegment(segment, providerSet, targetProvider) {
  const newline = segment.endsWith("\r\n") ? "\r\n" : segment.endsWith("\n") ? "\n" : "";
  const line = newline ? segment.slice(0, -newline.length) : segment;
  if (!line.includes('"session_meta"') || !line.includes('"model_provider"')) {
    return { content: segment, replacements: 0 };
  }

  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return { content: segment, replacements: 0 };
  }
  const payload = record && typeof record === "object" ? record.payload : null;
  if (
    record.type !== "session_meta" ||
    !payload ||
    typeof payload !== "object" ||
    !providerSet.has(payload.model_provider)
  ) {
    return { content: segment, replacements: 0 };
  }

  payload.model_provider = targetProvider;
  return { content: `${JSON.stringify(record)}${newline}`, replacements: 1 };
}

async function rewriteJsonlFileAtomic(change, providers, targetProvider) {
  const providerSet = new Set(providers);
  let replacements = 0;
  await transformJsonlFileAtomic(
    change.filePath,
    change.mode,
    (segment) => {
      const rewritten = rewriteJsonlSegment(segment, providerSet, targetProvider);
      replacements += rewritten.replacements;
      return rewritten.content;
    },
    () => {
      if (replacements !== change.replacements) {
        throw repairError(
          "artifact_changed",
          `JSONL replacement count changed during migration: ${change.filePath}`,
          409
        );
      }
    }
  );
}

async function applyJsonlChanges(plan) {
  await assertFileHash(plan.configPath, plan.configHash);
  for (const change of plan.jsonlChanges) {
    await assertFileHash(change.filePath, change.originalHash);
    await rewriteJsonlFileAtomic(change, plan.providers, plan.targetProvider);
  }
}

async function assertPlanArtifactsUnchanged(plan) {
  await assertFileHash(plan.configPath, plan.configHash);
  for (const statePlan of plan.statePlans) {
    const current = await readStateDatabasePlan(plan.sqliteBin, statePlan.dbPath);
    if (!current || current.invalid || current.hash !== statePlan.hash) {
      throw repairError("plan_changed", `State database changed after preview: ${statePlan.dbPath}`, 409);
    }
  }
  for (const change of plan.jsonlChanges) {
    await assertFileHash(change.filePath, change.originalHash);
  }
}

async function verifyMigration(plan) {
  const verificationPlan = await buildMigrationPlan({
    codexHome: plan.codexHome,
    backupRoot: plan.backupRoot,
    sqliteBin: plan.sqliteBin,
    env: plan.env,
    providers: plan.providers,
    allowMissingSelectedProviders: true
  });
  const ok = verificationPlan.summary.canApply && !verificationPlan.summary.hasChanges;
  return {
    ok,
    remainingThreadMatches: verificationPlan.summary.threadMatches,
    remainingJsonlReplacements: verificationPlan.summary.jsonlSessionMetaReplacements,
    blockers: verificationPlan.summary.blockers
  };
}

export async function detectRunningCodexApp() {
  if (process.platform === "win32") {
    const { stdout } = await execFileAsync("tasklist", ["/fo", "csv", "/nh"]);
    return stdout.toLowerCase().includes("codex.exe") ? ["Codex"] : [];
  }
  const { stdout } = await execFileAsync("ps", ["-axo", "comm="]);
  const running = stdout
    .split(/\r?\n/)
    .map((line) => path.basename(line.trim()).toLowerCase())
    .some((line) => line === "codex" || line.startsWith("codex helper"));
  return running ? ["Codex"] : [];
}

async function assertCodexClosed(options) {
  if (options.confirmedCodexClosed !== true) {
    throw repairError("codex_closed_confirmation_required", "Codex App closed confirmation is required", 400);
  }
  const processChecker = options.processChecker || detectRunningCodexApp;
  const runningApps = await processChecker();
  if (runningApps.length > 0) {
    throw repairError("codex_app_running", `Codex App is still running: ${runningApps.join(", ")}`, 409);
  }
}

export async function runMigration(options = {}) {
  const apply = options.apply === true;
  const plan = await buildMigrationPlan(options);
  if (!apply) return plan.summary;

  await assertCodexClosed(options);
  if (!options.planId || !/^[a-f0-9]{64}$/i.test(options.planId)) {
    throw repairError("invalid_plan_id", "A valid migration plan id is required", 400);
  }
  if (options.planId !== plan.summary.planId) {
    throw repairError(
      "plan_changed",
      "Migration plan changed; preview again after Codex App is closed",
      409
    );
  }
  if (!plan.summary.canApply) {
    throw repairError(
      "migration_blocked",
      `Migration is blocked: ${plan.summary.blockers.map((item) => item.message).join("; ")}`,
      409
    );
  }
  if (!plan.summary.hasChanges) {
    return {
      ...plan.summary,
      dryRun: false,
      verification: { ok: true, remainingThreadMatches: 0, remainingJsonlReplacements: 0, blockers: [] }
    };
  }

  await assertPlanArtifactsUnchanged(plan);
  const { backupDir, metadata } = await createBackup(plan);
  const faultInjector = typeof options.faultInjector === "function" ? options.faultInjector : () => {};
  try {
    await updateStateDatabases(plan);
    faultInjector("after_state_databases");
    await applyJsonlChanges(plan);
    faultInjector("after_jsonl_files");
    const verification = await verifyMigration(plan);
    if (!verification.ok) {
      throw repairError("migration_verification_failed", "Migration verification failed");
    }
    await updateBackupStatus(backupDir, metadata, "completed", { completedAt: new Date().toISOString() });
    return { ...plan.summary, dryRun: false, backupDir, verification };
  } catch (error) {
    try {
      await restoreAssets({ backupDir, metadata, sqliteBin: plan.sqliteBin });
      await updateBackupStatus(backupDir, metadata, "auto_rolled_back", {
        failedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error)
      });
    } catch (rollbackError) {
      throw repairError(
        "automatic_rollback_failed",
        `${error instanceof Error ? error.message : String(error)}; automatic rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
      );
    }
    throw error;
  }
}

async function readValidatedBackup(options) {
  if (!options.backupDir) throw repairError("backup_required", "rollback requires backupDir", 400);
  const backupDir = path.resolve(options.backupDir);
  const codexHome = path.resolve(options.codexHome || path.join(os.homedir(), ".codex"));
  const backupRoot = path.resolve(options.backupRoot || path.join(codexHome, "backups"));
  assertPathInside(path.join(backupRoot, MIGRATION_NAME), backupDir, "Backup directory");
  const metadata = JSON.parse(await fs.readFile(path.join(backupDir, "metadata.json"), "utf8"));
  if (metadata.migration !== MIGRATION_NAME ||
    ![2, 3].includes(metadata.version) ||
    !Array.isArray(metadata.assets)) {
    throw repairError("invalid_backup", "Unsupported or invalid migration backup", 409);
  }
  if (typeof metadata.targetProvider !== "string" ||
    !PROVIDER_RE.test(metadata.targetProvider) ||
    !Array.isArray(metadata.providers) ||
    metadata.providers.length === 0 ||
    metadata.providers.some((provider) =>
      typeof provider !== "string" ||
      !PROVIDER_RE.test(provider) ||
      isProtectedSourceProvider(provider) ||
      provider === metadata.targetProvider
    )) {
    throw repairError("invalid_backup", "Invalid provider mapping in migration backup", 409);
  }
  const sourceProviders = new Set(metadata.providers);
  if (path.resolve(metadata.codexHome) !== codexHome) {
    throw repairError("backup_target_mismatch", "Backup target does not match the configured Codex home", 409);
  }
  if (metadata.manifest) {
    if (typeof metadata.manifest.backup !== "string" || path.isAbsolute(metadata.manifest.backup)) {
      throw repairError("invalid_backup", "Invalid provider manifest path", 409);
    }
    const manifestFile = path.join(backupDir, metadata.manifest.backup);
    assertPathInside(backupDir, manifestFile, "Provider manifest");
    await assertFileHash(manifestFile, metadata.manifest.hash);
  }

  const configSnapshot = await readFileSnapshot(path.join(codexHome, "config.toml"));
  const configText = configSnapshot.exists ? configSnapshot.content.toString("utf8") : "";
  const allowedStateDatabases = new Set(
    stateDatabaseCandidates(codexHome, configText, options.env || process.env).map((item) => path.resolve(item))
  );
  for (const asset of metadata.assets) {
    if (!asset || typeof asset.target !== "string" || typeof asset.backup !== "string") {
      throw repairError("invalid_backup", "Invalid migration backup asset", 409);
    }
    if (path.isAbsolute(asset.backup)) {
      throw repairError("invalid_backup", "Invalid absolute backup asset path", 409);
    }
    assertPathInside(backupDir, path.join(backupDir, asset.backup), "Backup asset");
    if (asset.kind === "state_db") {
      if (!allowedStateDatabases.has(path.resolve(asset.target))) {
        throw repairError("invalid_backup", "Invalid Codex state database backup target", 409);
      }
    } else if (asset.kind === "jsonl") {
      const target = path.resolve(asset.target);
      const inSessions = target.startsWith(`${path.join(codexHome, "sessions")}${path.sep}`);
      const inArchived = target.startsWith(`${path.join(codexHome, "archived_sessions")}${path.sep}`);
      if ((!inSessions && !inArchived) || !target.endsWith(".jsonl")) {
        throw repairError("invalid_backup", "Invalid Codex JSONL backup target", 409);
      }
      if (metadata.version === 3 && (!Array.isArray(asset.assignments) || asset.assignments.length === 0)) {
        throw repairError("invalid_backup", "Missing JSONL provider assignments in migration backup", 409);
      }
      if (metadata.version === 2) continue;
      const lineNumbers = new Set();
      for (const assignment of asset.assignments) {
        if (!assignment ||
          !Number.isInteger(assignment.lineNumber) ||
          assignment.lineNumber < 1 ||
          !sourceProviders.has(assignment.provider) ||
          (assignment.sessionId !== null && typeof assignment.sessionId !== "string") ||
          lineNumbers.has(assignment.lineNumber)) {
          throw repairError("invalid_backup", "Invalid JSONL provider assignment in migration backup", 409);
        }
        lineNumbers.add(assignment.lineNumber);
      }
    } else {
      throw repairError("invalid_backup", "Unsupported migration backup asset", 409);
    }
  }
  return { backupDir, codexHome, metadata };
}

export async function rollbackMigration(options = {}) {
  await assertCodexClosed(options);
  const backup = await readValidatedBackup(options);
  const restore = backup.metadata.version === 2 ? restoreLegacyAssets : restoreAssets;
  const result = await restore({
    backupDir: backup.backupDir,
    metadata: backup.metadata,
    sqliteBin: options.sqliteBin || "sqlite3"
  });
  await updateBackupStatus(backup.backupDir, backup.metadata, "rolled_back", {
    rolledBackAt: new Date().toISOString()
  });
  return { backupDir: backup.backupDir, codexHome: backup.codexHome, ...result };
}

function formatSummary(summary) {
  return [
    `Mode: ${summary.dryRun ? "dry-run" : "apply"}`,
    `Codex home: ${summary.codexHome}`,
    `Active target provider: ${summary.targetProvider || "(none)"}`,
    `Source providers: ${summary.providers.join(", ") || "(none)"}`,
    `Matching sqlite threads: ${summary.threadMatches}`,
    `JSONL files scanned: ${summary.jsonlFilesScanned}`,
    `JSONL files to change: ${summary.jsonlFilesToChange}`,
    `Plan id: ${summary.planId}`,
    summary.blockers.length ? `Blockers: ${summary.blockers.map((item) => item.message).join("; ")}` : null,
    summary.backupDir ? `Backup: ${summary.backupDir}` : null
  ].filter(Boolean).join("\n");
}

export async function runCli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return;
  }
  if (options.rollback) {
    const result = await rollbackMigration({ ...options, backupDir: options.rollback });
    console.log(`Rollback restored sqlite files: ${result.restoredSqlite}`);
    console.log(`Rollback restored JSONL files: ${result.restoredJsonl}`);
    return;
  }
  const summary = await runMigration(options);
  console.log(formatSummary(summary));
  if (summary.dryRun) {
    console.log("No files were changed. Close Codex App, preview again, then apply this exact plan id.");
  }
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
