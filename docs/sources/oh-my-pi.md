# Oh My Pi 来源说明

只读接入 Oh My Pi（`omp`，[can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)）的本地会话。Oh My Pi 是 Pi 的 fork，会话仍为 Pi 的 JSONL 树格式，因此解析复用 `sessions/pi.rs`，仅来源标签（`omp` / "Oh My Pi"）、默认根目录与恢复命令不同。默认根目录 `~/.omp/agent/sessions`；设置中的来源目录、`OMP_SESSIONS_DIR` 或 `OMP_AGENT_DIR`（取其 `sessions` 子目录）可覆盖。

- 会话文件为按工作目录分层的 JSONL（`<时间戳>_<sessionId>.jsonl`），条目以 `id`/`parentId` 成树；从最后活动叶节点回溯重建当前分支，废弃分支不展示。
- 用户/助手消息、Thinking、工具调用与结果、bash 执行、压缩/分支摘要、扩展上下文、会话名称统一展示；损坏单行标记为 `parse_error`，不阻断其余记录。
- 会话按 `${source_kind}:${id}` 组合键（`omp:<id>`）与 Pi 会话（`pi:<id>`）区分，收藏、标签、备注等工作区状态互不影响。

## 边界

- 永久删除原始数据不受支持，来源保持只读；本地移除等整理状态保存在 `workspace.sqlite`。
- 恢复会话使用 `omp --resume <id>`（依据上游 CLI Args 定义；未在真实安装上验证）。`--resume` 不带参数时打开 omp 的交互选择器，AllSessions 不使用该形态。
- XDG 迁移布局（`$XDG_DATA_HOME/omp/...`）与命名 profile（`~/.omp/profiles/<name>/agent/sessions`）未自动发现；使用这些布局时请在设置中显式添加对应目录。

## 兼容性注意事项

- 依据上游 `packages/utils/src/dirs.ts` 的 `getSessionsDir` 与会话文档核对：agent 目录为 `~/.omp/agent`，会话为 JSONL；上游同时响应 `PI_CODING_AGENT_DIR`，AllSessions 侧改用独立的 `OMP_AGENT_DIR`，避免与 Pi 来源互相干扰。
- Oh My Pi 对会话头有扩展字段（如 `parentSession`、`providerPromptCacheKey`），子代理记录存放在会话旁的 artifacts 目录；这些属于 Pi 格式的超集，未知字段与条目类型由解析器兜底保留在原始事件中，子代理会话文件本身不会被单独索引。
- 解析基于合成 JSONL 与 Pi 既有测试覆盖，未针对真实 omp 会话执行端到端验证；格式出现不兼容时以解析失败明确呈现，不静默丢弃。

官方会话格式参考：<https://github.com/can1357/oh-my-pi/blob/main/docs/session-operations-export-share-fork-resume.md>
