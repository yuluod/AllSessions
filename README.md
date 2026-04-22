<div align="center">

# AI Session Viewer

<p>A lightweight, local-only web viewer for browsing AI session history, designed to grow beyond a single source over time.</p>

<p>
  <a href="./README.zh-CN.md">中文文档</a>
  ·
  <a href="#quick-start">Quick Start</a>
  ·
  <a href="#features">Features</a>
  ·
  <a href="#development">Development</a>
</p>

<p>
  <img alt="Node.js" src="https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white" />
  <img alt="pnpm" src="https://img.shields.io/badge/pnpm-10%2B-F69220?logo=pnpm&logoColor=white" />
  <img alt="License" src="https://img.shields.io/badge/License-Apache--2.0-blue.svg" />
  <img alt="i18n" src="https://img.shields.io/badge/i18n-ZH%20%7C%20EN-7B61FF" />
</p>

</div>

Browse, filter, search, and inspect local AI sessions in a compact browser UI with real-time file watching.

> **Positioning**
> A local AI session viewer with a current Codex-first implementation.
>
> **Current status**
> Codex is supported today. Claude and additional sources are planned, but not implemented in this release.
>
> **Direction**
> Evolve toward a unified local viewer for multiple AI coding assistant histories.

## Current Scope

- Current implementation: Codex session parsing and viewing
- Planned direction: support for additional session sources such as Claude
- Non-goal for this release: multi-source parsing or unified provider ingestion

## Source Support

| Source | Status | Notes |
|--------|--------|-------|
| Codex | Supported | Reads local session files from `~/.codex/sessions` or `CODEX_SESSIONS_DIR` |
| Claude | Planned | Not implemented in the current release |
| Other AI tools | Planned | Future expansion area, no compatibility promise yet |

## Features

- Browse local session list
- Filter by provider, date, and working directory
- View individual session details
- Switch between "Conversation" and "Raw Events" views
- Chinese-English language switching
- Real-time file system watch with auto-refresh

## Use Cases

- Review recent local AI sessions without opening raw JSONL files
- Search previous conversations, tool calls, and event streams
- Inspect session metadata such as provider, working directory, and timestamps
- Keep a lightweight local viewer running while new Codex sessions are written to disk

## Requirements

- Node.js 20 or later
- Default session directory at `~/.codex/sessions`

## Quick Start

```bash
pnpm install
pnpm start
```

The viewer starts at `http://127.0.0.1:3210` by default.

Then open the URL in your browser and the app will scan the current Codex session directory automatically.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `3210` |
| `HOST` | Bind address | `127.0.0.1` |
| `CODEX_SESSIONS_DIR` | Session root directory | `~/.codex/sessions` |

Example:

```bash
PORT=4000 CODEX_SESSIONS_DIR=/path/to/sessions pnpm start
```

## Notes

- Local-only: no authentication or remote access control
- Read-only access to the session directory
- Current release only supports Codex session files; Claude and other sources are not implemented yet
- Legacy sessions with incompatible formats fall back to raw event view
- Encrypted fields are shown as-is without decryption
- Scans all sessions on startup and caches summaries; details are read on demand

## Roadmap

- Keep the current Codex viewer stable and lightweight
- Introduce a cleaner source abstraction for additional session formats
- Add optional support for Claude-style local exports or session logs
- Move toward a unified local viewer for multiple AI coding assistant histories

## Development

```bash
# Run tests
pnpm test

# Lint and auto-fix
pnpm lint

# Format code
pnpm format

# Build frontend (outputs to dist/)
pnpm build
```

## License

Apache-2.0
