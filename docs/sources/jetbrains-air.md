# JetBrains Air 来源说明

只读接入 JetBrains Air in IDEs（IDE 内置或插件安装的 Agent 工作区）持久化的 ACP 线程历史，不连接 IDE、不启动 agent 进程。同一来源目录可包含多个 ACP agent 的线程，来源统一归为 `jetbrains_air`，agent 身份经 `agentId` 解码后进入 `originator` 字段（如 `acp.dynamic.<hex>` → `acp.registry.devin`）。

## 数据布局

线程历史由 IDE 侧持久化，位于各产品的 IDE system/本地目录下：

- Windows：`%LOCALAPPDATA%\JetBrains\<产品版本>\acp`
- macOS：`~/Library/Caches/JetBrains/<产品版本>/acp`
- Linux：`~/.cache/JetBrains/<产品版本>/acp`

默认枚举同时覆盖数据目录侧（macOS `~/Library/Application Support`、Linux `~/.local/share`）的 `JetBrains/<产品版本>/acp`，兼容可能写在配置目录的布局。

每个 `acp` 目录即一个来源根，结构为：

```
acp/
└── projects/<projectHash>/
    ├── store.json              # {"projectDirectory": "..."}
    └── threads/<urlencode(threadId)>/
        ├── events.jsonl        # ACP 事件流（核心数据）
        ├── summary.json        # 线程级标题/运行时元数据
        └── attachments/        # 提示词附件副本（截图等）
```

默认根枚举 JetBrains 本地数据目录下已存在的 `<产品版本>/acp`，覆盖 IntelliJ IDEA 等全部产品；设置中的来源目录优先，其次为 `JETBRAINS_AIR_SESSIONS_DIR` 路径列表。精确发现 `projects/<hash>/threads/<id>/events.jsonl`，不跟随符号链接；`air/` 插件运行时目录不作为会话数据。

## 归约规则

`events.jsonl` 每行一条事件（`{id, threadId, seq, timestamp, source, type, payload, turnId?}`），逐行解析；存在损坏行时该线程解析失败并计入诊断，不影响其他线程与来源：

- `ThreadCreated` 提供工作目录、`runtimeKind` 与 `agentId`；`cwd` 缺失时回退到项目 `store.json` 的 `projectDirectory`。
- `ThreadUpdated` 与 `summary.json` 的 `displayTitle`/`automaticTitle` 共同决定标题，IDE 端显式标题优先。
- `MessageDelta`/`MessageCompleted` 按 `messageId` 归并用户消息；`contextItems` 与 `attachments` 中的非图片上下文以原文附加，图片经线程 `attachments/` 副本按需读取，正文保留 `[image]` 占位。
- `PromptRetryRequestUpdated` 在无同名 `messageId` 增量时产出重试用户消息，避免重复。
- `MessageChunk` 按角色合并流式正文：`Agent` 为助手正文，`Runtime` 为 Thinking（合成消息）。
- `ToolCallUpdated` 按 `toolCallId` 归并并遵循 ACP 替换语义；完成或失败时展示最终结果，不重复累计中间输出。工具名取 `toolCallId` 冒号前缀，并剥除 `exec-<uuid>`、`call_<hex>` 这类随机后缀段，保证工具排行稳定归一。
- `PromptTurnFinished` 记录逐轮 Token 用量（含缓存读写）；`UsageUpdated` 等累计快照不重复计入账本。
- `ConfigOptionUpdated` 的 `model` 选项提供当前模型；`RuntimeSessionBound` 的 `agentSessionId`（agent 原生会话标识）保留在摘要中，便于与 agent 原生来源对照。
- 审批、计划更新、连接状态等事件保留在原始事件中，不生成普通对话消息；`ThreadFailed`/带说明的断开事件生成为错误标记消息。
- 无任何消息事件的线程不进列表；`_key` 为 `jetbrains_air:<项目哈希>/<线程 id>`，跨产品目录不会冲突。

摘要指纹同时覆盖 `events.jsonl` 与相邻 `summary.json`/`store.json`，元数据变更触发增量重解析。

## 边界

支持收藏、标签、备注、本地归档/移除、搜索和导出。来源只读：不提供永久删除原始数据、会话恢复（IDE 内线程无外部恢复命令）、远程 URL 附件加载或写回。同一 Devin/CLI 会话可能同时以 agent 原生来源与 Air 线程出现，当前两版并存不做去重。Air 驱动多种 ACP agent，无法确定统一 Provider，摘要 `model_provider` 保持 `unknown`。

验证使用人工构造的官方格式样本，覆盖摘要归并、流式正文、工具更新、重试请求、空线程过滤、损坏行、附件回读与路径约束。

数据布局以本机 IntelliJ IDEA 2026.3 实际数据核对；协议行为见 [JetBrains ACP 文档](https://www.jetbrains.com/help/ai-assistant/acp.html) 与 [Air in IDEs 文档](https://www.jetbrains.com/help/air/air-in-ides-overview.html)。
