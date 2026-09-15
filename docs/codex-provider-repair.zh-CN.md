# Codex Provider 可见性修复

AllSessions 包含一个可选维护工具，用于处理切换第三方模型 Provider 后不可见的 Codex 历史。该流程由 Rust 实现，与普通只读浏览隔离。

## 安全边界

- 维护模式默认关闭，关闭时预览、执行和回滚都会被拒绝；开关只保存在当前应用进程中，重启后恢复关闭。
- 只处理用户明确选择的第三方 Provider，只修改 SQLite 与 JSONL 中的 `model_provider`；内置 Provider、`custom` 和当前目标不能作为来源。
- 从 `config.toml` 只读获取当前 Provider，不修改配置文件。
- 执行与回滚要求确认 Codex App 已退出，并检查正在运行的 Codex 进程。
- 预览指纹覆盖配置、数据库 Provider 行和 JSONL 文件；数据变化后旧计划失效。
- 写入前使用 SQLite Backup API 和文件副本创建备份，失败自动按字段回滚；手动回滚只恢复 Provider 字段，保留之后新增的线程、归档和消息。支持当前 v4 备份与 v0.0.8 的 v3 字段级备份。

## 页面操作

1. 进入「工具」并打开维护模式。
2. 点击「扫描历史 Provider」，检查候选与阻断项。
3. 明确选择来源 Provider，点击「重新生成修复计划」并核对线程、文件和替换数。
4. 完全退出 Codex App，在共享安全确认区勾选后执行。
5. 需要时使用页面显示的备份目录回滚；完成后关闭维护模式。

前后端通过 Tauri IPC 通信，不存在 HTTP 写入接口。

备份保存在 `~/.codex/backups/codex-history-provider-rebucket-v2/`——`v2` 目录名为兼容历史路径保留，当前元数据为 v4；备份应视为敏感本地数据。

该工具不永久合并 Provider，不修改 `config.toml` 或第三方数据，不取消归档，也不让历史在所有 Provider 下同时可见；再次切换 Provider 后可能需要重新修复。
