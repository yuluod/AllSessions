# Kimi Code CLI 来源说明

只读接入新版 Node.js Kimi Code 与旧版 Python Kimi CLI 本地记录，根据官方会话与 Wire 实现独立解析。

- 默认依次扫描 `~/.kimi-code` 和 `~/.kimi`；`KIMI_CODE_HOME` 与 `KIMI_SHARE_DIR` 分别替换对应数据根。
- 设置中的来源目录优先，其次为 `KIMI_SESSIONS_DIR` 路径列表；这两种显式配置会覆盖整个默认列表。根也可直接指向 `sessions`。

## 旧版 Python 布局

- 事件流为 `sessions/<work-dir-hash>/<session-id>/wire.jsonl`（读取完整流，不用可能因压缩丢失旧内容的 `context.jsonl`）；标题来自相邻 `state.json`，工作目录映射来自根目录 `kimi.json`，子 Agent 在 `subagents/` 下。
- 用户输入、助手文本与 Thinking、媒体占位、工具调用与结果、流式片段合并统一展示；Wire 未提供 Provider 时显示 unknown，不按产品名推断。

## 不支持

永久删除原始数据。已有恢复模板为 `kimi --resume <id>`，需要本机 Kimi 版本能找到该会话。

## 新版 Node.js 布局

主事件流位于 `sessions/<workDirKey>/<sessionId>/agents/main/wire.jsonl`。标题来自会话级 `state.json`；目录优先取其 `cwd` / `workDir`，缺失时查 `session_index.jsonl` 的 `sessionId` / `workDir`。`agents/<其他名称>` 为子代理，使用独立标识并默认隐藏。元数据文件变化会重新扫描并更新详情缓存与搜索。

- 支持 Wire `1.0`–`1.5` 的顶层事件及毫秒时间戳，覆盖完整消息、流式正文、Thinking、媒体占位、工具调用与结果；Provider 从 `llm.request` 读取。
- 按官方转录语义处理 `context.undo`：撤回指定数量的用户轮次，移除对应回复与附带注入内容；压缩、清空上下文保留此前历史，构成撤回边界。原始事件仍保留撤回记录。
- 先扫描事件位置与撤回关系，再按有效消息位置读取正文；不把整份会话正文缓存到内存，详情继续使用统一首尾窗口。
- 官方迁移记录的 `custom.imported_from_kimi_cli` 与 `custom.kimi_cli_session_id` 用于沿用旧 AllSessions 工作区键，保留收藏与备注。默认新版根排在前面，因此新旧副本只展示新版；自定义多根仍遵循首个根优先。恢复命令使用新版真实会话 ID。

当前没有安装新版 Kimi 进行真实终端恢复；`kimi --resume <id>` 保留官方兼容参数。自定义数据根需同时配置给 Kimi。只展示 Wire 内可读取内容，不加载外置媒体，不汇总新版用量，不支持其他存储引擎的 `trees/` 布局；未知 Wire 协议版本报告读取错误。

验证使用一份人工构造的新版会话，覆盖摘要、详情、导出遍历、流式合并、工具结果、撤回、压缩/清空边界、元数据刷新、子代理和迁移去重；既有旧版样本继续通过。

核对依据：[迁移说明](https://moonshotai.github.io/kimi-code/en/guides/migration.html)、[会话布局](https://moonshotai.github.io/kimi-code/en/guides/sessions.html)、[新版 Wire 契约](https://github.com/MoonshotAI/kimi-code/blob/main/packages/agent-core-v2/docs/wire-manifest.d.ts)。

转录语义依据：[contextTranscript.ts](https://github.com/MoonshotAI/kimi-code/blob/main/packages/agent-core-v2/src/agent/contextMemory/contextTranscript.ts)、[loopEventFold.ts](https://github.com/MoonshotAI/kimi-code/blob/main/packages/agent-core-v2/src/agent/contextMemory/loopEventFold.ts)。迁移标识依据：[state-writer.ts](https://github.com/MoonshotAI/kimi-code/blob/main/packages/migration-legacy/src/sessions/state-writer.ts)。

官方实现参考：

- <https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/session.py>
- <https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/metadata.py>
- <https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/wire/file.py>
- <https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/wire/types.py>
