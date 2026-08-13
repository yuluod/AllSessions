# Codex provider visibility repair

[简体中文](./codex-provider-repair.zh-CN.md)

AllSessions includes an optional Rust maintenance tool for Codex history that became invisible after switching third-party providers. It is isolated from normal read-only browsing.

## Safety boundary

- Maintenance is off by default; preview, apply, and rollback are rejected while disabled.
- Only explicitly selected third-party providers are changed, and only `model_provider` fields in supported SQLite/JSONL data.
- `config.toml` is read to identify the active provider and is never modified.
- Built-in providers, `custom`, and the current target cannot be sources.
- Apply and rollback require confirmation that Codex App is closed and also inspect running processes.
- The preview fingerprint covers config, database provider rows, and JSONL files; stale plans are rejected.
- SQLite's Backup API and file copies are created before writes. Failures trigger field-level automatic rollback.
- Manual rollback restores provider fields only, preserving later threads, archive changes, and appended messages.
- Current v4 backups and v0.0.8 v3 field-level backups are supported.

## Workflow

1. Start AllSessions and open **Tools**.
2. Enable maintenance mode.
3. Run a read-only preview and inspect candidates and blockers.
4. Select source providers explicitly and generate the exact plan again.
5. Review affected thread, file, and replacement counts.
6. Fully quit Codex App and confirm.
7. Apply the plan; use the displayed backup directory if rollback is needed.
8. Disable maintenance mode when finished.

The UI uses Tauri IPC. There is no HTTP mutation endpoint or browser token. The maintenance toggle is process-local and resets to off after restart.

Backups are stored under `~/.codex/backups/codex-history-provider-rebucket-v2/`. The `v2` directory name remains for path compatibility; current metadata is v4. Treat backups and displayed paths as sensitive local operations data.
