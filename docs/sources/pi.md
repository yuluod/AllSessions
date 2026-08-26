# Pi 来源说明

AllSessions 根据 Pi 官方 Session File Format 独立解析本地记录，不复用第三方项目代码。

## 数据位置与格式

- 默认根目录：`~/.pi/agent/sessions`
- 自定义根目录：设置中的来源目录、`PI_SESSIONS_DIR`，或 Pi 官方的 `PI_CODING_AGENT_SESSION_DIR` / `PI_CODING_AGENT_DIR`
- 会话文件：目录下的 JSONL 文件
- 支持版本：v1-v3；首行为 session header，其余条目通过 `id` 与 `parentId` 形成树

## 当前支持

适配器从最后活动叶节点沿父链重建当前分支，避免把已放弃分支混入正常对话。当前支持用户/助手消息、Thinking、工具调用与结果、bash 执行、压缩/分支摘要、扩展上下文、会话名称、搜索、原始事件与文件监听。损坏的单行会被跳过，并在详情原始事件中标记解析错误。

Pi 在当前版本中是只读来源。AllSessions 的收藏、标签、备注、归档和软移除仍可使用；永久删除原始会话或消息需在 Pi 中完成。

官方格式参考：<https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md>
