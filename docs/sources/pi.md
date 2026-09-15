# Pi 来源说明

只读接入 Pi 本地会话记录，根据官方 Session File Format 独立解析。默认根目录 `~/.pi/agent/sessions`；设置中的来源目录、`PI_SESSIONS_DIR` 或 Pi 官方的 `PI_CODING_AGENT_SESSION_DIR` / `PI_CODING_AGENT_DIR` 可覆盖。

- 会话文件为目录下 JSONL（v1-v3），条目以 `id`/`parentId` 成树；从最后活动叶节点回溯重建当前分支，废弃分支不展示。
- 用户/助手消息、Thinking、工具调用与结果、bash 执行、压缩/分支摘要、扩展上下文、会话名称统一展示；损坏单行跳过并在原始事件中标记。

## 不支持

永久删除原始数据与恢复会话。

官方格式参考：<https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md>
