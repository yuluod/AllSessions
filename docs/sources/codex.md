# Codex 来源说明

接入 Codex 本地 rollout 会话。默认根目录为 `~/.codex/sessions`，归档来源为 `~/.codex/archived_sessions`；`CODEX_HOME`、`CODEX_SESSIONS_DIR`（路径列表）和 `CODEX_ARCHIVED_SESSIONS_DIR`（路径列表）可覆盖。

- 会话文件为按日期分层的 `rollout-*.jsonl`。Codex 会把历史 rollout 压缩为 `rollout-*.jsonl.zst`；两种格式都会发现，压缩文件按 zstd 流式读取，不把完整会话装入内存。同一会话同时存在两种文件时优先未压缩副本。
- `session_meta` 提供会话 ID、工作目录、Provider、originator 与模型；`turn_context` 更新当前模型；`event_msg/token_count` 的累计快照用于 Token 用量，按事件日期归属并扣除缓存读取。
- `response_item` 中的消息、Thinking、函数调用与结果、`custom_tool_call`/`custom_tool_call_output` 归一化为统一消息；Codex 的 `exec` 调用从 JavaScript 参数中的 `cmd`/`command` 提取命令首词。`item_completed`、`token_usage_record` 当前不单独归一化，Token 总量仍以 `token_count` 为准。
- 归档来源使用独立的 `codex_archived` 标识，支持浏览、搜索和永久删除归档会话；不会移动文件或恢复归档状态。普通与归档来源都支持实时刷新、全文搜索、图片附件和终端恢复 `codex resume <id>`。
- 压缩 rollout 解码后每行最多读取 32 MiB。超限时停止读取并报告错误。
- 永久删除会话前会备份对应 rollout。同名的未压缩与压缩副本若会话 ID 相同，会一并备份、删除。未压缩会话支持永久删除单条消息，压缩会话中的单条消息可以从 AllSessions 本地移除。
