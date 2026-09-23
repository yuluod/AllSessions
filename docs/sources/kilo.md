# Kilo 来源

AllSessions 只读扫描 Kilo 正式通道的 SQLite 会话数据库，默认路径为 `~/.local/share/kilo/kilo.db`。可在来源设置中指定数据库，也可通过 `KILO_DB` 指定路径；相对路径基于 Kilo 数据目录解析。

当前适配 Kilo 与 OpenCode 共享的 `session`、`message`、`part` 表投影。会话标识使用 `kilo:<id>`，与 OpenCode 区分。支持正文、Thinking、工具调用、原始事件、搜索、子 Agent 识别及数据库和 WAL 变化后的刷新。详情按会话读取，消息和事件受统一上限约束。

来源以 SQLite 只读方式打开；收藏、标签、备注与本地移除保存在 AllSessions 工作区数据库中。不会删除或修改 Kilo 原始记录。

默认不扫描 Kilo 旧版 VS Code 扩展任务存储或开发频道数据库。数据库结构发生不兼容变化时，来源诊断会报告读取错误。
