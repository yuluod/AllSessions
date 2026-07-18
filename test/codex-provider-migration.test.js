import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { promisify } from "node:util";

import { rollbackMigration, runMigration } from "../scripts/migrate-codex-provider-to-custom.mjs";

const execFileAsync = promisify(execFile);
const closedCodex = async () => [];
const DEFAULT_SOURCE_PROVIDERS = ["cubence_codex", "jsonl_only", "right_code"];

async function createTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "codex-provider-migration-"));
}

async function runSqlite(dbPath, sql, { json = false } = {}) {
  const args = json ? ["-batch", "-json", dbPath, sql] : ["-batch", dbPath, sql];
  const { stdout } = await execFileAsync("sqlite3", args);
  if (!json) return stdout;
  const trimmed = stdout.trim();
  return trimmed ? JSON.parse(trimmed) : [];
}

async function readSessionMetaProvider(filePath) {
  const content = await fs.readFile(filePath, "utf8");
  const line = content.split(/\r?\n/).find((item) => item.trim().startsWith("{"));
  return JSON.parse(line).payload.model_provider;
}

function providerConfig(provider, { defineProvider = true } = {}) {
  const table = defineProvider
    ? `\n[model_providers.${provider}]\nname = "${provider}"\nbase_url = "https://example.test/v1"\n`
    : "";
  return `model_provider = "${provider}"\n${table}`;
}

async function createFixture(
  rootDir,
  { externalSqliteHome = false, configProvider = "newapi", defineProvider = true } = {}
) {
  const codexHome = path.join(rootDir, "codex");
  const backupRoot = path.join(rootDir, "backups");
  const sessionsDir = path.join(codexHome, "sessions", "2026", "06", "01");
  const archivedDir = path.join(codexHome, "archived_sessions");
  const sqliteHome = externalSqliteHome ? path.join(rootDir, "sqlite-home") : codexHome;
  await fs.mkdir(sessionsDir, { recursive: true });
  await fs.mkdir(archivedDir, { recursive: true });
  await fs.mkdir(sqliteHome, { recursive: true });

  const configPath = path.join(codexHome, "config.toml");
  const sqliteHomeLine = externalSqliteHome ? `sqlite_home = "${sqliteHome}"\n` : "";
  await fs.writeFile(
    configPath,
    `${sqliteHomeLine}${providerConfig(configProvider, { defineProvider })}`,
    "utf8"
  );

  const dbPath = path.join(sqliteHome, "state_5.sqlite");
  await runSqlite(dbPath, `
    create table threads (
      id text primary key,
      model_provider text not null,
      archived integer not null default 0
    );
    insert into threads values ('active-third', 'newapi', 0);
    insert into threads values ('archived-third', 'right_code', 1);
    insert into threads values ('other-third', 'cubence_codex', 0);
    insert into threads values ('official', 'openai', 0);
    insert into threads values ('existing-custom', 'custom', 0);
    insert into threads values ('local-built-in', 'ollama', 0);
  `);

  const activeFile = path.join(sessionsDir, "active.jsonl");
  const archivedFile = path.join(archivedDir, "archived.jsonl");
  const jsonlOnlyFile = path.join(sessionsDir, "jsonl-only.jsonl");
  const customFile = path.join(sessionsDir, "custom.jsonl");
  const openaiFile = path.join(sessionsDir, "openai.jsonl");
  await fs.writeFile(
    activeFile,
    [
      JSON.stringify({ type: "session_meta", payload: { id: "active-third", model_provider: "newapi" } }),
      JSON.stringify({ type: "event_msg", payload: { message: "newapi should stay in message text" } }),
      "{bad json"
    ].join("\n"),
    "utf8"
  );
  await fs.writeFile(
    archivedFile,
    JSON.stringify({ type: "session_meta", payload: { id: "archived-third", model_provider: "right_code" } }),
    "utf8"
  );
  await fs.writeFile(
    jsonlOnlyFile,
    JSON.stringify({ type: "session_meta", payload: { id: "jsonl-only", model_provider: "jsonl_only" } }),
    "utf8"
  );
  await fs.writeFile(
    customFile,
    JSON.stringify({ type: "session_meta", payload: { id: "existing-custom", model_provider: "custom" } }),
    "utf8"
  );
  await fs.writeFile(
    openaiFile,
    JSON.stringify({ type: "session_meta", payload: { id: "official", model_provider: "openai" } }),
    "utf8"
  );

  return {
    codexHome,
    backupRoot,
    configPath,
    dbPath,
    activeFile,
    archivedFile,
    jsonlOnlyFile,
    customFile,
    openaiFile
  };
}

async function providerCounts(dbPath) {
  const rows = await runSqlite(
    dbPath,
    "select model_provider as provider, count(*) as count from threads group by model_provider order by provider;",
    { json: true }
  );
  return Object.fromEntries(rows.map((row) => [row.provider, row.count]));
}

function migrationOptions(fixture) {
  return {
    codexHome: fixture.codexHome,
    backupRoot: fixture.backupRoot,
    processChecker: closedCodex
  };
}

test("诊断只列候选，显式选择后才生成当前 provider 修复计划", async (t) => {
  const rootDir = await createTempDir();
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const fixture = await createFixture(rootDir);
  const originalConfig = await fs.readFile(fixture.configPath, "utf8");

  const discovery = await runMigration(migrationOptions(fixture));

  assert.deepEqual(discovery.providers, []);
  assert.deepEqual(discovery.candidateProviders, DEFAULT_SOURCE_PROVIDERS);
  assert.equal(discovery.selectionRequired, true);
  assert.equal(discovery.canApply, false);
  assert.ok(discovery.blockers.some((item) => item.code === "source_provider_selection_required"));
  await assert.rejects(
    runMigration({
      ...migrationOptions(fixture),
      apply: true,
      planId: discovery.planId,
      confirmedCodexClosed: true
    }),
    /Migration is blocked/
  );

  const summary = await runMigration({
    ...migrationOptions(fixture),
    providers: DEFAULT_SOURCE_PROVIDERS
  });

  assert.equal(summary.dryRun, true);
  assert.equal(summary.codexOnly, true);
  assert.equal(summary.targetProvider, "newapi");
  assert.deepEqual(summary.providers, DEFAULT_SOURCE_PROVIDERS);
  assert.deepEqual(summary.candidateProviders, DEFAULT_SOURCE_PROVIDERS);
  assert.equal(summary.selectionRequired, false);
  assert.equal(summary.threadMatches, 2);
  assert.equal(summary.jsonlFilesToChange, 2);
  assert.equal(summary.jsonlSessionMetaReplacements, 2);
  assert.equal(summary.codexConfig.status, "read_only");
  assert.equal(summary.codexConfig.modified, false);
  assert.equal(summary.canApply, true);
  assert.match(summary.planId, /^[a-f0-9]{64}$/);
  assert.equal(await fs.readFile(fixture.configPath, "utf8"), originalConfig);
  assert.equal((await providerCounts(fixture.dbPath)).newapi, 1);
  await assert.rejects(
    fs.access(path.join(fixture.backupRoot, "codex-history-provider-rebucket-v2")),
    /ENOENT/
  );
});

test("apply 只改 Codex SQLite 与 JSONL，并可完整 rollback", async (t) => {
  const rootDir = await createTempDir();
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const fixture = await createFixture(rootDir);
  const options = migrationOptions(fixture);
  const originalConfig = await fs.readFile(fixture.configPath, "utf8");
  const largeUnchangedEvent = JSON.stringify({
    type: "event_msg",
    payload: { message: `stream-preserve-${"x".repeat(2_000_000)}-end` }
  });
  await fs.appendFile(fixture.archivedFile, `\n${largeUnchangedEvent}`, "utf8");
  const originalArchived = await fs.readFile(fixture.archivedFile, "utf8");
  const preview = await runMigration({ ...options, providers: DEFAULT_SOURCE_PROVIDERS });

  const summary = await runMigration({
    ...options,
    apply: true,
    planId: preview.planId,
    providers: preview.providers,
    confirmedCodexClosed: true
  });

  assert.equal(summary.verification.ok, true);
  assert.equal(await fs.readFile(fixture.configPath, "utf8"), originalConfig);
  assert.equal((await providerCounts(fixture.dbPath)).newapi, 3);
  assert.equal((await providerCounts(fixture.dbPath)).custom, 1);
  assert.equal((await providerCounts(fixture.dbPath)).openai, 1);
  assert.equal((await providerCounts(fixture.dbPath)).ollama, 1);
  assert.equal(await readSessionMetaProvider(fixture.activeFile), "newapi");
  assert.equal(await readSessionMetaProvider(fixture.archivedFile), "newapi");
  assert.equal(await readSessionMetaProvider(fixture.jsonlOnlyFile), "newapi");
  assert.equal(await readSessionMetaProvider(fixture.customFile), "custom");
  assert.equal(await readSessionMetaProvider(fixture.openaiFile), "openai");
  assert.equal((await fs.readFile(fixture.archivedFile, "utf8")).split("\n")[1], largeUnchangedEvent);
  assert.equal((await fs.stat(summary.backupDir)).mode & 0o777, 0o700);
  const metadata = JSON.parse(await fs.readFile(path.join(summary.backupDir, "metadata.json"), "utf8"));
  assert.deepEqual(new Set(metadata.assets.map((asset) => asset.kind)), new Set(["state_db", "jsonl"]));
  assert.equal(JSON.stringify(metadata).includes("config.toml"), false);
  for (const asset of metadata.assets) {
    assert.equal((await fs.stat(path.join(summary.backupDir, asset.backup))).mode & 0o777, 0o600);
  }
  const manifestPath = path.join(summary.backupDir, metadata.manifest.backup);
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  assert.equal((await fs.stat(manifestPath)).mode & 0o777, 0o600);
  assert.deepEqual(manifest.sourceProviders, DEFAULT_SOURCE_PROVIDERS);
  assert.equal(manifest.targetProvider, "newapi");
  assert.equal(
    manifest.stateDatabases[0].threads.some((thread) =>
      thread.id === "archived-third" && thread.provider === "right_code"),
    true
  );
  assert.equal(
    manifest.jsonlFiles.some((file) =>
      file.sessions.some((session) => session.sessionId === "archived-third" && session.provider === "right_code")),
    true
  );

  const archivedRows = await runSqlite(
    fixture.dbPath,
    "select archived from threads where id = 'archived-third';",
    { json: true }
  );
  assert.equal(archivedRows[0].archived, 1);
  assert.match(await fs.readFile(fixture.activeFile, "utf8"), /newapi should stay in message text/);
  assert.match(await fs.readFile(fixture.activeFile, "utf8"), /\{bad json/);

  await rollbackMigration({
    ...options,
    backupDir: summary.backupDir,
    confirmedCodexClosed: true
  });
  const restored = await providerCounts(fixture.dbPath);
  assert.equal(restored.newapi, 1);
  assert.equal(restored.right_code, 1);
  assert.equal(restored.cubence_codex, 1);
  assert.equal(restored.custom, 1);
  assert.equal(await readSessionMetaProvider(fixture.archivedFile), "right_code");
  assert.equal(await fs.readFile(fixture.archivedFile, "utf8"), originalArchived);
  assert.equal(await readSessionMetaProvider(fixture.customFile), "custom");
  assert.equal(await fs.readFile(fixture.configPath, "utf8"), originalConfig);
});

test("apply 拒绝过期计划且不创建备份", async (t) => {
  const rootDir = await createTempDir();
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const fixture = await createFixture(rootDir);
  const options = migrationOptions(fixture);
  const preview = await runMigration({ ...options, providers: DEFAULT_SOURCE_PROVIDERS });
  await fs.appendFile(fixture.activeFile, "\n", "utf8");

  await assert.rejects(
    runMigration({
      ...options,
      apply: true,
      planId: preview.planId,
      providers: preview.providers,
      confirmedCodexClosed: true
    }),
    /Migration plan changed/
  );
  assert.equal((await providerCounts(fixture.dbPath)).newapi, 1);
});

test("Codex App 运行时拒绝写入", async (t) => {
  const rootDir = await createTempDir();
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const fixture = await createFixture(rootDir);
  const options = migrationOptions(fixture);
  const preview = await runMigration({ ...options, providers: DEFAULT_SOURCE_PROVIDERS });

  await assert.rejects(
    runMigration({
      ...options,
      apply: true,
      planId: preview.planId,
      providers: preview.providers,
      confirmedCodexClosed: true,
      processChecker: async () => ["Codex"]
    }),
    /still running/
  );
});

test("当前 provider 为内建 provider 时阻止迁移", async (t) => {
  const rootDir = await createTempDir();
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const fixture = await createFixture(rootDir, { configProvider: "openai" });

  const preview = await runMigration({ ...migrationOptions(fixture), providers: ["newapi"] });

  assert.equal(preview.canApply, false);
  assert.ok(preview.blockers.some((item) => item.code === "active_provider_builtin"));
});

test("当前 provider 为 custom 时允许作为迁移目标", async (t) => {
  const rootDir = await createTempDir();
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const fixture = await createFixture(rootDir, { configProvider: "custom" });

  const preview = await runMigration({ ...migrationOptions(fixture), providers: ["newapi"] });

  assert.equal(preview.canApply, true);
  assert.equal(preview.targetProvider, "custom");
  assert.deepEqual(preview.providers, ["newapi"]);
  assert.equal(preview.providers.includes("custom"), false);
});

test("当前 provider 没有配置表时阻止迁移", async (t) => {
  const rootDir = await createTempDir();
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const fixture = await createFixture(rootDir, { defineProvider: false });

  const preview = await runMigration(migrationOptions(fixture));

  assert.equal(preview.canApply, false);
  assert.ok(preview.blockers.some((item) => item.code === "active_provider_undefined"));
});

test("迁移中途失败会自动恢复 SQLite 与 JSONL", async (t) => {
  const rootDir = await createTempDir();
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const fixture = await createFixture(rootDir);
  const options = migrationOptions(fixture);
  const preview = await runMigration({ ...options, providers: DEFAULT_SOURCE_PROVIDERS });

  await assert.rejects(
    runMigration({
      ...options,
      apply: true,
      planId: preview.planId,
      providers: preview.providers,
      confirmedCodexClosed: true,
      faultInjector(phase) {
        if (phase === "after_state_databases") throw new Error("injected migration failure");
      }
    }),
    /injected migration failure/
  );
  assert.equal((await providerCounts(fixture.dbPath)).newapi, 1);
  assert.equal((await providerCounts(fixture.dbPath)).right_code, 1);
  assert.equal(await readSessionMetaProvider(fixture.archivedFile), "right_code");
});

test("迁移支持 config.toml 的 sqlite_home", async (t) => {
  const rootDir = await createTempDir();
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const fixture = await createFixture(rootDir, { externalSqliteHome: true });
  const options = migrationOptions(fixture);
  const preview = await runMigration({ ...options, providers: DEFAULT_SOURCE_PROVIDERS });

  assert.deepEqual(preview.stateDatabases.map((item) => item.path), [fixture.dbPath]);
  await runMigration({
    ...options,
    apply: true,
    planId: preview.planId,
    providers: preview.providers,
    confirmedCodexClosed: true
  });
  assert.equal((await providerCounts(fixture.dbPath)).newapi, 3);
});

test("rollback 拒绝越界写入目标", async (t) => {
  const rootDir = await createTempDir();
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const fixture = await createFixture(rootDir);
  const options = migrationOptions(fixture);
  const preview = await runMigration({ ...options, providers: DEFAULT_SOURCE_PROVIDERS });
  const applied = await runMigration({
    ...options,
    apply: true,
    planId: preview.planId,
    providers: preview.providers,
    confirmedCodexClosed: true
  });
  const metadataPath = path.join(applied.backupDir, "metadata.json");
  const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
  metadata.assets.find((asset) => asset.kind === "state_db").target = path.join(rootDir, "outside.sqlite");
  await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), "utf8");

  await assert.rejects(
    rollbackMigration({
      ...options,
      backupDir: applied.backupDir,
      confirmedCodexClosed: true
    }),
    /Invalid Codex state database backup target/
  );
  await assert.rejects(fs.access(path.join(rootDir, "outside.sqlite")), /ENOENT/);
});

test("显式来源不存在时阻止生成可执行计划", async (t) => {
  const rootDir = await createTempDir();
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const fixture = await createFixture(rootDir);

  const preview = await runMigration({
    ...migrationOptions(fixture),
    providers: ["missing_provider"]
  });

  assert.equal(preview.canApply, false);
  assert.equal(preview.hasChanges, false);
  assert.ok(preview.blockers.some((item) => item.code === "source_provider_not_found"));
});

test("显式来源拒绝内建 provider 与当前目标 provider", async (t) => {
  const rootDir = await createTempDir();
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const fixture = await createFixture(rootDir);

  await assert.rejects(
    runMigration({ ...migrationOptions(fixture), providers: ["openai"] }),
    /Refusing to migrate protected provider/
  );
  await assert.rejects(
    runMigration({ ...migrationOptions(fixture), providers: ["custom"] }),
    /Refusing to migrate protected provider/
  );
  await assert.rejects(
    runMigration({ ...migrationOptions(fixture), providers: ["newapi"] }),
    /Refusing to migrate protected provider/
  );
});
