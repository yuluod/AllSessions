# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

(Tauri 2 desktop app; the WebView is the entire UI. Plain HTML/CSS/JS in `public/`, no frontend framework, bundled with Vite. Desktop window is the primary viewport; responsive rules exist down to narrow widths.)

## Users

Developers who use AI coding agents from the terminal (Codex, Claude Code, Gemini CLI, Pi, Kimi Code CLI, OpenCode) and want to browse, search, organize, and export their local session history. Primary user works alongside a terminal/IDE while coding, and also reviews history in normal desktop sessions — both dark and light environments (user-confirmed: dual theme / follow system is desired).

## Product Purpose

A local-first desktop workspace that unifies session history from six AI coding agents in one place: browse conversations, inspect tool activity and raw events, search across sources, view usage statistics, run maintenance (archive/delete/repair), and export sessions. Success = fast retrieval of any past session and confident local data management, with zero cloud dependency.

## Positioning

The only local-first, no-server, no-Node-runtime desktop viewer that normalizes six different agents' on-disk session formats into one searchable workspace. Rust owns discovery/parsing/search/caching; the UI is purely presentational.

## Operating Context

- Reads real local data: `~/.codex/sessions`, `~/.claude/{projects,sessions}`, `~/.gemini/tmp`, `~/.pi/agent/sessions`, `~/.kimi/sessions`, OpenCode SQLite DB.
- Views: session list + conversation detail (workspace), statistics/analytics, tools/maintenance, settings.
- Live refresh via filesystem watching; per-source scan health diagnostics.
- Favorites, tags, notes, archive state, reusable filters; JSON/Markdown export with redaction options.
- i18n: zh-CN and English (`public/i18n.js`).

## Capabilities and Constraints

- No HTTP server, no Node at runtime; frontend must stay framework-free vanilla JS + CSS (existing codebase convention).
- Large histories: streaming summaries, capped search text, bounded detail windows — UI must handle long lists and long conversations gracefully.
- Destructive actions (permanent delete, rollback repair) exist and need unmistakable, guarded presentation.
- Existing frontend files: `public/index.html`, `public/app.js`, view modules, `public/styles/*.css`.

## Brand Commitments

- Name: AllSessions; existing icon at `public/assets/allsessions-icon-v3.png`.
- Independent community project; must not imply affiliation with agent vendors.
- No other binding visual commitments — the 2026-08 redesign explicitly replaces the previous teal/light look (user judged it ugly; full visual + layout replacement approved, only functions and data preserved).

## Evidence on Hand

- Real session data on the user's machine (504 sessions at time of writing). No invented benchmarks/testimonials allowed.
- README.md / README.zh-CN.md describe features accurately.

## Product Principles

1. Retrieval speed first: any session findable in seconds; scanability beats decoration.
2. Local data deserves trust cues: destructive vs safe actions must be visually unambiguous.
3. One workspace, six sources: source identity is metadata, not competing branding.
4. Dense but calm: power-user density without visual noise; works beside a terminal (dark) and in daylight (light).
