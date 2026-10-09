# Grok Build 来源说明

只读接入 xAI 官方 Grok Build 的本地会话，不连接云端 API，不启动 Grok 进程扫描。

- 默认根为 `~/.grok/sessions`；官方 `GROK_HOME` 替换 `.grok` 数据根。设置中的来源目录优先，其次为 `GROK_SESSIONS_DIR` 路径列表。显式根可指向 `.grok` 或其 `sessions`，扫描和监听限定在 `sessions` 内。
- 精确发现 `<编码后的工作目录>/<会话 id>/updates.jsonl`，不跟随符号链接。`chat_history.jsonl`、检查点和其他日志不作为重复会话。
- `summary.json` 提供真实会话 ID、工作目录、标题、时间与模型。标题优先取 `generated_title`，其次 `session_summary`；元数据缺失时使用目录 ID 和首条用户消息，不推测工作目录。
- 读取 ACP `session/update` 和 xAI `_x.ai/session/update` 封装，兼容旧版未封装的 ACP 通知。展示历史以 `updates.jsonl` 为准，不用可能因压缩丢失历史的模型上下文。
- 合并流式正文及 Thinking，媒体使用占位。工具调用与更新按 `toolCallId` 合并，完成或失败时展示最终结果，不重复累计中间输出。
- 按官方用户轮次规则处理 `rewind_marker`，撤回分支不进入正文和搜索；原始事件仍保留撤回记录。压缩检查点保留在原始事件中，不加载外置检查点正文。
- 依据 `hidden` 显式值及 `session_kind` 的 `subagent` 前缀识别隐藏会话；普通 fork 和 headless 会话保持可见，父会话标识单独保留。
- 先归约有效事件与逻辑消息位置，再读取正文。详情沿用统一首尾窗口；单条流式正文最多收集 64,000 字节，详情继续应用统一 20,000 字符上限，截断时保留标记。
- 支持收藏、标签、备注、本地归档/移除、搜索和导出；事件变更及 `summary.json` 标题、目录或可见性变更均触发刷新。

恢复命令为 `grok --resume <id>`，在会话工作目录打开系统终端。自定义数据根需同时配置给 Grok；未执行真实终端恢复。

不提供永久删除来源数据、云端会话下载、外置媒体/终端日志加载或 Token/费用汇总。Grok 支持自定义模型和本地推理，因此仅有模型名称时 Provider 保持 `unknown`。

验证使用人工构造的官方格式样本，覆盖回放、工具失败、回退、搜索、元数据刷新、旧封装、子代理、只读限制与长会话截断。

核对版本固定为官方源码提交 `2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8`：[会话指南](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/docs/user-guide/17-sessions.md)、[封装与回退规则](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/session/storage/mod.rs)、[工具回放](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/session/storage/replay.rs)、[摘要与可见性](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/session/persistence.rs)。
