# Gemini CLI 来源说明

接入 Gemini CLI 旧版本地会话日志。默认根目录 `~/.gemini`；`GEMINI_SESSIONS_DIR`（路径列表）或设置中的来源目录可覆盖。

- 会话日志为 `tmp/**/logs.json`（顶层 JSON 数组），同一会话可能跨多个文件，按 `sessionId` 聚合。
- 摘要按日志文件流式缓存，详情打开时重新流式读取；用户/助手消息、Thinking、工具调用与结果统一展示。

## 兼容性边界

- 当前没有读取 `tmp/<project>/chats/session-*.json` 或 `.jsonl` 完整会话。仅看到 `logs.json` 的记录不代表已读取完整对话。
- 官方 `v0.61.0` 已使用 JSONL，并在恢复旧 JSON 会话时迁移。适配需处理消息补丁、回退与元数据更新，以及同一会话的新旧文件去重，不能只增加文件匹配。
- 已有日志支持永久删除，操作前备份；恢复模板为 `gemini --resume <id>`，能否恢复取决于 Gemini 自己是否保留对应会话与项目数据。

核对依据：[官方会话管理](https://geminicli.com/docs/cli/session-management/)、[v0.61.0 会话存储实现](https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/core/src/services/chatRecordingService.ts)。
