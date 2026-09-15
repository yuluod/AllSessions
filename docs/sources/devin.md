# Devin 来源

AllSessions 以只读方式接入 Devin 桌面版（VS Code fork）的 ACP 会话数据。默认根目录为 Devin 用户数据目录 `Devin/User`（macOS 为 `~/Library/Application Support/Devin/User`，Windows 为 `%APPDATA%/Devin/User`，Linux 为 `~/.config/Devin/User`），也可用 `DEVIN_SESSIONS_DIR` 指定（路径列表）。

## 数据布局

- `acp-messages/<uuid>.db`：每会话一个 SQLite。`meta` 表保存元数据 JSON（标题、模式与模型等 `configOptions`），`messages` 表按 `position` 保存 ACP JSON 消息（`user_message` / `agent_message` / `agent_thought` / `tool_call` / `plan`）。
- `globalStorage/state.vscdb`：ItemTable 的 `windsurf.acp.sessioninfo.session.*` 提供明文标题、工作目录和创建/更新时间；`windsurf.acp.messageStore.session.*` 将 `acp/<connector>/<name>` 形式的会话键映射回消息库 uuid。旧版条目直接以 uuid 作为键，同样支持。

## 支持范围

- 聚合消息库与索引：标题、工作目录和时间戳优先取索引，索引缺失时回退消息库 `meta`；模型按 `configOptions` 的记录展示（如 `swe-2-high`），不推测 Provider 名称。
- 用户/助手文本、Thinking（合成上下文）、工具调用（标题、原始输入、状态与错误标记）和计划归一化为统一消息；图片以 `[image]` 占位符展示，不携带 base64。
- 按需读取单条会话详情，限制消息与原始事件数量；超过约 10k 字符的原始事件正文只保留元信息，图片 base64 不进详情。
- 内容指纹覆盖全部原始消息行，可识别原地编辑；`acp-messages/*.db`、`-wal` 或 `state.vscdb` 变化后重新读取整份聚合来源。
- 没有 messages 的库（云端会话的本地占位、未发送草稿）被排除。数据库以 SQLite 只读连接打开；AllSessions 内的收藏、标签、备注、归档和移除只写入独立的 `workspace.sqlite`，不会修改 Devin 数据。

## 不支持范围

- 云端（devin-cloud）会话：没有本地消息库，无法在本地浏览。
- 不在 AllSessions 中永久删除 Devin 原始会话或消息，也不支持直接恢复会话；需要时请回到 Devin 操作。
- 不推测缺失的时间、标题或模型；同一 uuid 同时存在新旧两版索引键时只保留一份。

如果 Devin 后续修改表结构或 JSON 字段，AllSessions 会在来源诊断中显示格式错误，而不会把不完整数据当作成功结果。
