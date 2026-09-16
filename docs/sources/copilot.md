# GitHub Copilot 来源说明

只读接入 GitHub Copilot CLI 本地会话记录。默认根目录 `~/.copilot/session-state`；设置中的来源目录或 `COPILOT_SESSIONS_DIR` 可覆盖。

- 每个会话一个目录 `<session-id>/`，内含 `events.jsonl` 事件流与 `workspace.yaml` 元数据；发现规则只匹配会话目录下的 `events.jsonl`，`checkpoints/` 等子目录不算。
- 会话 ID 依次取 `session.start` 的 `sessionId`、`workspace.yaml` 的 `id`、目录名；工作目录取 `workspace.yaml` 的 `cwd`/`git_root` 或 `session.start` 的 `context.cwd`/`gitRoot`。
- 标题优先用 `workspace.yaml` 的 `name`（用户命名），其次 `summary`（Copilot 生成），最后回退到首条用户消息。
- `user.message`/`assistant.message` 还原为对话；`reasoningText` 作为思考上下文；`toolRequests` 与 `tool.execution_start` 描述同一次调用时去重；`tool.execution_complete` 不携带工具名，经 `toolCallId` 映射回 `execution_start`/`toolRequests` 记录的名字；`session.task_complete` 摘要作为上下文展示；损坏单行跳过并在原始事件中标记。
- `workspace.yaml` 变化会触发全量刷新（标题/工作目录可能更新），其指纹不参与摘要缓存。

## 不支持

永久删除原始数据。恢复会话通过 `copilot --resume <session-id>` 在系统终端中执行。
