# Security Policy

## Supported versions

This project is maintained as a personal open-source project. Security fixes are applied to the latest version on the default branch; older revisions are not supported separately.

## Reporting a vulnerability

Please do not publish vulnerabilities, real session content, credentials, local paths, database files, or migration backups in a public issue.

Use GitHub's private vulnerability reporting for this repository when available. If private reporting is unavailable, open a minimal public issue asking for a private contact channel without including exploit details or sensitive artifacts.

Include only the minimum information needed to reproduce the issue. Replace real prompts, provider identifiers, usernames, home directories, access tokens, and service URLs with neutral placeholders.

## Security boundary

- AllSessions has no login or remote authentication and only permits loopback bind addresses.
- The desktop shell starts its bundled service on a dynamically selected loopback port with a per-process random token and verifies the service identity before navigating to it.
- The local HTTP interface sends a restrictive Content Security Policy and common browser hardening headers. These controls reduce browser-side attack surface but do not turn the loopback service into a multi-user authenticated service.
- Normal startup begins in read-only mode. Provider repair remains blocked until the local user enables maintenance mode in the Tools page.
- Maintenance mode is explicitly enabled and can modify Codex state databases and JSONL metadata after preview and confirmation.
- Session content, the private index cache, and provider-repair backups may contain sensitive local information. Do not publish or share them without reviewing and redacting their contents.
- Browser extensions and other software running as the same local user may be able to access content displayed by the local web interface.

## Scope

Security reports are especially useful for unintended remote exposure, path traversal, cross-origin mutation, unsafe backup or rollback behavior, sensitive cache permissions, and parsing behavior that can overwrite or disclose local data.
