# Devin 来源

只读接入 Devin 桌面版（VS Code fork）与 CLI 会话，共用 `devin` 来源。默认根目录为桌面版 `Devin/User`（macOS `~/Library/Application Support/Devin/User`，Windows `%APPDATA%/Devin/User`，Linux `~/.config/Devin/User`）与 CLI `devin/cli`（默认 `~/.local/share/devin/cli`，Windows `%LOCALAPPDATA%/devin/cli`）。可用 `DEVIN_SESSIONS_DIR`（路径列表）或设置中的来源目录覆盖；根目录可指向 `devin/cli` 目录、`devin` 数据根或 `sessions.db` 文件。

- 桌面版：`acp-messages/` 下每会话一个消息库，`state.vscdb` 提供标题/目录/时间索引；CLI：`sessions.db` 聚合库，消息树按当前活动分支重建，废弃分支不展示。
- 用户/助手文本、Thinking、工具调用与计划统一展示；桌面版镜像的 CLI 会话与 CLI 库自动去重，冲突时以 CLI 为准。
- 无有效消息的库（云端占位、未发送草稿）与 CLI 隐藏会话被排除；任一消息库、索引库或 `sessions.db` 变化后整源刷新。

## 不支持

云端（devin-cloud）会话无本地数据；CLI 子代理链节点不单列为会话；不支持永久删除原始数据或恢复会话。格式不兼容时记入来源诊断，不当作成功结果。
