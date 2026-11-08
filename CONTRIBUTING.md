# Contributing

Thanks for your interest in AllSessions! This document covers the development setup, verification requirements, and submission conventions. See [AGENTS.md](AGENTS.md) for the full architecture and conventions (in Chinese).

## Communication

- Please write discussion, commit messages, and new code comments in Chinese; keep identifiers and existing terms as they are.
- In issues and pull requests, describe the goal, the scope of the change, and the verification you actually performed. State explicitly what was not verified.

## Development setup

- Node and pnpm: versions follow `.nvmrc` and `package.json`; install dependencies with `pnpm install --frozen-lockfile`.
- Rust: version follows `rust-toolchain.toml`.
- Linux additionally needs WebKitGTK and related system libraries; see the [Tauri 2 prerequisites](https://tauri.app/start/prerequisites/).

```bash
pnpm install --frozen-lockfile # Install dependencies
pnpm desktop:dev               # Desktop development (real data and system integration)
pnpm web:dev                   # Frontend only, backed by test stubs
```

## Verification before submitting

Pick checks by the scope of your change (full matrix in [AGENTS.md](AGENTS.md#开发与验证)):

| Change                                | Checks                                                                                                                                                                  |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend logic / components / styles  | `pnpm test`, `pnpm lint`, `pnpm build`; visually verify across the six themes and the compact layout for visual changes                                                 |
| Rust or the frontend/backend contract | The above plus `cargo test --manifest-path src-tauri/Cargo.toml --locked` and `cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings` |
| Docs only                             | Check the facts, then `pnpm exec prettier --check <changed files>`                                                                                                      |

## Conventions

- Add every new UI string in both Chinese and English (`public/i18n.js`), including empty and error states.
- Do not relax CSP, path constraints, or command allowlists. Tests use sanitized synthetic data and never touch real sessions, source databases, or backups.
- Keep `docs/` and both READMEs in sync with behavior changes. Release preparation and publishing are handled by the maintainer.

## Submitting a pull request

1. Fork the repository and create a branch from `main`.
2. Fill in the pull request template, checking only the verification you actually ran and noting anything unverified.
3. Update to the latest `main` before merging, pass CI on Windows, macOS, and Linux, and obtain at least one maintainer approval. New commits dismiss previous approvals, and all review conversations must be resolved. Repository administrators retain an exception for solo maintenance.

CI checks Prettier formatting for changed files and Rust formatting. Changes to Rust sources, packaging configuration, build scripts, dependencies, or workflows also build installers on all three platforms. These checks use no release secrets, generate no updater signatures, and publish no installers. macOS Intel packaging remains covered by the release workflow; installation and first launch require separate manual verification.
