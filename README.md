<div align="center">

# AllSessions

<p>A lightweight, local-only viewer for browsing AI coding assistant session history.</p>

<p>
  <a href="./README.zh-CN.md">中文文档</a>
  ·
  <a href="#features">Features</a>
  ·
  <a href="#quick-start">Quick Start</a>
  ·
  <a href="#installers-and-releases">Installers</a>
  ·
  <a href="#configuration">Configuration</a>
</p>

<p>
  <img alt="Node.js" src="https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white" />
  <img alt="pnpm" src="https://img.shields.io/badge/pnpm-11.10.0-F69220?logo=pnpm&logoColor=white" />
  <img alt="License" src="https://img.shields.io/badge/License-Apache--2.0-blue.svg" />
  <img alt="i18n" src="https://img.shields.io/badge/i18n-ZH%20%7C%20EN-7B61FF" />
</p>

</div>

AllSessions aggregates supported local AI session sources into one browser interface for browsing, filtering, full-text search, statistics, and detail inspection. Normal viewer mode reads source data without modifying it and only listens on a loopback address.

> AllSessions is an independent community project. It is not affiliated with, endorsed by, or sponsored by OpenAI, Anthropic, or Google. Product and company names are used only to identify compatible local session sources.

## Features

- Browse Codex, Codex Archived, Claude Code, and Gemini CLI sessions together
- Filter by source, provider, date, project, and working directory
- Search session-derived text and load large result sets incrementally
- Inspect normalized conversations and raw events
- Hide Codex subagent, Claude Code sidechain/thinking, and injected system context by default
- Watch local session files and refresh the interface automatically
- Switch between Chinese and English
- Bound memory use for large Codex and Claude Code sessions with visible truncation markers

## Supported sources

| Source | Local path | Current support |
|--------|------------|-----------------|
| Codex | `~/.codex/sessions` | Session metadata, messages, tool calls, raw events, and search |
| Codex Archived | `~/.codex/archived_sessions` | Read-only archived-session browsing |
| Claude Code | `~/.claude/projects/**/*.jsonl` | User and assistant messages, thinking, tool calls and results, raw events, search, and live refresh; legacy metadata remains as a fallback |
| Gemini CLI | `~/.gemini/tmp/*/logs.json` | Local session aggregation and detail inspection |

Custom source directories can be configured with environment variables.

## Quick start

Requirements:

- Node.js 24 or later
- pnpm 11.10.0 or later
- At least one supported local session directory

```bash
pnpm install
pnpm start
```

Open `http://127.0.0.1:3210`. AllSessions scans the supported local session directories that are present. It has no remote authentication and rejects wildcard, LAN, and public bind addresses.

## Installers and releases

GitHub Releases provide self-contained installers. They bundle the matching Node.js runtime, so end users do not need Node.js, pnpm, or a source checkout.

| Platform | Release asset | Installation result |
|----------|---------------|---------------------|
| Windows x64 | `*-windows-x64-setup.exe` | Native launcher, system tray, start-menu entry, and optional desktop shortcut |
| macOS | `*-mac-<arch>.pkg` | Native menu-bar launcher and `AllSessions.app` in `/Applications` |
| Debian/Ubuntu Linux x64 | `*-linux-x64.deb` | AppIndicator tray, application files in `/opt/AllSessions`, and an `allsessions` command |

The Windows, macOS, and Linux launchers open the local viewer automatically and provide actions for opening AllSessions, checking for updates, and stopping the background service. An available update can be downloaded, verified, and opened in the platform installer. Linux uses AppIndicator; GNOME desktops that hide legacy tray icons may require the AppIndicator/KStatusNotifierItem extension. All launchers still read only the supported session directories of the current user. The macOS package is not code-signed or notarized yet, so Gatekeeper may require an explicit local approval before it can be opened.

Before publishing, maintainers add a version section to `CHANGELOG.md` that matches `package.json`, then push a `v<package-version>` tag. The workflow validates the version, extracts that changelog section as the GitHub Release notes, and builds Windows x64, macOS ARM64, macOS x64, and Linux x64 installers. For example, version `1.2.3` requires a `## [1.2.3]` changelog section and tag `v1.2.3`. An existing tag can also be rebuilt manually from the Actions page by entering that tag name.

To create a native installer locally, install the platform packager first (Inno Setup on Windows, `pkgbuild` on macOS, or `dpkg-deb` on Debian/Ubuntu), then run:

```bash
pnpm release:build
```

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `3210` |
| `HOST` | Bind address; loopback addresses only | `127.0.0.1` |
| `CODEX_SESSIONS_DIR` | Codex session root | `~/.codex/sessions` |
| `CODEX_ARCHIVED_SESSIONS_DIR` | Codex archived-session root | `~/.codex/archived_sessions` |
| `CLAUDE_SESSIONS_DIR` | Claude Code root | `~/.claude` |
| `GEMINI_SESSIONS_DIR` | Gemini CLI root | `~/.gemini` |
| `SESSION_VIEWER_CACHE_DIR` | Private incremental index cache directory | `AllSessions` under the user cache directory |
| `SESSION_VIEWER_DISABLE_CACHE` | Set to `1` to disable the persistent index cache | unset |

Example:

```bash
PORT=4000 CODEX_SESSIONS_DIR=/path/to/sessions pnpm start
```

## Privacy and security

Local AI history may contain prompts, tool output, source snippets, working directories, provider identifiers, and other sensitive information.

- Review exported files before sharing them.
- Treat the incremental index cache and provider-repair backups as sensitive local data.
- Never attach real sessions, databases, caches, backups, credentials, or unredacted paths to public issues.
- Do not bypass the loopback-only restriction to expose the server to a network.

See [SECURITY.md](./SECURITY.md) for private vulnerability reporting guidance and the security boundary.

## Optional Codex provider repair

AllSessions includes a maintenance tool, disabled by default, for Codex histories that became invisible after switching third-party providers. Start normally, then enable maintenance mode from the **Tools** page.

```bash
pnpm start
```

The workflow requires an exact preview, explicit provider selection, confirmation that Codex App is closed, verified backups, and rollback support. It modifies selected Codex provider metadata only; it does not modify `config.toml` or third-party tool data.

The server remains read-only while the switch is off. Enabling it still requires an exact plan and confirmation that Codex App has exited. See [Codex Provider Visibility Repair](./docs/codex-provider-repair.md) before using maintenance mode or the CLI.

## Known limitations

- Local session formats can change between upstream tool versions; unsupported historical records may fall back to raw-event display.
- Claude Code project transcripts are not a stable public API; unknown records remain available as raw events, and legacy environments fall back to user-input history.
- Large Codex and Claude Code details use a marked head/tail safety window, and the search index stores bounded text per session.
- Injected developer and environment context is excluded from default conversation and search views, but remains present in raw local data and full exports.

## Development

```bash
pnpm install
pnpm test
pnpm lint
pnpm build
```

## License

[Apache-2.0](./LICENSE)
