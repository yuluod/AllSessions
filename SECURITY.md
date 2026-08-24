# Security Policy

## Supported versions

This repository is maintained as a personal open-source project. Security fixes are applied to the latest version on the default branch; older releases are not supported separately.

## Reporting a vulnerability

Do not publish vulnerabilities, real session content, credentials, local paths, databases, caches, or backups in a public issue.

Use [GitHub private vulnerability reporting](https://github.com/yuluod/AllSessions/security/advisories/new). If private reporting is unavailable, open a minimal public issue asking for a private contact channel without including exploit details or sensitive artifacts.

Include only the minimum information needed to reproduce the issue. Replace prompts, provider identifiers, usernames, home directories, tokens, and service URLs with neutral placeholders. For ordinary bugs, prefer the **Copy sanitized diagnostics** action in Settings instead of attaching local files.

## Security boundary

- AllSessions is a local Tauri desktop application. It does not open an HTTP listening port or bundle a Node.js runtime; the WebView communicates with Rust through Tauri IPC and events.
- The WebView uses a restrictive Content Security Policy, including `connect-src 'none'`. Tauri IPC is an application boundary, not authentication between users or protection from software already running as the same local user.
- Browsing, search, filtering, statistics, and export do not modify Agent source data.
- Explicitly confirmed permanent deletion modifies Codex, Claude Code, or Gemini CLI source data. A local backup is created before the write; these backups contain the original sensitive data, are not encrypted, and currently require manual inspection for recovery.
- Codex Provider maintenance is disabled by default. It can modify Codex databases and JSONL metadata only after maintenance mode is enabled and a preview and confirmation are completed; its own backup and rollback rules are documented separately.
- Session content, index caches, configuration paths, deletion backups, and maintenance backups may reveal sensitive local information. Review and redact them before sharing.

## Scope

Reports are especially useful for unintended remote exposure, unsafe Tauri command access, path traversal, symlink handling, parsing or deletion that affects data outside the selected record, unsafe backup or rollback behavior, sensitive file permissions, and updater integrity failures.
