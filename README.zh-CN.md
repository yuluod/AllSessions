<div align="center">

<img src="./public/assets/allsessions-icon-v3.png" alt="AllSessions 图标" width="112" height="112" />

# AllSessions

<p>一个本地优先的 AI 编码助手会话桌面工作台。</p>

<p><a href="./README.md">English</a> · <a href="#功能">功能</a> · <a href="#开发">开发</a></p>

<p>
  <img alt="Tauri" src="https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white" />
  <img alt="Rust" src="https://img.shields.io/badge/Rust-stable-000000?logo=rust&logoColor=white" />
  <img alt="许可证" src="https://img.shields.io/badge/License-Apache--2.0-blue.svg" />
  <img alt="多语言" src="https://img.shields.io/badge/i18n-ZH%20%7C%20EN-7B61FF" />
</p>

</div>

AllSessions 将 Codex、Claude Code、Gemini CLI、Pi、Kimi Code CLI 和 OpenCode 的本地会话聚合到一个 Tauri 桌面应用中。会话发现、解析、搜索、缓存、文件监听和维护操作均由 Rust 实现；前端 WebView 只负责展示，不启动 HTTP 服务，也不捆绑 Node.js 运行时。

> AllSessions 是独立的社区项目，与所支持 Agent 的维护者或厂商不存在隶属、赞助或官方认可关系。产品及公司名称仅用于说明兼容的本地会话来源。

## 功能

- 统一浏览 Codex、Codex 归档、Claude Code、Gemini CLI、Pi、Kimi Code CLI 和 OpenCode 会话
- 按来源、Provider、日期、项目和工作目录筛选并搜索
- 查看归一化对话、工具调用与原始事件
- 使用收藏、标签、备注、本地归档/移除状态和常用筛选整理会话
- 批量选择当前已加载会话并导出 JSON 或 Markdown，脱敏作为默认关闭的可选项
- 在系统文件管理器中显示会话来源文件或项目目录
- 监听来源文件并通过 Tauri 事件自动刷新
- 查看各来源扫描健康状态，并复制不含会话内容和本地路径的脱敏诊断信息
- 默认隐藏 subagent、sidechain、Thinking 和注入的系统上下文
- 使用流式摘要解析、64KB/会话搜索上限、首尾详情窗口和 64MB LRU 控制大历史内存
- 使用 SQLite 增量索引缓存，并在首次升级时导入旧版 `session-index.json`
- 配置损坏时使用安全默认值启动，并引导进入来源设置完成修复
- 显式确认永久删除前，先备份受影响的本地原始记录
- 提供默认关闭、带预览指纹和字段级回滚的 Codex Provider 维护工具

## 支持来源

| 来源          | 默认本地路径                          | 支持范围                                                                                                                                                  |
| ------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex         | `~/.codex/sessions`                   | 元数据、消息、工具调用、原始事件、搜索和实时刷新                                                                                                          |
| Codex 归档    | `~/.codex/archived_sessions`          | 浏览、搜索和永久删除归档会话；不移动文件或恢复归档状态                                                                                                    |
| Claude Code   | `~/.claude/{projects,sessions}`       | 同时扫描现代 `projects/**/*.jsonl` 与旧版 `sessions/*.json`；支持对话、Thinking、工具调用/结果、搜索和实时刷新，并在可用时从 `history.jsonl` 补充旧版详情 |
| Gemini CLI    | `~/.gemini/tmp/*/logs.json`           | 流式扫描、按 sessionId 聚合、逐文件增量缓存和按需加载有界详情                                                                                             |
| Pi            | `~/.pi/agent/sessions`                | 从 v1-v3 JSONL 树重建当前分支；支持消息、Thinking、工具、摘要、原始事件、搜索和实时刷新                                                                   |
| Kimi Code CLI | `~/.kimi/sessions`                    | 读取 `wire.jsonl`，关联工作目录和自定义标题，合并流式内容，并支持子 Agent、工具、原始事件、搜索和实时刷新                                                 |
| OpenCode      | `~/.local/share/opencode/opencode.db` | 读取最新正式版使用的 SQLite 格式；支持消息、Thinking、工具、子 Agent、原始事件、搜索和 WAL 实时刷新；来源数据保持只读                                     |

## 安装包与运行

从 GitHub Releases 下载当前平台安装包。普通用户不需要安装 Node.js、pnpm 或 Rust。

| 平台                    | 发布文件                  |
| ----------------------- | ------------------------- |
| Windows x64             | `*-windows-x64-setup.exe` |
| macOS ARM64 / x64       | `*-mac-<arch>.dmg`        |
| Debian/Ubuntu Linux x64 | `*-linux-x64.deb`         |

Windows、macOS 和 Linux 共用 Tauri 2 应用壳、系统托盘和签名更新流程。部分 GNOME 桌面需要 AppIndicator/KStatusNotifierItem 扩展。macOS 安装包暂未公证，首次打开时可能需要在系统安全设置中手动允许。

## 配置

顶栏的「设置」按钮打开设置对话框，可直接切换语言、按来源编辑会话路径（支持 `~` 展开）、查看来源健康状态、复制脱敏诊断信息，以及检查索引缓存和永久删除备份位置。来源路径配置保存到系统用户配置目录下的 `AllSessions/config.json`（可用 `ALLSESSIONS_CONFIG_PATH` 覆盖），保存后立即生效；设置了配置文件的来源不再读取对应环境变量，「恢复默认」则回到环境变量/系统默认路径。配置文件损坏时，应用会使用安全默认值启动并打开来源设置，无需手工编辑文件即可恢复。

环境变量需在启动桌面应用前设置（启动时读取一次）：

| 变量                           | 说明                                 | 默认值                                |
| ------------------------------ | ------------------------------------ | ------------------------------------- |
| `CODEX_HOME`                   | Codex 数据根目录（单路径）           | `~/.codex`                            |
| `CODEX_SESSIONS_DIR`           | Codex 会话根目录（路径列表）         | `$CODEX_HOME/sessions`                |
| `CODEX_ARCHIVED_SESSIONS_DIR`  | Codex 归档根目录（路径列表）         | `$CODEX_HOME/archived_sessions`       |
| `CLAUDE_SESSIONS_DIR`          | Claude Code 根目录（路径列表）       | `~/.claude`                           |
| `GEMINI_SESSIONS_DIR`          | Gemini CLI 根目录（路径列表）        | `~/.gemini`                           |
| `PI_SESSIONS_DIR`              | Pi 会话根目录（路径列表）            | `~/.pi/agent/sessions`                |
| `PI_CODING_AGENT_SESSION_DIR`  | Pi 官方会话目录                      | —                                     |
| `PI_CODING_AGENT_DIR`          | Pi 官方数据目录                      | `~/.pi/agent`                         |
| `KIMI_SESSIONS_DIR`            | Kimi Code CLI 数据根目录（路径列表） | `~/.kimi`                             |
| `KIMI_SHARE_DIR`               | Kimi Code CLI 官方数据目录           | `~/.kimi`                             |
| `OPENCODE_DB`                  | OpenCode 官方 SQLite 数据库路径      | `~/.local/share/opencode/opencode.db` |
| `SESSION_VIEWER_CACHE_DIR`     | Rust SQLite 索引缓存目录             | 系统用户缓存目录下的 `AllSessions`    |
| `SESSION_VIEWER_DISABLE_CACHE` | 设为 `1` 时禁用持久缓存              | 未设置                                |
| `ALLSESSIONS_WORKSPACE_DB`     | AllSessions 用户数据 SQLite 路径     | 系统应用数据目录                      |

六个 `*_SESSIONS_DIR` 变量支持用系统路径分隔符（macOS/Linux 为 `:`，Windows 为 `;`）分隔的多个路径，例如 `CODEX_SESSIONS_DIR=~/.codex/sessions:~/backups/codex/sessions`。路径支持前导 `~` 展开为用户主目录，从 Finder/Dock 启动（无 shell 展开环境变量）时同样生效。未设置 AllSessions 专用变量时，Pi 与 Kimi 会继续采用各自的官方变量。`OPENCODE_DB` 遵循 OpenCode 自身规则：绝对路径直接使用，相对路径基于 OpenCode 数据目录解析。不存在的根会被跳过；同一类来源的多个根中出现相同会话 id 时，只保留列表中靠前的根（备份副本只显示一次）。注意：Codex Provider 可见性修复工具只覆盖主 `CODEX_HOME` 下的会话目录，不包含额外列出的根。

## 隐私与安全

本地 AI 历史可能包含提示词、工具输出、源代码、工作目录和 Provider 标识。普通浏览、搜索和导出不会修改来源数据。显式确认永久删除会在创建本地备份后修改 Codex、Claude Code 或 Gemini CLI 的原始记录；Codex Provider 维护模式也会在启用并确认执行后修改 Codex 数据。Pi、Kimi Code CLI 与 OpenCode 在当前版本中保持只读：仍可在 AllSessions 内本地移除，但删除原始记录需回到对应 Agent 操作。

收藏、标签、备注、常用筛选和本地归档/移除状态属于 AllSessions 用户数据，独立保存在 `workspace.sqlite` 中；它们不会修改 Agent 原始记录，也不会随可重建的索引缓存一起清除。导出脱敏默认关闭；开启后会移除已知会话标识和常见本地路径模式，但分享前仍应人工检查导出内容。

- 分享导出、日志、截图或 issue 前应人工脱敏。
- `workspace.sqlite`、索引缓存、删除备份与维护备份均应视为敏感本地数据；备份包含原始记录且未加密。
- 不要公开真实会话、数据库、缓存、备份、凭据或未经脱敏的路径。
- 应用没有本地 HTTP 监听端口，前后端只通过 Tauri IPC 与事件通信。

漏洞报告方式见 [SECURITY.md](./SECURITY.md)。第三方 Rust 依赖及许可证见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

## Codex Provider 维护

进入「工具」，打开维护模式开关后，可预览第三方 Provider 历史重新归属计划。执行与回滚都会检查 Codex App 已退出，计划在数据变化后失效，写入前创建备份，且回滚只恢复 `model_provider` 字段以保留之后新增的数据。该功能不会修改 `config.toml` 或其他 Agent 数据。

完整边界见 [Codex Provider 可见性修复](./docs/codex-provider-repair.zh-CN.md)。

## 开发

构建要求：Node.js 24、pnpm 11.10、Rust stable 和当前平台的 [Tauri 2 前置依赖](https://v2.tauri.app/start/prerequisites/)。Node.js 仅用于前端构建和发布脚本，不进入安装包运行时。

```bash
pnpm install
pnpm desktop:dev
```

验证和构建：

```bash
pnpm test
pnpm lint
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml
pnpm licenses:check
pnpm release:build
```

来源存储与统一契约位于 [`src-tauri/src/sessions.rs`](./src-tauri/src/sessions.rs)，各格式适配器位于 `src-tauri/src/sessions/`；缓存、Tauri 边界和维护操作分别位于 `cache.rs`、`backend.rs` 与 `maintenance.rs`。增加来源前请阅读[来源架构](./docs/source-adapters.md)。

## 许可证

[Apache-2.0](./LICENSE)
