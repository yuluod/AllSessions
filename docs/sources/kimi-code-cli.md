# Kimi Code CLI 来源说明

AllSessions 根据 Kimi Code CLI 官方会话与 Wire 实现独立解析本地记录，不复用第三方项目代码。

## 数据位置与格式

- 默认数据根目录：`~/.kimi`
- 自定义根目录：设置中的来源目录、`KIMI_SESSIONS_DIR`，或 Kimi 官方的 `KIMI_SHARE_DIR`
- 会话事件流：`sessions/<work-dir-hash>/<session-id>/wire.jsonl`
- 会话标题：相邻的 `state.json`
- 工作目录映射：根目录 `kimi.json`
- 子 Agent：会话目录下的 `subagents/...`

## 当前支持

适配器读取完整 `wire.jsonl` 事件流，而不是可能在上下文压缩后丢失旧内容的 `context.jsonl`。当前支持用户输入、助手文本与 Thinking、媒体占位、工具调用与结果、流式片段合并、自定义标题、工作目录映射、子 Agent、搜索、原始事件与文件监听。Kimi CLI 可配置不同模型 Provider；Wire 未提供 Provider 时，AllSessions 显示为 unknown，不根据产品名称推断。

Kimi Code CLI 在当前版本中是只读来源。AllSessions 的收藏、标签、备注、归档和软移除仍可使用；永久删除原始会话或消息需在 Kimi Code CLI 中完成。

官方实现参考：

- <https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/session.py>
- <https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/metadata.py>
- <https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/wire/file.py>
- <https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/wire/types.py>
