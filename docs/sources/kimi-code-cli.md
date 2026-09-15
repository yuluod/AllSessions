# Kimi Code CLI 来源说明

只读接入 Kimi Code CLI 本地记录，根据官方会话与 Wire 实现独立解析。默认根目录 `~/.kimi`；设置中的来源目录、`KIMI_SESSIONS_DIR` 或 Kimi 官方的 `KIMI_SHARE_DIR` 可覆盖。

- 事件流为 `sessions/<work-dir-hash>/<session-id>/wire.jsonl`（读取完整流，不用可能因压缩丢失旧内容的 `context.jsonl`）；标题来自相邻 `state.json`，工作目录映射来自根目录 `kimi.json`，子 Agent 在 `subagents/` 下。
- 用户输入、助手文本与 Thinking、媒体占位、工具调用与结果、流式片段合并统一展示；Wire 未提供 Provider 时显示 unknown，不按产品名推断。

## 不支持

永久删除原始数据与恢复会话。

官方实现参考：

- <https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/session.py>
- <https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/metadata.py>
- <https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/wire/file.py>
- <https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/wire/types.py>
