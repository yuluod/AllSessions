# Pi 来源说明

只读接入 Pi 本地会话记录，根据官方 Session File Format 独立解析。默认根目录 `~/.pi/agent/sessions`；设置中的来源目录、`PI_SESSIONS_DIR` 或 Pi 官方的 `PI_CODING_AGENT_SESSION_DIR` / `PI_CODING_AGENT_DIR` 可覆盖。

- 会话文件为目录下 JSONL（v1-v3），条目以 `id`/`parentId` 成树；从最后活动叶节点回溯重建当前分支，废弃分支不展示。
- 用户/助手消息、Thinking、工具调用与结果、bash 执行、压缩/分支摘要、扩展上下文、会话名称统一展示；损坏单行跳过并在原始事件中标记。

## 不支持

永久删除原始数据。恢复会话使用 `pi --session <id>`；`--resume` 仅打开 Pi 的交互选择器，不接受目标会话 ID。自定义来源目录需要同时配置 Pi 的会话查找目录。

## Pi 1.0.0 兼容性核对

- 依据官方 `v1.0.0` 标签核对：目录及 JSONL v3 的 `id` / `parentId` 树结构未变，无需迁移来源数据。
- 普通对话、Thinking、工具调用/结果、压缩摘要及命名仍按既有格式读取。`context_edit` 只改变后续模型上下文，不应改写历史查看器中的原始消息。
- `system` 消息的提示词分区和工具声明目前仅在原始事件中保留，不重建系统提示状态。
- `usage` 条目、助手和工具结果中的用量、摘要生成用量目前仅保留在原始事件中，尚未汇总为 Pi 的 Token 统计。
- 图片保持现有文本占位展示，不提供 1.0 codemode 生成图片的预览。
- 验证采用依据官方格式构造的合成 JSONL 与命令生成测试，未执行真实 Pi 终端恢复。

版本固定参考：[1.0.0 发布说明](https://github.com/earendil-works/pi/releases/tag/v1.0.0)、[会话格式](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/docs/session-format.md)、[消息类型](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/docs/message-types.md)、[命令行参数](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/src/cli/args.ts)。

官方格式参考：<https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md>
