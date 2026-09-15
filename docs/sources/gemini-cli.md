# Gemini CLI 来源说明

只读接入 Gemini CLI 本地会话日志。默认根目录 `~/.gemini`；`GEMINI_SESSIONS_DIR`（路径列表）或设置中的来源目录可覆盖。

- 会话日志为 `tmp/**/logs.json`（顶层 JSON 数组），同一会话可能跨多个文件，按 `sessionId` 聚合。
- 摘要按日志文件流式缓存，详情打开时重新流式读取；用户/助手消息、Thinking、工具调用与结果统一展示。

## 不支持

永久删除原始数据与恢复会话。
