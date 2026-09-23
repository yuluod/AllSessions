<div align="center">

<img src="./public/assets/allsessions-icon-v3.png" alt="AllSessions icon" width="112" height="112" />

# AllSessions

**A local-first desktop workspace for AI coding-agent sessions**

Browse, search, organize, and manage local sessions from multiple AI coding agents in one place.

<p>
  <a href="./README.zh-CN.md">简体中文</a>
  ·
  <a href="#features">Features</a>
  ·
  <a href="#supported-sources">Supported sources</a>
  ·
  <a href="#install-and-run">Install</a>
  ·
  <a href="#development">Development</a>
</p>

<p>
  <img alt="Tauri" src="https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white" />
  <img alt="Rust" src="https://img.shields.io/badge/Rust-stable-000000?logo=rust&logoColor=white" />
  <img alt="License" src="https://img.shields.io/badge/License-Apache--2.0-blue.svg" />
  <img alt="i18n" src="https://img.shields.io/badge/i18n-ZH%20%7C%20EN-7B61FF" />
</p>

</div>

AllSessions brings local sessions from **Codex, Claude Code, Gemini CLI, Pi, Kimi Code CLI, OpenCode, Kilo, ZCode, Cursor, Devin, GitHub Copilot, Hermes Agent, and VS Code Copilot Chat** into a single desktop app.

Instead of hunting through different tools and directories for past history, you can browse sessions, run full-text search, inspect tool calls, organize favorites and tags, review usage statistics, and export sessions — all in one interface.

AllSessions is built on Tauri 2. Session discovery, parsing, search, caching, file watching, and maintenance are implemented in Rust; the WebView frontend only renders the UI. The app opens no local HTTP server and bundles no Node.js runtime.

> [!NOTE]
> AllSessions is an independent community project. It is not affiliated with, sponsored by, or endorsed by the maintainers or vendors of the supported agents. Product and company names are used only to identify compatible local data sources.

## Features

### Unified multi-agent sessions

- Browse local sessions from multiple AI coding agents in one interface
- Filter by source, provider, date, project, and working directory
- Inspect normalized conversations, thinking, tool calls, and raw events
- Hide subagents, sidechains, thinking, and injected context by default
- Watch source files and refresh automatically

### Full-text search

- Search titles, paths, tags, notes, and message text together
- Whitespace-separated multi-term matching; every term must hit
- One- and two-character terms use substring matching; longer terms use a local trigram index
- Order results by relevance or recent activity
- Click a match snippet to jump to the surrounding messages
- In-session highlighting with previous/next navigation

Full-text search uses a per-message SQLite index. The index lives entirely on your machine — no cloud services or models — though the first scan takes extra time and disk space.

Long sessions keep bounded head/tail detail windows and a 64 MB LRU cache; matched messages load on demand beyond the overview window.

### Organize and statistics

- Favorite sessions and attach tags and notes
- Save reusable filters
- Manage local archive/removal state
- Compare session, message, tool, activity, provider, and working-directory statistics by agent
- Batch-select loaded sessions and export as JSON or Markdown
- Optional export redaction, off by default

### Desktop integration

- Reveal a session source file or project directory in the system file manager
- Open a system terminal in the session's working directory
- Resume the session in the corresponding agent (Cursor, Devin, and VS Code Copilot Chat are read-only sources and do not support resume)
- Pick a terminal app or configure a custom executable
- Five visual themes
- Light, dark, and system color schemes
- Keyboard shortcuts for primary views, settings sections, and conversations

### Local-first

- Parsing, search, and caching all happen locally
- Incremental SQLite index cache
- Imports the legacy `session-index.json` on first upgrade
- Starts with safe defaults when the configuration is damaged and guides you to repair source settings
- Per-source scan health status
- Copyable sanitized diagnostics without session content or local paths
- Local backup before permanently deleting original records

## Supported sources

| Source | Default path | Coverage |
| --- | --- | --- |
| **Codex** | `~/.codex/sessions` | Metadata, messages, tools, raw events, search, live refresh |
| **Codex Archived** | `~/.codex/archived_sessions` | Browse, search, permanently delete archived sessions; files are not moved and archive state is not restored |
| **Claude Code** | `~/.claude/{projects,sessions}` | `projects/**/*.jsonl` and legacy `sessions/*.json`; conversations, thinking, tools/results, search, live refresh, with `history.jsonl` enrichment for legacy details when available |
| **Gemini CLI** | `~/.gemini/tmp/*/logs.json` | Streaming scan, per-`sessionId` aggregation, per-file incremental cache, bounded on-demand details |
| **Pi** | `~/.pi/agent/sessions` | Rebuilds the current branch from v1-v3 JSONL trees; messages, thinking, tools, summaries, raw events, search, live refresh |
| **Kimi Code CLI** | `~/.kimi/sessions` | `wire.jsonl`, working directories, custom titles, streamed content, subagents, tools, raw events, search, live refresh |
| **OpenCode** | `~/.local/share/opencode/opencode.db` | SQLite; messages, thinking, tools, subagents, raw events, search, WAL live refresh; read-only source |
| **Kilo** | `~/.local/share/kilo/kilo.db` | SQLite; messages, thinking, tools, subagents, raw events, search, WAL live refresh; read-only source |
| **ZCode** | `~/.zcode/cli/db/db.sqlite` | SQLite; messages, thinking, tools, compaction markers, raw events, search, WAL live refresh; subagent sessions excluded; read-only source |
| **Cursor** | `Cursor/User` under the OS config dir | IDE `conversation` records and agent transcripts; browsing, search, statistics, export, local removal; read-only source |
| **Devin** | `Devin/User` under the OS config dir and `~/.local/share/devin/cli` | Desktop `acp-messages`/`state.vscdb` and CLI `sessions.db`; browsing, search, statistics, export, local removal; read-only source |
| **GitHub Copilot** | `~/.copilot/session-state` | Per-session `events.jsonl` plus `workspace.yaml` metadata; messages, thinking, tools, raw events, search, live refresh, resume; read-only source |
| **Hermes Agent** | `~/.hermes` (macOS/Linux) or `%LOCALAPPDATA%\hermes` (Windows) | SQLite `state.db` including `profiles/<name>` databases; messages, thinking, tools, compaction-archive filtering, subagent exclusion, raw events, search, WAL live refresh, resume; read-only source |
| **VS Code Copilot Chat** | `Code/User` and `Code - Insiders/User` under the OS config dir | Panel chat sessions (`workspaceStorage`/`globalStorage`, flat `.json` and 1.109+ `.jsonl` append logs); messages, thinking, tools, file edits, custom titles, search, live refresh; empty placeholder sessions excluded; read-only source |

For read-only sources, AllSessions never modifies the agent's original data. You can still remove records locally inside AllSessions; deleting the original records must be done in the corresponding agent.

## Install and run

Download the installer for your platform from GitHub Releases.

End users **do not need Node.js, pnpm, or Rust**.

| Platform | Release file |
| --- | --- |
| Windows x64 | `*-windows-x64-setup.exe` |
| macOS ARM64 / x64 | `*-mac-<arch>.dmg` |
| Debian / Ubuntu Linux x64 | `*-linux-x64.deb` |

Windows, macOS, and Linux share the same Tauri 2 app shell, system tray, and signed update flow.

> [!NOTE]
> Some GNOME desktops require an AppIndicator/KStatusNotifierItem extension.
>
> macOS builds are not notarized yet; you may need to allow the app in system security settings on first launch.

## Configuration

Click **Settings** in the toolbar to:

- Switch language and appearance
- Edit per-source session paths
- Inspect source health status
- Copy sanitized diagnostics
- View and clear the index cache
- Review the permanent-deletion backup location

Source paths support `~` expansion.

Configuration is stored at the following location under the user config directory:

```text
AllSessions/config.json
```

You can also point `ALLSESSIONS_CONFIG_PATH` elsewhere.

Saved configuration takes effect immediately. Once a source has an explicit configured path, it no longer reads its environment variable; choosing "Restore default" falls back to the environment variable or the system default path.

If the configuration file is damaged, AllSessions starts with safe defaults and opens Source Settings automatically — no manual file editing required.

### Environment variables

Set environment variables before starting the desktop app; they are read once at startup.

| Variable | Purpose | Default |
| --- | --- | --- |
| `CODEX_HOME` | Codex data root (single path) | `~/.codex` |
| `CODEX_SESSIONS_DIR` | Codex session roots (path list) | `$CODEX_HOME/sessions` |
| `CODEX_ARCHIVED_SESSIONS_DIR` | Archived Codex session roots (path list) | `$CODEX_HOME/archived_sessions` |
| `CLAUDE_SESSIONS_DIR` | Claude Code roots (path list) | `~/.claude` |
| `GEMINI_SESSIONS_DIR` | Gemini CLI roots (path list) | `~/.gemini` |
| `PI_SESSIONS_DIR` | Pi session roots (path list) | `~/.pi/agent/sessions` |
| `PI_CODING_AGENT_SESSION_DIR` | Pi's official session directory | — |
| `PI_CODING_AGENT_DIR` | Pi's official data directory | `~/.pi/agent` |
| `KIMI_SESSIONS_DIR` | Kimi Code CLI data roots (path list) | `~/.kimi` |
| `KIMI_SHARE_DIR` | Kimi Code CLI's official data directory | `~/.kimi` |
| `OPENCODE_DB` | OpenCode's official SQLite database path | `~/.local/share/opencode/opencode.db` |
| `KILO_DB` | Kilo's SQLite database path | `~/.local/share/kilo/kilo.db` |
| `ZCODE_DB` | ZCode's official SQLite database path | `~/.zcode/cli/db/db.sqlite` |
| `DEVIN_SESSIONS_DIR` | Devin data roots (path list) | `Devin/User` and `~/.local/share/devin/cli` |
| `COPILOT_SESSIONS_DIR` | GitHub Copilot session roots (path list) | `~/.copilot/session-state` |
| `HERMES_SESSIONS_DIR` | Hermes Agent data roots (path list) | `%LOCALAPPDATA%\hermes` (Windows) or `~/.hermes` |
| `HERMES_HOME` | Hermes' official data root (single path) | same as above |
| `VSCODE_COPILOT_SESSIONS_DIR` | VS Code Copilot Chat data roots (path list) | `Code/User` and `Code - Insiders/User` under the OS config dir |
| `SESSION_VIEWER_CACHE_DIR` | Rust SQLite index directory | Platform cache directory under `AllSessions` |
| `SESSION_VIEWER_DISABLE_CACHE` | Set to `1` to disable persistent caching | unset |
| `ALLSESSIONS_WORKSPACE_DB` | AllSessions user-data SQLite path | Platform app-data directory |

The `*_SESSIONS_DIR` variables accept multiple paths separated by the OS path separator:

- macOS / Linux: `:`
- Windows: `;`

For example:

```bash
CODEX_SESSIONS_DIR=~/.codex/sessions:~/backups/codex/sessions
```

A leading `~` expands to the home directory, which also works when the app is launched from Finder/Dock without a shell to expand it.

When the AllSessions-specific variable is unset, Pi and Kimi keep using their official variables.

`OPENCODE_DB` follows OpenCode's own path rules: an absolute path is used directly, while a relative path resolves under OpenCode's data directory.

`KILO_DB` accepts absolute paths and resolves relative paths under Kilo's data directory. By default, the stable-channel `kilo.db` is scanned.

Non-existent source roots are skipped automatically. If the same session ID appears in several roots of one kind, only the first-listed root is kept, so a backup copy is shown once.

> [!NOTE]
> The Codex provider visibility repair tool only covers session directories under the primary `CODEX_HOME`, not additionally listed roots.

## Privacy and security

AllSessions works with local AI session data, which may contain:

- Prompts and responses
- Tool output
- Source code
- Working directories
- Provider identifiers
- Other session context

Normal browsing, search, and export never modify agent source data.

After explicit confirmation of permanent deletion, AllSessions creates a local backup before modifying the original Codex, Claude Code, or Gemini CLI records.

The Codex provider maintenance tool likewise only modifies Codex data after you enable maintenance mode and confirm execution.

Pi, Kimi Code CLI, OpenCode, Kilo, ZCode, Cursor, Devin, GitHub Copilot, Hermes Agent, and VS Code Copilot Chat are currently read-only. Their sessions can be removed locally from AllSessions, but deleting the original records must be done in the corresponding agent.

Favorites, tags, notes, saved filters, and local archive/removal state are AllSessions user data stored separately in `workspace.sqlite`. They never modify agent source records and are not cleared along with the rebuildable index cache.

### Export and local data

Export redaction is off by default.

When enabled, AllSessions removes known session identifiers and common local-path patterns — but automatic redaction cannot cover every kind of sensitive information.

> [!WARNING]
> - Review and sanitize export files, logs, screenshots, and issues before sharing.
> - Treat `workspace.sqlite`, index caches, deletion backups, and maintenance backups as sensitive local data.
> - Backups contain original records and are not encrypted.
> - Never publish real sessions, databases, caches, backups, credentials, or unsanitized local paths.

AllSessions opens no local HTTP port; the frontend and backend communicate only through Tauri IPC and events.

See [SECURITY.md](./SECURITY.md) for vulnerability reporting.

See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for Rust dependency licenses.

## Codex provider maintenance

AllSessions ships an **off-by-default** Codex provider maintenance tool for previewing a third-party provider rebucket plan.

Open **Tools** and enable maintenance mode to preview the plan before deciding whether to apply it.

On apply and rollback:

- Verify Codex App has exited
- Invalidate stale plans after data changes
- Create a backup before writing
- Restore only `model_provider` fields, preserving newer data

The tool modifies neither `config.toml` nor other agents' data.

See [Codex provider visibility repair](./docs/codex-provider-repair.zh-CN.md) (Chinese) for the full boundary.

## Development

### Requirements

- Node.js 24
- pnpm 12
- Rust stable
- [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform

Node.js is used only for frontend builds and release scripts; it is not part of the packaged runtime.

### Start development

```bash
pnpm install
pnpm desktop:dev
```

Desktop development (`pnpm dev` / `pnpm desktop:dev`) loads the UI through the Vite dev server. Frontend changes hot-reload without restarting the app.

To preview the UI in a browser only:

```bash
pnpm web:dev
```

Desktop APIs and local session loading remain available only inside the Tauri app.

### Verify and build

```bash
pnpm test
pnpm lint
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml
pnpm licenses:check
pnpm release:build
```

### Project structure

Session store and normalized contract:

```text
src-tauri/src/sessions.rs
```

Per-source format adapters:

```text
src-tauri/src/sessions/
```

Other core modules:

```text
cache.rs        # caching
backend.rs      # Tauri boundary
maintenance.rs  # maintenance operations
```

Read the [source architecture](./docs/source-adapters.md) before adding a new source.

## License

[Apache-2.0](./LICENSE)
