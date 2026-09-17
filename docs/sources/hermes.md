# Hermes Agent 来源说明

只读接入 Nous Research [Hermes Agent](https://hermes-agent.nousresearch.com/) 的本地会话记录。默认数据根：macOS/Linux 为 `~/.hermes`，Windows 为 `%LOCALAPPDATA%\hermes`（即 Hermes 官方的 `get_hermes_home()` 平台默认值）；设置中的来源目录或 `HERMES_SESSIONS_DIR` 可覆盖，`HERMES_HOME` 遵循 Hermes 自身的解析规则（官方变量，优先级高于平台默认）。

- 每个数据根解析为多个 `state.db` 聚合库：主库 `<root>/state.db`，命名 profile 各自的 `<root>/profiles/<name>/state.db`；root 也可以直接指向某个 `state.db` 文件。库文件不存在（如刚安装）时静默跳过。
- `sessions` 表提供元数据：`title` 优先作为标题（缺失时回退首条用户消息），`cwd`/`git_branch`/`git_repo_root` 提供工作目录与搜索文本，`model`（形如 `anthropic/claude-*`）拆出 provider；时间戳为 Unix epoch 浮点，统一转 ISO 8601。
- `messages` 表按 `(timestamp, id)` 还原对话：`user`/`assistant` 为正文，`reasoning`（缺失时回退 `reasoning_content`）作为思考上下文，`content` 为空时回退解析 `codex_message_items`（Codex Responses 投影），`tool_calls`（OpenAI 风格，兼容扁平形式）转工具调用，`tool` 行经 `tool_call_id` 映射回工具名作为工具结果。
- 官方 schema_version 已到 30 且列集随版本增减，查询按 `pragma table_info` 现存列自适应，缺失列以 null 占位，旧库与新库共用同一解析路径。
- 就地压缩语义：旧消息行标 `active=0` 归档、保留上下文重新插入 `active=1`，只读取 active 行，避免同一条消息出现两代。
- 委托子代理会话（`source='subagent'` 或 `model_config` 带 `$._delegate_from` 标记）不进列表；压缩分裂产生的 `parent_session_id` 链不合并，每代都是独立会话。
- 任一 `state.db`、`state.db-wal` 或 profile 库变化时全量刷新该聚合来源；`-shm` 变化不触发。

## 不支持

永久删除原始数据。恢复会话通过 `hermes --resume <session-id>` 在系统终端中执行。
