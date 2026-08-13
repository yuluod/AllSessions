# Codex Provider 可见性修复

[English](./codex-provider-repair.md)

AllSessions 包含一个可选维护工具，用于处理切换第三方模型 Provider 后不可见的 Codex 历史。该流程由 Rust 实现，与普通只读浏览隔离。

## 安全边界

- 维护模式默认关闭，关闭时预览、执行和回滚都会被拒绝。
- 只处理用户明确选择的第三方 Provider，只修改 SQLite 与 JSONL 中的 `model_provider`。
- 从 `config.toml` 只读获取当前 Provider，不修改配置文件。
- 内置 Provider、`custom` 和当前目标 Provider 不能作为迁移来源。
- 执行与回滚要求确认 Codex App 已退出，并检查正在运行的 Codex 进程。
- 预览指纹覆盖配置、数据库 Provider 行和 JSONL 文件；数据变化后旧计划失效。
- 写入前使用 SQLite Backup API 和文件副本创建备份；失败会自动按字段回滚。
- 手动回滚只恢复受影响的 Provider 字段，保留之后新增的线程、归档状态和 JSONL 消息。
- Rust 版本可回滚当前 v4 备份，也兼容 v0.0.8 生成的 v3 字段级备份。

## 页面操作

1. 启动 AllSessions，进入「工具」。
2. 打开维护模式开关。
3. 执行只读预览并检查候选 Provider 与阻断项。
4. 明确选择来源 Provider，再次生成精确计划。
5. 核对数据库线程数、JSONL 文件数和替换数。
6. 完全退出 Codex App并确认。
7. 执行；需要时使用页面显示的备份目录回滚。
8. 完成后关闭维护模式。

前后端通过 Tauri IPC 通信，不存在 HTTP 写入令牌或浏览器接口。维护开关只保存在当前应用进程中，重启后恢复关闭。

## 备份

备份保存在：

```text
~/.codex/backups/codex-history-provider-rebucket-v2/
```

目录名中的 `v2` 为兼容历史路径而保留；当前元数据版本为 v4。备份包含 Provider 清单、受影响数据库快照和 JSONL 文件副本，应视为敏感本地数据。

## 不会执行的操作

- 不永久合并所有 Provider，也不改变未来切换 Provider 的行为。
- 不修改 `config.toml`、第三方 Agent 数据或第三方工具。
- 不取消归档，也不让 Codex App 显示 subagent 会话。
- 不让历史在所有 Provider 下同时可见；再次切换后可能需要重新修复。
