<div align="center">

<img src="./public/assets/allsessions-icon-v2.png" alt="AllSessions 图标" width="112" height="112" />

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

AllSessions 将 Codex、Claude Code 和 Gemini CLI 的本地会话聚合到一个 Tauri 桌面应用中。会话发现、解析、搜索、缓存、文件监听和维护操作均由 Rust 实现；前端 WebView 只负责展示，不启动 HTTP 服务，也不捆绑 Node.js 运行时。

> AllSessions 是独立的社区项目，与 OpenAI、Anthropic、Google 不存在隶属、赞助或官方认可关系。产品及公司名称仅用于说明兼容的本地会话来源。

## 功能

- 统一浏览 Codex、Codex 归档、Claude Code 和 Gemini CLI 会话
- 按来源、Provider、日期、项目和工作目录筛选并搜索
- 查看归一化对话、工具调用与原始事件
- 监听来源文件并通过 Tauri 事件自动刷新
- 默认隐藏 subagent、sidechain、Thinking 和注入的系统上下文
- 使用流式摘要解析、64KB/会话搜索上限、首尾详情窗口和 64MB LRU 控制大历史内存
- 使用 SQLite 增量索引缓存，并在首次升级时导入旧版 `session-index.json`
- 提供默认关闭、带预览指纹和字段级回滚的 Codex Provider 维护工具

## 支持来源

| 来源 | 默认本地路径 | 支持范围 |
| --- | --- | --- |
| Codex | `~/.codex/sessions` | 元数据、消息、工具调用、原始事件、搜索和实时刷新 |
| Codex 归档 | `~/.codex/archived_sessions` | 只读浏览归档会话 |
| Claude Code | `~/.claude/projects/**/*.jsonl` | 对话、Thinking、工具调用/结果、搜索和实时刷新；旧版 `sessions/*.json` 作为回退 |
| Gemini CLI | `~/.gemini/tmp/*/logs.json` | 按 sessionId 聚合本地对话和详情 |

## 安装包与运行

从 GitHub Releases 下载当前平台安装包。普通用户不需要安装 Node.js、pnpm 或 Rust。

| 平台 | 发布文件 |
| --- | --- |
| Windows x64 | `*-windows-x64-setup.exe` |
| macOS ARM64 / x64 | `*-mac-<arch>.dmg` |
| Debian/Ubuntu Linux x64 | `*-linux-x64.deb` |

Windows、macOS 和 Linux 共用 Tauri 2 应用壳、系统托盘和签名更新流程。部分 GNOME 桌面需要 AppIndicator/KStatusNotifierItem 扩展。macOS 安装包暂未公证，首次打开时可能需要在系统安全设置中手动允许。

## 配置

环境变量需在启动桌面应用前设置：

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `CODEX_HOME` | Codex 数据根目录 | `~/.codex` |
| `CODEX_SESSIONS_DIR` | Codex 会话目录 | `$CODEX_HOME/sessions` |
| `CODEX_ARCHIVED_SESSIONS_DIR` | Codex 归档目录 | `$CODEX_HOME/archived_sessions` |
| `CLAUDE_SESSIONS_DIR` | Claude Code 根目录 | `~/.claude` |
| `GEMINI_SESSIONS_DIR` | Gemini CLI 根目录 | `~/.gemini` |
| `SESSION_VIEWER_CACHE_DIR` | Rust SQLite 索引缓存目录 | 系统用户缓存目录下的 `AllSessions` |
| `SESSION_VIEWER_DISABLE_CACHE` | 设为 `1` 时禁用持久缓存 | 未设置 |

## 隐私与安全

本地 AI 历史可能包含提示词、工具输出、源代码、工作目录和 Provider 标识。普通浏览不会修改来源数据；唯一写入来源数据的能力是工具页中需显式开启的 Codex Provider 维护模式。

- 分享导出、日志、截图或 issue 前应人工脱敏。
- 索引缓存与维护备份均应视为敏感本地数据。
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

来源实现集中在 [`src-tauri/src/sessions.rs`](./src-tauri/src/sessions.rs)，缓存、Tauri 边界和维护操作分别位于 `cache.rs`、`backend.rs` 与 `maintenance.rs`。增加来源前请阅读[来源架构](./docs/source-adapters.md)。

## 许可证

[Apache-2.0](./LICENSE)
