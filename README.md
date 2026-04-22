<div align="center">

# Codex Session Viewer

<p>A lightweight, local-only web viewer for browsing Codex session history stored in <code>~/.codex/sessions</code>.</p>

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

Browse, filter, search, and inspect local Codex sessions in a compact browser UI with real-time file watching.

## Features

- Browse local session list
- Filter by provider, date, and working directory
- View individual session details
- Switch between "Conversation" and "Raw Events" views
- Chinese-English language switching
- Real-time file system watch with auto-refresh

## Requirements

- Node.js 20 or later
- Default session directory at `~/.codex/sessions`

## Quick Start

```bash
pnpm install
pnpm start
```

The viewer starts at `http://127.0.0.1:3210` by default.

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
- Legacy sessions with incompatible formats fall back to raw event view
- Encrypted fields are shown as-is without decryption
- Scans all sessions on startup and caches summaries; details are read on demand

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
