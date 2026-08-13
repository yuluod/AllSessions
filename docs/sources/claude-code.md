# Claude Code 来源说明

本文档记录 Claude Code 来源在 AllSessions 中的当前实现、数据边界和后续方向。早期接入计划已经完成，不再作为待实施方案维护。

## 当前状态

AllSessions 已支持同时扫描和聚合 Codex、Codex Archived、Claude Code 与 Gemini CLI 本地会话。Claude Code 来源通过统一的 `source_kind`、摘要结构和组合会话键接入现有列表、筛选、搜索、统计和详情接口。

当前实现涉及：

- `server/config.js`：声明 Claude Code 来源目录和精确的发现、监听范围。
- `server/source-adapters.js`：统一处理文件发现、摘要缓存、增量刷新和详情加载。
- `server/parsers/claude-code.js`：解析本地 Claude Code 会话元数据并映射到统一详情结构。
- `server/parsers/common.js`：提供跨来源共用的摘要与消息归一化工具。
- `server/session-store.js`：以 `${source_kind}:${id}` 作为内部组合键，避免不同来源的原始 ID 冲突。
- 前端来源筛选、详情页和统计视图：消费统一摘要字段，并从后端适配器元数据动态获得来源名称。

## 数据边界

Claude Code 的 `~/.claude/projects/**/*.jsonl` 转录当前可提供用户与助手消息、Thinking、工具调用与结果、原始事件、搜索和实时刷新。旧环境缺少项目转录时，才回退到 `~/.claude/sessions/*.json` 元数据与用户输入历史。AllSessions 只展示本地文件中实际存在的内容，不通过 Anthropic API 补全云端对话，也不推断缺失内容。

解析结果使用统一结构：

- 摘要：`id`、`source_kind`、`display_source`、时间戳、`model_provider`、`cwd`、`file_path` 和计数字段。
- 详情：`summary`、`conversation_messages`、`raw_events`。
- 内部键：`${source_kind}:${id}`。

Claude Code 目录不存在、文件损坏或单个会话无法解析时，不应阻止其他来源正常启动和浏览。

## 隐私与安全

Claude Code 本地历史可能包含提示词、项目路径和源代码片段。测试应使用临时目录与完全虚构的内容，不得提交真实 `~/.claude` 文件、数据库、日志或未经脱敏的路径。

项目根目录的 `.gitignore` 会忽略常见会话、数据库和本地工具目录，但这不能替代提交前检查。任何用于 issue 或测试的样本都必须先人工脱敏。

## 兼容性原则

- 只在声明的 Claude Code 目录范围内发现和监听文件。
- 保持 Codex、Gemini CLI 等既有来源行为不变。
- 来源特有解析逻辑保留在独立解析器中，公共层只包含可复用的归一化能力。
- API 和前端以统一结构工作，避免为单一来源增加隐式分支。
- 格式变化时优先新增脱敏回归测试，再调整解析器。

## 后续方向

- 根据真实但已脱敏的格式样本增强 Claude Code 消息重建。
- 明确记录不同 Claude Code 版本的已知格式差异。
- 在不引入云端依赖的前提下，改善工具调用、错误事件和时间戳的展示。

以上方向不承诺具体版本；当前实现仍以本地运行、默认只读和显式维护模式为边界。
