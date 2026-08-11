# Codex Provider Visibility Repair

[中文说明](./codex-provider-repair.zh-CN.md)

AllSessions includes an optional maintenance tool for Codex histories that became invisible after switching third-party model providers. This workflow changes Codex provider metadata; it is separate from normal read-only session browsing.

## Safety boundary

- Maintenance mode is disabled by default; while disabled, the repair endpoints reject preview, apply, and rollback requests.
- The repair only targets explicitly selected Codex provider metadata in supported SQLite databases and JSONL session files.
- It reads the active provider from `config.toml` but does not modify that file.
- Built-in and protected providers are rejected as migration sources.
- Apply and rollback require confirmation that Codex App is closed and also check for a running Codex process.
- Preview fingerprints the exact plan; changed files or databases invalidate it.
- Backups may contain sensitive session metadata and must not be published.

## Browser workflow

Start AllSessions normally:

```bash
pnpm start
```

Open `http://127.0.0.1:3210`, select **Tools**, and use the Provider repair card:

1. Enable the maintenance-mode switch.
2. Run the read-only preview.
3. Review detected candidate providers and blockers.
4. Explicitly select the historical providers to repair.
5. Generate the exact plan and review the affected counts.
6. Quit Codex App and confirm that it is closed.
7. Apply the plan, then disable maintenance mode when finished.

The local page uses a per-process mutation token and same-origin checks. Restarting the server invalidates the previous token and preview workflow.

## CLI workflow

### 1. Discover candidates

```bash
pnpm codex:provider-repair -- --dry-run
```

Discovery does not select providers automatically and cannot be applied as-is.

### 2. Preview an explicit selection

```bash
pnpm codex:provider-repair -- --dry-run \
  --providers legacy_provider_a,legacy_provider_b
```

Review the blockers, affected SQLite thread count, JSONL replacement count, target provider, and returned `Plan id`.

### 3. Apply the exact plan

Quit Codex App, then use the same provider selection and the returned plan fingerprint:

```bash
pnpm codex:provider-repair -- --apply \
  --providers legacy_provider_a,legacy_provider_b \
  --plan-id <preview-plan-id> \
  --confirm-codex-closed
```

If the configuration, a state database, or a target JSONL file changed after preview, apply stops and requires a new preview.

## Backups and rollback

Backups are stored under:

```text
~/.codex/backups/codex-history-provider-rebucket-v2/
```

The directory name contains `v2` for compatibility with backups created by earlier releases; current backup metadata uses version 3.

Before any write, the tool backs up affected state databases and JSONL files and records original assignments in `provider-manifest.json`. Failures during apply trigger automatic rollback.

To roll back manually, quit Codex App and run:

```bash
pnpm codex:provider-repair -- \
  --rollback /path/to/backup-dir \
  --confirm-codex-closed
```

Rollback verifies all backup assets before writing:

- Version 3 backups restore only the affected `model_provider` fields, preserving later threads, archive-state changes, and appended JSONL messages.
- Existing version 2 backups retain their original full SQLite and JSONL snapshot restore behavior.

## What the repair does not do

- It does not merge all providers permanently.
- It does not change future provider switching behavior.
- It does not modify third-party tool data.
- It does not unarchive Codex sessions or reveal subagent sessions in Codex App.
- It does not make history visible under every provider; another repair may be needed after switching providers again.

Treat the generated preview and backup path as local operational data. Redact provider identifiers, home-directory paths, and session artifacts before sharing diagnostics.
