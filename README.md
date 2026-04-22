# Codex Session Viewer

[中文文档](./README.zh-CN.md)

A lightweight, local-only web viewer for browsing Codex session history stored in `~/.codex/sessions`.

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
