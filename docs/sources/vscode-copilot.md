# VS Code Copilot Chat 来源说明

只读接入 VS Code Copilot Chat 面板的本地会话记录。默认数据根为系统配置目录下的 `Code/User` 与 `Code - Insiders/User`（macOS `~/Library/Application Support/Code/User`，Windows `%APPDATA%\Code\User`，Linux `~/.config/Code/User`）；设置中的来源目录或 `VSCODE_COPILOT_SESSIONS_DIR`（路径列表）可覆盖，root 也可以直接指向 `workspaceStorage` 或某个 `chatSessions`/`emptyWindowChatSessions` 目录。

- 会话文件位于 `workspaceStorage/<hash>/chatSessions/<session-id>.json|.jsonl`（按工作区保存，同级 `workspace.json` 的 `folder`/`workspace` URI 给出项目目录）与 `globalStorage/emptyWindowChatSessions/<session-id>.json|.jsonl`（空窗口会话，无工作区映射）。
- `.json` 是 1.109 之前的平铺 JSON 文档（version 3）；`.jsonl` 是 1.109 起的追加日志（首条完整快照，之后为 set/push/delete 增量），同一 id 两者并存时以 `.jsonl` 为准。快照没有 `lastMessageDate`，改取各 request 的 `timestamp`/`responseTimestamp` 最大值。
- 没有 `workspace.json` 时（空窗口会话、`.jsonl` 快照）用会话内的 `workingDirectory` URI 兜底；`vscode-remote://` 等非本地工作区保留完整 URI 作为目录，避免与本地同名路径混淆。
- `requests[]` 还原为对话：`response` 中连续的 markdown 正文片段与内联文件引用（inlineReference）合并为一条回复，Thinking、进度消息、工具调用、`textEditGroup` 文件编辑和 `result.errorDetails` 请求错误各自成条；标题优先 `customTitle`，模型名进入搜索文本，provider 记为 `github`。
- VS Code 打开聊天面板就会生成空会话文件，没有消息的占位会话不进入列表。
- 会话文件变化实时刷新；`workspace.json` 变化触发全量刷新并按目录失效摘要缓存（cwd 不在事件文件指纹内）。
- 侧栏与统计页归入 GitHub Copilot 入口，设置页有独立开关。

## 不支持

永久删除原始数据，也不支持在系统终端恢复会话。
