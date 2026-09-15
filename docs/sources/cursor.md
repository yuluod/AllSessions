# Cursor 来源

只读接入 Cursor 桌面版会话。默认根目录为用户数据目录 `Cursor/User`（macOS `~/Library/Application Support/Cursor/User`，Windows `%APPDATA%/Cursor/User`，Linux `~/.config/Cursor/User`）与 `~/.cursor/projects`。无环境变量，只能通过设置中的来源目录覆盖；根目录可指向用户数据目录、单个 `state.vscdb` 文件或含 Agent 转录的目录。

- `state.vscdb` 存会话元数据与正文引用，`workspaceStorage/` 提供目录关联，`agent-transcripts/*.jsonl` 为新版 Agent 转录；兼容历史上几种正文存放形态。
- 消息归一化为用户/助手文本、Thinking 与工具调用；有元数据但无可读正文的记录计入「暂不支持」诊断，不作扫描错误。

## 不支持

`store.db` 等其他数据文件；永久删除原始数据与恢复会话。格式不兼容时记入来源诊断，不当作成功结果。
