import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { promisify } from "node:util";

import { rollbackMigration, runMigration } from "../scripts/migrate-codex-provider-to-custom.mjs";

const execFileAsync = promisify(execFile);

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
  const record = JSON.parse(line);
  return record.payload.model_provider;
}

async function createFixture(rootDir) {
  const codexHome = path.join(rootDir, "codex");
  const backupRoot = path.join(rootDir, "backups");
  const sessionsDir = path.join(codexHome, "sessions", "2026", "06", "01");
  const archivedDir = path.join(codexHome, "archived_sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  await fs.mkdir(archivedDir, { recursive: true });

  const dbPath = path.join(codexHome, "state_5.sqlite");
  await runSqlite(dbPath, `
    create table threads (
      id text primary key,
      model_provider text not null,
      archived integer not null default 0
    );
    insert into threads (id, model_provider, archived) values ('active-third', 'newapi', 0);
    insert into threads (id, model_provider, archived) values ('archived-third', 'right_code', 1);
    insert into threads (id, model_provider, archived) values ('other-third', 'cubence_codex', 0);
    insert into threads (id, model_provider, archived) values ('official', 'openai', 0);
    insert into threads (id, model_provider, archived) values ('existing-custom', 'custom', 0);
  `);

  const activeFile = path.join(sessionsDir, "active.jsonl");
  const archivedFile = path.join(archivedDir, "archived.jsonl");
  const openaiFile = path.join(sessionsDir, "openai.jsonl");

  await fs.writeFile(
    activeFile,
    [
      JSON.stringify({
        timestamp: "2026-06-01T10:00:00.000Z",
        type: "session_meta",
        payload: { id: "active-third", model_provider: "newapi", cwd: "/tmp/a" }
      }),
      JSON.stringify({
        timestamp: "2026-06-01T10:00:01.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "newapi should stay in message text" }
      }),
      "{bad json"
    ].join("\n"),
    "utf8"
  );

  await fs.writeFile(
    archivedFile,
    JSON.stringify({
      timestamp: "2026-06-01T09:00:00.000Z",
      type: "session_meta",
      payload: { id: "archived-third", model_provider: "right_code", cwd: "/tmp/b" }
    }),
    "utf8"
  );

  await fs.writeFile(
    openaiFile,
    JSON.stringify({
      timestamp: "2026-06-01T08:00:00.000Z",
      type: "session_meta",
      payload: { id: "official", model_provider: "openai", cwd: "/tmp/c" }
    }),
    "utf8"
  );

  return { codexHome, backupRoot, dbPath, activeFile, archivedFile, openaiFile };
}

async function providerCounts(dbPath) {
  const rows = await runSqlite(
    dbPath,
    "select model_provider as provider, count(*) as count from threads group by model_provider order by provider;",
    { json: true }
  );
  return Object.fromEntries(rows.map((row) => [row.provider, row.count]));
}

test("provider 迁移 dry-run 只统计不写入", async (t) => {
  const rootDir = await createTempDir();
  t.after(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });
  const { codexHome, backupRoot, dbPath, activeFile, archivedFile } = await createFixture(rootDir);

  const summary = await runMigration({ codexHome, backupRoot });

  assert.equal(summary.dryRun, true);
  assert.deepEqual(summary.providers, ["cubence_codex", "newapi", "right_code"]);
  assert.equal(summary.threadMatches, 3);
  assert.equal(summary.jsonlFilesToChange, 2);
  assert.equal(summary.jsonlSessionMetaReplacements, 2);
  assert.equal((await providerCounts(dbPath)).newapi, 1);
  assert.equal(await readSessionMetaProvider(activeFile), "newapi");
  assert.equal(await readSessionMetaProvider(archivedFile), "right_code");

  await assert.rejects(
    fs.access(path.join(backupRoot, "codex-history-provider-migration-v1")),
    /ENOENT/
  );
});

test("provider 迁移 apply 后可 rollback，且不改变 archived 状态", async (t) => {
  const rootDir = await createTempDir();
  t.after(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });
  const { codexHome, backupRoot, dbPath, activeFile, archivedFile, openaiFile } = await createFixture(rootDir);

  const summary = await runMigration({ codexHome, backupRoot, apply: true });

  assert.equal(summary.dryRun, false);
  assert.ok(summary.backupDir);
  assert.equal((await providerCounts(dbPath)).custom, 4);
  assert.equal((await providerCounts(dbPath)).openai, 1);
  assert.equal(await readSessionMetaProvider(activeFile), "custom");
  assert.equal(await readSessionMetaProvider(archivedFile), "custom");
  assert.equal(await readSessionMetaProvider(openaiFile), "openai");

  const archivedRows = await runSqlite(
    dbPath,
    "select archived from threads where id = 'archived-third';",
    { json: true }
  );
  assert.equal(archivedRows[0].archived, 1);

  const activeContent = await fs.readFile(activeFile, "utf8");
  assert.match(activeContent, /newapi should stay in message text/);
  assert.match(activeContent, /\{bad json/);

  await rollbackMigration({ backupDir: summary.backupDir });

  const restoredCounts = await providerCounts(dbPath);
  assert.equal(restoredCounts.newapi, 1);
  assert.equal(restoredCounts.right_code, 1);
  assert.equal(restoredCounts.cubence_codex, 1);
  assert.equal(restoredCounts.custom, 1);
  assert.equal(restoredCounts.openai, 1);
  assert.equal(await readSessionMetaProvider(activeFile), "newapi");
  assert.equal(await readSessionMetaProvider(archivedFile), "right_code");
});

test("provider 迁移拒绝显式迁移保留 provider", async (t) => {
  const rootDir = await createTempDir();
  t.after(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });
  const { codexHome, backupRoot } = await createFixture(rootDir);

  await assert.rejects(
    runMigration({ codexHome, backupRoot, providers: ["openai"] }),
    /Refusing to migrate preserved provider/
  );
});
