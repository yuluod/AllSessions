<div align="center">

<img src="./public/assets/allsessions-icon-v3.png" alt="AllSessions 图标" width="112" height="112" />

# AllSessions

**一个本地优先的 AI 编码助手会话桌面工作台**

统一浏览、搜索、整理和管理多个 AI Coding Agent 的本地会话。

<p>
  <a href="./README.md">English</a>
  ·
  <a href="#功能">功能</a>
  ·
  <a href="#支持来源">支持来源</a>
  ·
  <a href="#安装与运行">安装</a>
  ·
  <a href="#开发">开发</a>
</p>

<p>
  <img alt="Tauri" src="https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white" />
  <img alt="Rust" src="https://img.shields.io/badge/Rust-stable-000000?logo=rust&logoColor=white" />
  <img alt="许可证" src="https://img.shields.io/badge/License-Apache--2.0-blue.svg" />
  <img alt="多语言" src="https://img.shields.io/badge/i18n-ZH%20%7C%20EN-7B61FF" />
</p>

</div>

AllSessions 将 **Codex、Claude Code、Gemini CLI、Pi、Kimi Code CLI、OpenCode、ZCode、Cursor、Devin、GitHub Copilot 和 Hermes Agent** 的本地会话集中到一个桌面应用中。

无需在不同工具和目录之间来回查找历史记录，你可以在一个界面中浏览会话、全文搜索、查看工具调用、整理收藏与标签、统计使用情况，并按需导出会话。

AllSessions 基于 Tauri 2 构建。会话发现、解析、搜索、缓存、文件监听和维护操作均由 Rust 实现；前端 WebView 负责界面展示。应用不启动本地 HTTP 服务，也不需要捆绑 Node.js 运行时。

> [!NOTE]
> AllSessions 是独立的社区项目，与所支持 Agent 的维护者或厂商不存在隶属、赞助或官方认可关系。文中产品及公司名称仅用于说明兼容的本地会话来源。

## 功能

### 多 Agent 会话统一管理

- 在一个界面中浏览多个 AI Coding Agent 的本地会话
- 按来源、Provider、日期、项目和工作目录筛选
- 查看归一化后的对话、Thinking、工具调用和原始事件
- 默认隐藏 subagent、sidechain、Thinking 和注入的系统上下文
- 监听来源文件变化并自动刷新

### 全文搜索

- 同时搜索标题、路径、标签、备注和消息正文
- 支持空格分隔的多关键词匹配，所有关键词均需命中
- 中文一至两个字使用子串匹配，其余内容使用本地 trigram 索引
- 搜索结果可按相关度或最近活动时间排序
- 点击搜索片段即可定位附近消息
- 支持会话内高亮以及上一处 / 下一处导航

全文搜索使用逐消息 SQLite 索引。索引完全保存在本地，不使用云端服务或模型；首次扫描可能需要额外时间和磁盘空间。

长会话采用首尾详情窗口和 64 MB LRU 缓存，搜索命中的消息可按需加载，不受概览窗口限制。

### 整理与统计

- 收藏会话并添加标签、备注
- 保存常用筛选
- 管理本地归档 / 移除状态
- 按 Agent 对比会话、消息、工具、活跃度、Provider 和工作目录统计
- 批量选择当前已加载的会话并导出为 JSON 或 Markdown
- 导出时可选择启用脱敏，默认关闭

### 桌面集成

- 在系统文件管理器中定位会话来源文件或项目目录
- 从会话工作目录打开系统终端
- 恢复对应 Agent 的会话（Cursor 和 Devin 为只读来源，不支持恢复）
- 可选择终端应用或配置自定义可执行文件
- 提供五套界面主题
- 支持浅色、深色和跟随系统模式
- 支持键盘快捷键切换主视图、设置分区和浏览对话

### 本地优先

- 会话解析、搜索和缓存均在本地完成
- 使用 SQLite 增量索引缓存
- 首次升级时可导入旧版 `session-index.json`
- 配置损坏时使用安全默认值启动，并引导进入来源设置修复
- 可查看各来源扫描健康状态
- 可复制不包含会话内容和本地路径的脱敏诊断信息
- 永久删除原始记录前会先创建本地备份

## 支持来源

| 来源 | 默认本地路径 | 支持范围 |
| --- | --- | --- |
| **Codex** | `~/.codex/sessions` | 元数据、消息、工具调用、原始事件、搜索、实时刷新 |
| **Codex 归档** | `~/.codex/archived_sessions` | 浏览、搜索、永久删除归档会话；不移动文件或恢复归档状态 |
| **Claude Code** | `~/.claude/{projects,sessions}` | `projects/**/*.jsonl` 与旧版 `sessions/*.json`；对话、Thinking、工具调用/结果、搜索、实时刷新，并在可用时从 `history.jsonl` 补充旧版详情 |
| **Gemini CLI** | `~/.gemini/tmp/*/logs.json` | 流式扫描、按 `sessionId` 聚合、逐文件增量缓存、按需加载有界详情 |
| **Pi** | `~/.pi/agent/sessions` | 从 v1-v3 JSONL 树重建当前分支；消息、Thinking、工具、摘要、原始事件、搜索、实时刷新 |
| **Kimi Code CLI** | `~/.kimi/sessions` | `wire.jsonl`、工作目录、自定义标题、流式内容、子 Agent、工具、原始事件、搜索、实时刷新 |
| **OpenCode** | `~/.local/share/opencode/opencode.db` | SQLite；消息、Thinking、工具、子 Agent、原始事件、搜索、WAL 实时刷新；来源只读 |
| **ZCode** | `~/.zcode/cli/db/db.sqlite` | SQLite；消息、Thinking、工具、压缩标记、原始事件、搜索、WAL 实时刷新；排除子 Agent 会话；来源只读 |
| **Cursor** | 系统配置目录下的 `Cursor/User` | IDE conversation 与 agent-transcripts；浏览、搜索、统计、导出、本地移除；来源只读 |
| **Devin** | 系统配置目录下的 `Devin/User` 与 `~/.local/share/devin/cli` | 桌面版 `acp-messages`/`state.vscdb` 与 CLI `sessions.db`；浏览、搜索、统计、导出、本地移除；来源只读 |
| **Hermes Agent** | macOS/Linux `~/.hermes`、Windows `%LOCALAPPDATA%\hermes` | SQLite `state.db`（含 `profiles/<name>` 命名库）；消息、Thinking、工具、压缩归档过滤、子代理排除、原始事件、搜索、WAL 实时刷新、恢复；来源只读 |

对于只读来源，AllSessions 不会修改 Agent 的原始数据。你仍然可以在 AllSessions 中执行本地移除；如需删除原始记录，需要在对应 Agent 中操作。

## 安装与运行

从 GitHub Releases 下载当前平台对应的安装包即可。

普通用户**无需安装 Node.js、pnpm 或 Rust**。

| 平台 | 发布文件 |
| --- | --- |
| Windows x64 | `*-windows-x64-setup.exe` |
| macOS ARM64 / x64 | `*-mac-<arch>.dmg` |
| Debian / Ubuntu Linux x64 | `*-linux-x64.deb` |

Windows、macOS 和 Linux 共用 Tauri 2 应用壳、系统托盘和签名更新流程。

> [!NOTE]
> 部分 GNOME 桌面环境需要 AppIndicator/KStatusNotifierItem 扩展。
>
> macOS 安装包目前尚未公证，首次打开时可能需要在系统安全设置中手动允许。

## 配置

点击顶栏的「设置」按钮即可：

- 切换语言和外观
- 按来源编辑会话路径
- 查看来源健康状态
- 复制脱敏诊断信息
- 查看并清除索引缓存
- 查看永久删除备份位置

来源路径支持 `~` 展开。

配置保存在系统用户配置目录下的：

```text
AllSessions/config.json
```

也可以通过 `ALLSESSIONS_CONFIG_PATH` 指定其他位置。

保存配置后立即生效。为某个来源显式配置路径后，该来源不再读取对应环境变量；选择「恢复默认」后，则重新使用环境变量或系统默认路径。

如果配置文件损坏，AllSessions 会使用安全默认值启动并自动打开来源设置，无需手动编辑配置文件。

### 环境变量

环境变量需要在启动桌面应用之前设置，应用在启动时读取一次。

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `CODEX_HOME` | Codex 数据根目录（单路径） | `~/.codex` |
| `CODEX_SESSIONS_DIR` | Codex 会话根目录（路径列表） | `$CODEX_HOME/sessions` |
| `CODEX_ARCHIVED_SESSIONS_DIR` | Codex 归档根目录（路径列表） | `$CODEX_HOME/archived_sessions` |
| `CLAUDE_SESSIONS_DIR` | Claude Code 根目录（路径列表） | `~/.claude` |
| `GEMINI_SESSIONS_DIR` | Gemini CLI 根目录（路径列表） | `~/.gemini` |
| `PI_SESSIONS_DIR` | Pi 会话根目录（路径列表） | `~/.pi/agent/sessions` |
| `PI_CODING_AGENT_SESSION_DIR` | Pi 官方会话目录 | — |
| `PI_CODING_AGENT_DIR` | Pi 官方数据目录 | `~/.pi/agent` |
| `KIMI_SESSIONS_DIR` | Kimi Code CLI 数据根目录（路径列表） | `~/.kimi` |
| `KIMI_SHARE_DIR` | Kimi Code CLI 官方数据目录 | `~/.kimi` |
| `OPENCODE_DB` | OpenCode 官方 SQLite 数据库路径 | `~/.local/share/opencode/opencode.db` |
| `ZCODE_DB` | ZCode 官方 SQLite 数据库路径 | `~/.zcode/cli/db/db.sqlite` |
| `DEVIN_SESSIONS_DIR` | Devin 数据根目录（路径列表） | `Devin/User` 与 `~/.local/share/devin/cli` |
| `COPILOT_SESSIONS_DIR` | GitHub Copilot 会话根目录（路径列表） | `~/.copilot/session-state` |
| `HERMES_SESSIONS_DIR` | Hermes Agent 数据根目录（路径列表） | `%LOCALAPPDATA%\hermes`（Windows）或 `~/.hermes` |
| `HERMES_HOME` | Hermes 官方数据根目录（单路径） | 同上 |
| `SESSION_VIEWER_CACHE_DIR` | Rust SQLite 索引缓存目录 | 系统用户缓存目录下的 `AllSessions` |
| `SESSION_VIEWER_DISABLE_CACHE` | 设为 `1` 时禁用持久缓存 | 未设置 |
| `ALLSESSIONS_WORKSPACE_DB` | AllSessions 用户数据 SQLite 路径 | 系统应用数据目录 |

七个 `*_SESSIONS_DIR` 变量支持配置多个路径，使用系统路径分隔符分隔：

- macOS / Linux：`:`
- Windows：`;`

例如：

```bash
CODEX_SESSIONS_DIR=~/.codex/sessions:~/backups/codex/sessions
```

路径支持将开头的 `~` 展开为用户主目录，从 Finder / Dock 启动应用、没有 shell 参与路径展开时同样有效。

未设置 AllSessions 专用变量时，Pi 和 Kimi 会继续使用各自的官方变量。

`OPENCODE_DB` 遵循 OpenCode 自身的路径规则：绝对路径直接使用，相对路径基于 OpenCode 数据目录解析。

不存在的来源根目录会被自动跳过。同一类来源的多个根目录中如果出现相同会话 ID，只保留列表中靠前的记录，因此备份副本不会重复显示。

> [!NOTE]
> Codex Provider 可见性修复工具仅覆盖主 `CODEX_HOME` 下的会话目录，不包含额外配置的根目录。

## 隐私与安全

AllSessions 处理的是本地 AI 会话数据，其中可能包含：

- 提示词与回复
- 工具输出
- 源代码
- 工作目录
- Provider 标识
- 其他会话上下文

普通浏览、搜索和导出操作不会修改 Agent 的来源数据。

显式确认永久删除后，AllSessions 会先创建本地备份，再修改 Codex、Claude Code 或 Gemini CLI 的原始记录。

Codex Provider 维护工具同样只有在用户主动启用维护模式并确认执行后才会修改 Codex 数据。

Pi、Kimi Code CLI、OpenCode、ZCode、Cursor、Devin、GitHub Copilot 和 Hermes Agent 当前保持只读。它们的会话可以从 AllSessions 中本地移除，但删除原始记录需要在对应 Agent 中完成。

收藏、标签、备注、常用筛选以及本地归档 / 移除状态属于 AllSessions 自身的用户数据，独立保存在 `workspace.sqlite` 中。它们不会修改 Agent 的原始记录，也不会随着可重建的索引缓存一起清除。

### 导出与本地数据

导出脱敏功能默认关闭。

启用后，AllSessions 会移除已知的会话标识和常见本地路径模式，但自动脱敏不能保证覆盖所有敏感信息。

> [!WARNING]
> - 分享导出文件、日志、截图或 issue 前，请人工检查并脱敏。
> - `workspace.sqlite`、索引缓存、删除备份和维护备份都应视为敏感本地数据。
> - 备份包含原始记录，并且未加密。
> - 不要公开真实会话、数据库、缓存、备份、凭据或未经脱敏的本地路径。

AllSessions 不监听本地 HTTP 端口，前后端仅通过 Tauri IPC 和事件通信。

漏洞报告方式见 [SECURITY.md](./SECURITY.md)。

第三方 Rust 依赖及许可证信息见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

## Codex Provider 维护

AllSessions 提供一个**默认关闭**的 Codex Provider 维护工具，用于预览第三方 Provider 历史的重新归属计划。

进入「工具」并开启维护模式后，可以先预览计划，再决定是否执行。

执行和回滚时：

- 检查 Codex App 是否已经退出
- 数据发生变化后使旧计划失效
- 写入前创建备份
- 回滚仅恢复 `model_provider` 字段，保留之后新增的数据

该功能不会修改 `config.toml`，也不会修改其他 Agent 的数据。

完整边界说明见 [Codex Provider 可见性修复](./docs/codex-provider-repair.zh-CN.md)。

## 开发

### 环境要求

- Node.js 24
- pnpm 12
- Rust stable
- 当前平台对应的 [Tauri 2 前置依赖](https://v2.tauri.app/start/prerequisites/)

Node.js 仅用于前端构建和发布脚本，不会进入安装包运行时。

### 启动开发环境

```bash
pnpm install
pnpm desktop:dev
```

桌面开发（`pnpm dev` / `pnpm desktop:dev`）通过 Vite 开发服务器加载界面。前端修改支持热更新，无需重启应用。

如果只需要在浏览器中预览界面：

```bash
pnpm web:dev
```

桌面 API 和本地会话加载仍然只能在 Tauri 应用中使用。

### 验证与构建

```bash
pnpm test
pnpm lint
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml
pnpm licenses:check
pnpm release:build
```

### 项目结构

来源存储与统一契约：

```text
src-tauri/src/sessions.rs
```

各来源格式适配器：

```text
src-tauri/src/sessions/
```

其他核心模块：

```text
cache.rs        # 缓存
backend.rs      # Tauri 边界
maintenance.rs  # 维护操作
```

增加新的来源前，请先阅读[来源架构](./docs/source-adapters.md)。

## 许可证

[Apache-2.0](./LICENSE)