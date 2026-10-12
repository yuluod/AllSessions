# Claude Cowork 本地来源

只读读取 Claude Desktop 的 Cowork 本地任务。macOS 默认发现 `~/Library/Application Support/Claude/local-agent-mode-sessions` 和 `Claude-3p/local-agent-mode-sessions`；Windows 发现 `%APPDATA%` 下的对应目录，以及官方包安装的 `LocalCache/Roaming/Claude`。设置或 `CLAUDE_COWORK_SESSIONS_DIR` 路径列表可覆盖默认目录，也可指定包含 `local-agent-mode-sessions` 的 Desktop 数据根。

- 只发现 `<账户>/<组织>/<任务>/.claude/projects/<项目>/<会话>.jsonl`，复用 Claude Code 正文、Thinking、工具及首尾窗口解析。不扫描插件、上传文件或审计日志为聊天记录，不跟随符号链接。
- 按同组织目录中 `local_*.json` 的 `cliSessionId` 关联标题、时间、模型、Desktop 会话编号与所选主机目录。元数据缺失时保留转录信息，不猜测主机目录。
- 原转录工作目录单独保留为 `sandbox_cwd`。只有一个所选主机目录时才作为列表项目目录；多个目录保留为 `host_directories`，不任意指定主目录。
- 支持浏览、全文搜索、实时刷新、导出及 AllSessions 内的收藏、标签、备注和本地移除。禁止永久删除原始数据；不使用 CLI 恢复 Cowork 任务。
- Desktop 归档状态单独保留，不覆盖 AllSessions 自身的本地归档状态。来源使用独立的 `claude_cowork` 键，Agent 统计归入 Claude。
- Thinking 正文沿用「显示上下文」开关，默认折叠。审计中的高频 `thinking_tokens` 进度不会变成消息，也不与正文重复累计。未接入审计链验证、审计专属记录及 usage-ledger 费用。

本机 Claude Desktop 2.31226.1 的一份真实 Cowork 转录已通过适配器只读验证，共 454 条逻辑消息；不提交真实会话样本。另用虚构任务验证元数据关联、工具、Thinking、搜索、刷新及只读限制。仅验证上述本地转录布局，不读取云端会话；仅有 `audit.jsonl` 的任务尚未支持。
