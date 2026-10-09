# 来源兼容性核对（2026-10-09）

范围是现有来源的发现路径、会话读取和恢复命令。核对使用本地实现、官方文档与可获取源码；没有启动真实会话恢复，也没有将全部来源升级安装后实测。表中的“未发现差异”仅限已核对部分。

| 来源 | 核对结果 | 本轮处理 |
| --- | --- | --- |
| Pi | 已核对 v1.0.0；v3 JSONL 布局沿用，指定会话应使用 `--session` | 前一轮已修正命令并补代表性格式测试 |
| OpenCode | 官方 TUI 使用 `--session <id>`，现有 `opencode resume` 错误；未成功取得最新数据库源码，不能额外确认数据库兼容性 | 同步修正前后端命令，在既有测试增加一条断言 |
| Gemini CLI | 当前仅扫描 `logs.json`，遗漏完整 `chats/session-*` 会话；v0.61.0 已有 JSONL 回放机制 | 确认需要适配，更新来源边界；本轮未实现新解析器 |
| Kimi Code CLI | 新版 Node.js 的根目录、Wire 事件与元数据布局均不同 | 后续已补充 Wire 1.0–1.5 读取、回退、元数据刷新和迁移去重，保留旧版；详见来源说明 |
| Codex | 本机 0.161.0 的 `codex resume <id>` 有效；官方仍提供 rollout 持久化类型 | 命令无需调整；未完整验证新型历史引用和分支重建 |
| Claude Code | 本机 2.1.285 与官方 CLI 文档仍支持 `claude --resume <id>` | 命令无需调整；未用新版真实转录验证全部事件 |
| GitHub Copilot CLI | 官方仍使用 `session-state/<id>/events.jsonl`，支持 `--resume` | 路径与命令未发现差异；未覆盖全部新增事件 |
| Hermes | 官方仍使用 `state.db` 与独立 profile 数据库，本地已支持这两种布局 | 布局未发现差异；未逐列验证最新 schema |
| VS Code Copilot | 官方主分支仍使用 `chatSessions` / `emptyWindowChatSessions`、JSON/JSONL 与对象变更日志 | 基础布局未发现差异；未逐项覆盖新增响应类型 |
| Kilo | 当前与 OpenCode 共用 SQLite 投影；本轮未成功取得最新表结构源码 | 保留现状，最新 schema 待验证 |
| ZCode | 当前适配 SQLite 三表；公开 CLI 源码和现有发行版的数据契约尚未完成对应 | 保留现状，最新 schema 与恢复参数待验证 |
| Cursor | 官方公开文档未提供完整桌面数据库契约；SDK 的 NDJSON 存储是另一种用途 | 保留现有桌面适配，不据 SDK 文档扩大扫描范围 |
| Devin | 本机 3000.11.3 提供 `--resume`；当前来源同时含桌面与 CLI，会话标识并非都能直接交给 CLI | 未新增恢复入口，最新数据库结构待验证 |

## 后续优先级

新版 Kimi Wire 读取链路已补充，使用一份人工构造的代表性会话验证关键行为；仍保持只读。下一项是 Gemini 的完整读取链路：发现、摘要、详情、搜索、刷新与去重。保持旧记录可读，明确新格式的删除能力，不为未观察到的格式增加猜测分支或穷举测试。

## 核对依据

- [OpenCode CLI](https://opencode.ai/docs/cli/#tui)
- [Gemini 会话管理](https://geminicli.com/docs/cli/session-management/)及 [v0.61.0 存储实现](https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/core/src/services/chatRecordingService.ts)
- [Kimi 迁移说明](https://moonshotai.github.io/kimi-code/en/guides/migration.html)及 [Wire 契约](https://github.com/MoonshotAI/kimi-code/blob/main/packages/agent-core-v2/docs/wire-manifest.d.ts)
- [Codex 0.161.0 历史类型](https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/history/src/lib.rs)
- [Claude CLI](https://code.claude.com/docs/en/cli-reference)
- [Copilot CLI 配置目录](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference)
- [Hermes 会话存储](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/session-storage.md)
- [VS Code 会话存储](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/chat/common/model/chatSessionStore.ts)及 [对象变更适配](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/chat/common/model/chatSessionOperationLog.ts)
- [Cursor SDK 存储](https://cursor.com/docs/sdk/typescript)、[ZCode CLI 源码入口](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/packages/cli/src/run.ts)

本机 `codex --version` / `codex resume --help`、`claude --version` / `claude --help`、`devin --version` / `devin --help` 仅用于验证版本和参数，不执行恢复。
