# OpenCode 来源

AllSessions 当前只读兼容实现时的 OpenCode 最新正式版 `v1.18.23` 所使用的 SQLite 会话格式。默认数据库为 `~/.local/share/opencode/opencode.db`，也会读取 OpenCode 官方的 `OPENCODE_DB` 环境变量。

## 支持范围

- 从 `session`、`message`、`part` 表聚合会话，不重复读取兼容投影之外的内部表。
- 展示用户与助手文本、Thinking、文件占位、工具输入/结果和错误。
- 使用 `parent_id` 识别并默认隐藏 Task 子 Agent 会话；普通 fork 不会被误判为子 Agent。
- 按需读取单条会话详情，并限制消息、原始事件和单条文本大小。
- 监听数据库本体及 SQLite 的 `-wal`、`-shm` 变化，变化后重新读取整份聚合来源。
- 数据库以 SQLite 只读连接打开。AllSessions 内的收藏、标签、备注、归档和移除只写入独立的 `workspace.sqlite`，不会修改 OpenCode 数据。

## 不支持范围

- 不兼容 OpenCode 旧版 JSON 会话存储。
- 不兼容开发、预览频道生成的带频道名数据库。
- 不在 AllSessions 中永久删除 OpenCode 原始会话或消息；需要删除时请回到 OpenCode 操作。

如果 OpenCode 后续修改数据库表或 JSON 字段结构，AllSessions 会在来源诊断中显示格式错误，而不会把不完整数据当作成功结果。
