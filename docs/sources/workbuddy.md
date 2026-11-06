# WorkBuddy 来源说明

只读接入腾讯 WorkBuddy 桌面版（AI 办公智能体，与 CodeBuddy 同底座）的本地会话，不连接云端 API，不启动 WorkBuddy 进程。

- 默认根为 `~/.workbuddy`；官方 `WORKBUDDY_HOME` 替换数据根。设置中的来源目录优先，其次为 `WORKBUDDY_SESSIONS_DIR` 路径列表。显式根可指向 `~/.workbuddy` 或其 `projects` 子目录，扫描和监听限定在 `projects` 内。
- 会话布局为 `projects/<工作区 slug>/<会话 id>.jsonl`，会话 ID 即文件名。精确发现两层结构，不跟随符号链接；相邻的 `<会话 id>.file-rollback.ndjson`（文件快照引用）、`traces/` 下的 OTel 追踪日志以及 `workbuddy.db` 索引库都不是会话事件流，不参与解析。正文 JSONL 自足，不读取 `workbuddy.db`（该库是客户端索引层，社区报告过索引缺失但正文存在的"孤儿会话"；以正文为准可避免漏扫）。
- 事件文件是追加写入的 JSONL，逐行流式解析。行 `type` 分五类：`message`（`input_text`/`output_text` 内容块）、`reasoning`（思考正文在 `rawContent`，`content` 数组为空）、`function_call`/`function_call_result`（工具调用与结果，`callId` 关联）、`ai-title`（AI 生成标题）。`session-meta` 与 `file-history-snapshot` 只保留在原始事件中。
- 用户消息正文由注入上下文（system-reminder 包裹的环境、身份与项目上下文）包裹，真实提问位于 `<user_query>` 标签内：提取标签内容作为用户消息，提取不到的纯注入行按合成上下文处理，不计入用户消息与搜索正文。
- 标题取最后的 `ai-title` 事件，缺失时回退首条用户提问；模型名取 `providerData.model`（如 `deepseek-v4.1-flash`），provider 不做推断。
- 用量逐次记录在 `message`（assistant）与 `function_call` 行的 `providerData.rawUsage`，按 `providerData.messageId` 去重累加（流式重放同一调用不会重复计数；`reasoning` 行复用所属消息的 messageId 但不带用量）。input 为 `prompt_tokens` 去缓存命中，缓存读取取 `prompt_cache_hit_tokens`，缓存写入取 `cache_creation_input_tokens`，输出取 `completion_tokens`；`credit` 积分当前不进入用量账本。
- 图片不写入事件行：正文块 `image_blob_ref` 携带 `blob_id`（sha256）与 `blob_path`，正文保留 `[image]` 占位。按需回读时按行号与记录指纹校验后，只取 `blob_path` 的文件名部分并以 blob_id 前缀约束，从声明根的 `blobs/<id 前两位>/<sha256>.<扩展名>` 内容寻址副本读取；不信任记录中的绝对路径，副本缺失或指纹变化时返回明确错误。
- 新建工作区后未发送提问的会话只有元数据行，作为空占位会话不进入列表；详情沿用统一首尾窗口与单条 20,000 字符上限，截断时保留标记；单条原始事件超过 10,000 字符时只保留长度。
- 支持收藏、标签、备注、本地归档/移除、搜索和导出；事件文件变更触发增量刷新。

WorkBuddy 为桌面应用，没有命令行恢复入口，本来源不提供恢复命令。

不提供永久删除来源数据、读取 `workbuddy.db` 的用户自定义标题（`custom_title`）、`traces/` 追踪数据或云端会话。WorkBuddy 处于快速迭代阶段，事件格式可能随版本调整；无法识别的行保留在原始事件中，不影响已知事件的归一化。
