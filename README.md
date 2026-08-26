<div align="center">

<img src="./public/assets/allsessions-icon-v3.png" alt="AllSessions icon" width="112" height="112" />

# AllSessions

<p>A local-first desktop workspace for AI coding-agent sessions.</p>

<p><a href="./README.zh-CN.md">简体中文</a> · <a href="#features">Features</a> · <a href="#development">Development</a></p>

<p>
  <img alt="Tauri" src="https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white" />
  <img alt="Rust" src="https://img.shields.io/badge/Rust-stable-000000?logo=rust&logoColor=white" />
  <img alt="License" src="https://img.shields.io/badge/License-Apache--2.0-blue.svg" />
</p>

</div>

AllSessions combines local Codex, Claude Code, Gemini CLI, Pi, and Kimi Code CLI history in one Tauri desktop app. Rust owns session discovery, parsing, search, caching, file watching, and maintenance. The WebView is a presentation layer: no HTTP server is opened and no Node.js runtime is bundled.

> AllSessions is an independent community project. It is not affiliated with, sponsored by, or endorsed by the maintainers or vendors of the supported agents. Product names are used only to identify compatible local data sources.

## Features

- Browse Codex, archived Codex, Claude Code, Gemini CLI, Pi, and Kimi Code CLI sessions together
- Filter and search by source, provider, date, project, and working directory
- Inspect normalized conversations, tool activity, and raw events
- Organize sessions with favorites, tags, notes, local archive/removal state, and reusable filters
- Select loaded sessions for JSON or Markdown export, with optional path and session-ID redaction
- Reveal a session source file or project directory in the system file manager
- Refresh through native filesystem watching and Tauri events
- Inspect per-source scan health and copy sanitized diagnostics without session content or local paths
- Hide subagents, sidechains, thinking, and injected context by default
- Bound large-history memory with streaming summaries, capped search text, head/tail detail windows, and a 64 MB LRU
- Persist the incremental index in SQLite and import the previous `session-index.json` on upgrade
- Start with safe defaults when configuration is damaged, then guide the user to repair source settings
- Back up the affected local source records before a confirmed permanent deletion
- Repair Codex provider visibility through an opt-in, fingerprinted, field-level rollback workflow

## Supported sources

| Source         | Default path                    | Coverage                                                                                                                                                                                                              |
| -------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex          | `~/.codex/sessions`             | Metadata, messages, tools, raw events, search, live refresh                                                                                                                                                           |
| Codex Archived | `~/.codex/archived_sessions`    | Browse, search, and permanently delete archived sessions; files are not moved and archive state cannot be restored                                                                                                    |
| Claude Code    | `~/.claude/{projects,sessions}` | Concurrently scans modern `projects/**/*.jsonl` and legacy `sessions/*.json`; supports messages, thinking, tools/results, search, and live refresh, with `history.jsonl` enrichment for legacy details when available |
| Gemini CLI     | `~/.gemini/tmp/*/logs.json`     | Streaming scan, per-file incremental cache, session aggregation, and bounded on-demand details                                                                                                                        |
| Pi             | `~/.pi/agent/sessions`          | Rebuilds the current branch from v1-v3 JSONL trees; supports messages, thinking, tools, summaries, raw events, search, and live refresh                                                                               |
| Kimi Code CLI  | `~/.kimi/sessions`              | Reads `wire.jsonl`, maps working directories and custom titles, merges streamed content, and exposes subagents, tools, raw events, search, and live refresh                                                           |

## Install and run

Download the installer for your platform from GitHub Releases. End users do not need Node.js, pnpm, Rust, or a source checkout.

| Platform                | Release file              |
| ----------------------- | ------------------------- |
| Windows x64             | `*-windows-x64-setup.exe` |
| macOS ARM64 / x64       | `*-mac-<arch>.dmg`        |
| Debian/Ubuntu Linux x64 | `*-linux-x64.deb`         |

All platforms use the same Tauri 2 shell, tray actions, and signed updater. GNOME may require an AppIndicator/KStatusNotifierItem extension. macOS builds are not notarized yet, so Gatekeeper may require explicit local approval.

## Configuration

The toolbar **Settings** button opens a dialog for switching the UI language, editing per-source session root lists (with `~` expansion), inspecting source health, copying sanitized diagnostics, and reviewing local index and deletion-backup storage. Root lists are persisted to `AllSessions/config.json` in the user config directory (override with `ALLSESSIONS_CONFIG_PATH`) and take effect immediately; a configured source no longer reads its environment variable, and "Restore default" falls back to the env var or system default path. If the configuration file is damaged, the app starts with safe defaults and opens Source Settings so it can be replaced without manual file editing.

Set these before starting the desktop app (values are read once at startup):

| Variable                       | Purpose                                  | Default                                      |
| ------------------------------ | ---------------------------------------- | -------------------------------------------- |
| `CODEX_HOME`                   | Codex data root (single path)            | `~/.codex`                                   |
| `CODEX_SESSIONS_DIR`           | Codex session roots (path list)          | `$CODEX_HOME/sessions`                       |
| `CODEX_ARCHIVED_SESSIONS_DIR`  | Archived Codex session roots (path list) | `$CODEX_HOME/archived_sessions`              |
| `CLAUDE_SESSIONS_DIR`          | Claude Code roots (path list)            | `~/.claude`                                  |
| `GEMINI_SESSIONS_DIR`          | Gemini CLI roots (path list)             | `~/.gemini`                                  |
| `PI_SESSIONS_DIR`              | Pi session roots (path list)             | `~/.pi/agent/sessions`                       |
| `PI_CODING_AGENT_SESSION_DIR`  | Pi's official session directory          | —                                            |
| `PI_CODING_AGENT_DIR`          | Pi's official data directory             | `~/.pi/agent`                                |
| `KIMI_SESSIONS_DIR`            | Kimi Code CLI data roots (path list)     | `~/.kimi`                                    |
| `KIMI_SHARE_DIR`               | Kimi Code CLI's official data directory  | `~/.kimi`                                    |
| `SESSION_VIEWER_CACHE_DIR`     | Rust SQLite index directory              | Platform cache directory under `AllSessions` |
| `SESSION_VIEWER_DISABLE_CACHE` | Set to `1` to disable persistent caching | unset                                        |
| `ALLSESSIONS_WORKSPACE_DB`     | AllSessions user-data SQLite path        | Platform app-data directory                  |

The six `*_SESSIONS_DIR` variables accept multiple paths separated by the OS path separator (`:` on macOS/Linux, `;` on Windows), e.g. `CODEX_SESSIONS_DIR=~/.codex/sessions:~/backups/codex/sessions`. A leading `~` expands to the home directory, so lists also work when the app is launched from Finder/Dock. Pi and Kimi's official variables are used when their AllSessions-specific variable is unset. Non-existent roots are skipped. If the same session id appears in several roots of one kind, only the first-listed root is kept (a backup copy shows once). Note: the Codex provider maintenance tool only covers the primary `CODEX_HOME` session directories, not additional listed roots.

## Privacy and security

Local agent history can contain prompts, tool output, source code, paths, and provider identifiers. Browsing, search, and export do not modify source data. Explicitly confirmed permanent deletion modifies the original Codex, Claude Code, or Gemini CLI record after creating a local backup; Codex provider maintenance also modifies Codex data after it is enabled and execution is confirmed. Pi and Kimi Code CLI are read-only sources in this release: AllSessions local removal remains available, but original records can only be deleted in the source agent.

Favorites, tags, notes, reusable filters, and local archive/removal state are AllSessions user data stored separately in `workspace.sqlite`; they never modify Agent source records and are not deleted when the rebuildable index cache is cleared. Export redaction is optional and off by default. When enabled, it removes known session identifiers and common local-path patterns, but exports should still be reviewed before sharing.

- Review exports, logs, screenshots, and issues before sharing.
- Treat `workspace.sqlite`, index caches, deletion backups, and maintenance backups as sensitive local data. Backups contain original records and are not encrypted.
- Never publish real sessions, databases, credentials, or unsanitized paths.
- The app has no local listening port; UI/backend communication uses Tauri IPC and events only.

See [SECURITY.md](./SECURITY.md) for private vulnerability reporting and [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for Rust dependency licenses.

## Codex provider maintenance

Open **Tools** and enable maintenance mode to preview a third-party provider rebucket plan. Apply and rollback verify that Codex App is closed, reject stale plans, create backups before writes, and restore only `model_provider` fields so newer data remains intact. The tool does not modify `config.toml` or other agents' data.

See [Codex provider visibility repair](./docs/codex-provider-repair.md) for the full safety boundary.

## Development

Requirements: Node.js 24, pnpm 11.10, Rust stable, and the current platform's [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/). Node.js is only a frontend build/release tool and is not part of the packaged runtime.

```bash
pnpm install
pnpm desktop:dev
```

```bash
pnpm test
pnpm lint
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml
pnpm licenses:check
pnpm release:build
```

The session store and normalized contract live in [`src-tauri/src/sessions.rs`](./src-tauri/src/sessions.rs); format-specific adapters live under `src-tauri/src/sessions/`. Caching, the Tauri boundary, and maintenance live in `cache.rs`, `backend.rs`, and `maintenance.rs`. Read the [source architecture](./docs/source-adapters.md) before adding an agent.

## License

[Apache-2.0](./LICENSE)
