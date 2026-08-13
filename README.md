<div align="center">

<img src="./public/assets/allsessions-icon-v2.png" alt="AllSessions icon" width="112" height="112" />

# AllSessions

<p>A local-first desktop workspace for AI coding-agent sessions.</p>

<p><a href="./README.zh-CN.md">简体中文</a> · <a href="#features">Features</a> · <a href="#development">Development</a></p>

<p>
  <img alt="Tauri" src="https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white" />
  <img alt="Rust" src="https://img.shields.io/badge/Rust-stable-000000?logo=rust&logoColor=white" />
  <img alt="License" src="https://img.shields.io/badge/License-Apache--2.0-blue.svg" />
</p>

</div>

AllSessions combines local Codex, Claude Code, and Gemini CLI history in one Tauri desktop app. Rust owns session discovery, parsing, search, caching, file watching, and maintenance. The WebView is a presentation layer: no HTTP server is opened and no Node.js runtime is bundled.

> AllSessions is an independent community project. It is not affiliated with, sponsored by, or endorsed by OpenAI, Anthropic, or Google. Product names are used only to identify compatible local data sources.

## Features

- Browse Codex, archived Codex, Claude Code, and Gemini CLI sessions together
- Filter and search by source, provider, date, project, and working directory
- Inspect normalized conversations, tool activity, and raw events
- Refresh through native filesystem watching and Tauri events
- Hide subagents, sidechains, thinking, and injected context by default
- Bound large-history memory with streaming summaries, capped search text, head/tail detail windows, and a 64 MB LRU
- Persist the incremental index in SQLite and import the previous `session-index.json` on upgrade
- Repair Codex provider visibility through an opt-in, fingerprinted, field-level rollback workflow

## Supported sources

| Source | Default path | Coverage |
| --- | --- | --- |
| Codex | `~/.codex/sessions` | Metadata, messages, tools, raw events, search, live refresh |
| Codex Archived | `~/.codex/archived_sessions` | Read-only archived sessions |
| Claude Code | `~/.claude/projects/**/*.jsonl` | Messages, thinking, tools/results, search, live refresh; legacy `sessions/*.json` fallback |
| Gemini CLI | `~/.gemini/tmp/*/logs.json` | Local session aggregation and details |

## Install and run

Download the installer for your platform from GitHub Releases. End users do not need Node.js, pnpm, Rust, or a source checkout.

| Platform | Release file |
| --- | --- |
| Windows x64 | `*-windows-x64-setup.exe` |
| macOS ARM64 / x64 | `*-mac-<arch>.dmg` |
| Debian/Ubuntu Linux x64 | `*-linux-x64.deb` |

All platforms use the same Tauri 2 shell, tray actions, and signed updater. GNOME may require an AppIndicator/KStatusNotifierItem extension. macOS builds are not notarized yet, so Gatekeeper may require explicit local approval.

## Configuration

Set these before starting the desktop app:

| Variable | Purpose | Default |
| --- | --- | --- |
| `CODEX_HOME` | Codex data root | `~/.codex` |
| `CODEX_SESSIONS_DIR` | Codex sessions | `$CODEX_HOME/sessions` |
| `CODEX_ARCHIVED_SESSIONS_DIR` | Archived Codex sessions | `$CODEX_HOME/archived_sessions` |
| `CLAUDE_SESSIONS_DIR` | Claude Code root | `~/.claude` |
| `GEMINI_SESSIONS_DIR` | Gemini CLI root | `~/.gemini` |
| `SESSION_VIEWER_CACHE_DIR` | Rust SQLite index directory | Platform cache directory under `AllSessions` |
| `SESSION_VIEWER_DISABLE_CACHE` | Set to `1` to disable persistent caching | unset |

## Privacy and security

Local agent history can contain prompts, tool output, source code, paths, and provider identifiers. Browsing is read-only. The only source-data mutation is the explicitly enabled Codex provider maintenance tool.

- Review exports, logs, screenshots, and issues before sharing.
- Treat index caches and maintenance backups as sensitive local data.
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

Source behavior lives in [`src-tauri/src/sessions.rs`](./src-tauri/src/sessions.rs); caching, the Tauri boundary, and maintenance live in `cache.rs`, `backend.rs`, and `maintenance.rs`. Read the [source architecture](./docs/source-adapters.md) before adding an agent.

## License

[Apache-2.0](./LICENSE)
