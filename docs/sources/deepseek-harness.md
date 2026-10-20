# DeepSeek Harness 来源说明

只读接入 DeepSeek 官方 Harness（`dsh`）的本地会话，不连接云端 API，不启动 dsh 进程。

- 默认根为 `~/.dsh`；官方 `DSH_HOME` 替换数据根。设置中的来源目录优先，其次为 `DSH_SESSIONS_DIR` 路径列表。显式根可指向 `.dsh` 或其 `sessions`，扫描和监听限定在 `sessions` 内。
- 会话布局为 `sessions/<编码后的工作目录>/session-<id>/session[.vN].jsonl[.zstd]`，会话目录名必须带 `session-` 前缀。精确发现三层结构，不跟随符号链接；`session.lock` 与导出的 ZIP 不作为会话。
- 同一目录可能并存多代日志（dsh 打开旧会话时写出新一代并保留旧文件）；只读代际编号最大的文件，同代并存时以 `.zstd` 为准。
- 事件文件是追加写入的 JSONL，默认多帧 zstd 压缩（每次追加一个独立 frame）；按魔数识别压缩格式，未压缩的原始 `.jsonl` 同样可读。逐行流式解析，不把完整会话装入内存。进程崩溃留下的撕裂尾部 frame 会保留已解码部分并记录 `read_error` 事件；首个字节就无法解码的整体损坏文件才按错误计入诊断。
- 首行 `type=session` 提供会话 ID、工作目录与创建时间；标题取最后的 `session/title` 事件，缺失时回退首条用户消息；`delegationDepth > 0` 或携带 `parentSessionId` 的会话标记为子代理隐藏会话。
- `user/message` 中 `source.kind` 为 `runtime-context`、`time-context`、`skill-catalog` 等注入内容按合成上下文处理：计入上下文统计、不出现在用户消息与搜索正文；`system/message` 同样处理。
- `assistant/message` 归约为正文与 Thinking；`source.provider`/`model` 记入摘要（provider 缺失时回退 `deepseek`）；`usage` 按步累计 input/output/cache token。`tool/call` 与 `tool/result` 按 `callId` 关联工具名，`isError` 映射为错误标记。`agent/inbox/spliced` 等控制事件不重复生成消息，仅在原始事件中保留。
- 只有注入上下文、没有对话消息的占位会话不进入列表；详情沿用统一首尾窗口与单条 20,000 字符上限，截断时保留标记；单条原始事件超过 10,000 字符时只保留长度。
- 支持收藏、标签、备注、本地归档/移除、搜索和导出；事件文件变更触发增量刷新。

dsh 当前没有稳定的命令行恢复入口（桌面版与 Web 在界面内恢复会话），本来源不提供恢复命令。

不提供永久删除来源数据、云端会话下载、跨 ZIP 导入或 Token/费用汇总。DeepSeek Harness 处于开发者预览阶段，事件格式可能随版本调整；无法识别的事件保留在原始事件中，不影响已知事件的归一化。
