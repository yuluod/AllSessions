# Gemini CLI 来源说明

接入 Gemini CLI 本地会话日志。默认根目录 `~/.gemini`；`GEMINI_SESSIONS_DIR`（路径列表）或设置中的来源目录可覆盖。

两类数据来源，同一会话以 `chats/` 为准：

- `tmp/**/logs.json`（顶层 JSON 数组）：旧版共享日志，同一会话可能跨多个文件，按 `sessionId` 聚合。
- `tmp/<projectHash>/chats/session-*.json[l]`（v0.61+）：会话独占文件，按上游 `chatRecordingService` 的回放规则读取——元数据行合并、`$set.messages` 检查点重建、`$rewindTo` 截断、消息按 id 原位更新。子代理会话嵌套在 `chats/<parentShortId>/` 下且不带 `session-` 前缀，不进入主会话列表。
- `chats/` 中有回放消息的会话以它为准，`logs.json` 中同一会话的贡献被丢弃，避免重复计数；同一主名的旧版 `.json` 与迁移后的 `.jsonl` 只保留 `.jsonl`。
- `antigravity/brain/<sessionId>/` 的提示与产物仍按既有规则挂接，用户消息与主记录重复时去重。
- 摘要按文件流式缓存（`chats` 文件独立缓存键），详情与搜索索引打开时重新回放；消息、Thinking、工具调用与结果统一展示。

## Token 统计

`chats/` 消息记录的 `tokens {input, output, cached, thoughts, tool}` 参与统计。口径与 Codex 一致：input 已包含 cached（扣除避免重复），tool 计入输入，thoughts 计入输出；回放收敛后每条消息只累计一次，被回退的记录不参与。`logs.json` 与 brain artifacts 不含用量，Token 保持 0。

## 兼容性边界

- `chats/` 消息不支持消息级永久删除（上游按 id 重写历史，与共享日志的记录删除语义不同）；会话级永久删除会移除对应 `chats/` 文件、被 `.jsonl` 隐藏的同主名旧版 `.json`，并清理 `logs.json` 中该会话的记录，操作前统一备份，恢复模板为 `gemini --resume <id>`，能否恢复取决于 Gemini 自己是否保留对应会话与项目数据。
- `logs.json` 消息仍支持永久删除，操作前备份。
- 旧版 `session-*.json` 与 `.jsonl` 并存时只回放 `.jsonl`，旧文件仅作为删除与备份的副本保留。
- 旧版 JSON 读取上限为 64 MiB；JSONL 单行上限为 16 MiB，回放后当前保留消息的序列化总量上限为 64 MiB。消息更新、检查点、回退及跨文件合并共用总量检查，超限时报告来源错误。

核对依据：[官方会话管理](https://geminicli.com/docs/cli/session-management/)、[v0.61.0 会话存储实现](https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/core/src/services/chatRecordingService.ts)。
