# Claude Code 会话接入规划

本文档说明如何在当前项目中新增 Claude Code 本地会话目录支持。它是一份专项规划与设计文档，描述的是推荐方案、阶段目标、风险与验收标准，**不代表相关能力已经实现**。

## 背景

当前项目已经具备较完整的本地会话查看能力，但整体实现仍然明显围绕 Codex 构建：

- 默认目录固定为 `~/.codex/sessions`
- 服务端只支持单一 `SESSION_ROOT`
- 解析器只理解当前 Codex 风格日志结构
- 前端过滤维度主要围绕 `provider`、`date`、`cwd`
- UI 中没有明确区分“来源类型”和“模型提供商”

随着项目定位从单一来源查看器逐步扩展为更通用的 AI Session Viewer，Claude Code 本地会话目录是最值得优先支持的第二类真实来源。它与当前项目的核心目标高度一致：都是本地会话、开发工作流、工具调用事件流与历史回看场景。

## 目标

本规划的目标如下：

- 新增 Claude Code 本地会话目录读取能力
- 让 Codex 与 Claude 会话可以在同一个界面中统一查看
- 保持现有搜索、统计、SSE、详情页和 i18n 能力可继续工作
- 为后续继续接入更多来源保留清晰抽象

## 范围

### 本次包含

- Claude Code 本地会话目录扫描
- Claude Code 单文件解析与统一摘要映射
- 多来源聚合存储
- 前端来源展示与来源过滤
- 多来源相关 API 扩展
- 回归测试与 README 更新

### 本次不包含

- Claude Web 导出文件导入
- Anthropic 云端 API 拉取
- 多来源写入或编辑能力
- 面向第三方来源的插件系统
- 完全统一所有来源的高级语义层

## 当前实现现状

### 服务端现状

当前服务端由以下几部分组成：

- `server/config.js`
  - 提供 `SESSION_ROOT`
  - 仅支持 `CODEX_SESSIONS_DIR`
- `server/session-parser.js`
  - 负责解析单个 JSONL 会话文件
  - 从 `session_meta`、`response_item`、`event_msg` 中提取摘要和对话消息
- `server/session-store.js`
  - 扫描单个根目录下所有 `.jsonl`
  - 构建摘要列表、详情缓存、搜索索引、SSE 更新源
- `server/http-server.js`
  - 暴露 `/api/sessions`、`/api/facets`、`/api/stats`、`/api/search`、`/api/events` 等接口

### 前端现状

前端当前基于统一摘要结构工作，主要依赖以下字段：

- `id`
- `timestamp`
- `last_timestamp`
- `model_provider`
- `cwd`
- `source`
- `originator`
- `event_count`
- `file_path`

前端已具备：

- 列表展示
- 搜索
- `provider/date/cwd` 筛选
- 会话详情
- 统计面板
- SSE 实时更新
- 中英文切换

### 当前架构限制

当前实现存在以下前提假设：

- 只有一个会话根目录
- 所有会话都使用同一解析规则
- `id` 在全局唯一
- `provider` 可以近似代表来源

这些假设在接入 Claude Code 后都会被打破，因此需要先做多来源抽象，而不是继续把 Claude 逻辑硬塞到现有 Codex 专用链路中。

## 接入前需要确认的数据事实

在正式编码前，需要先通过样本确认 Claude Code 本地会话格式。建议至少准备 1 到 3 个脱敏样本，并确认：

- 默认目录路径是什么
- 文件扩展名是什么
- 是否是一文件一会话
- 是否具备稳定的 `session id`
- 时间戳字段名与格式
- 是否包含 `cwd`
- 是否包含模型或 provider 字段
- 用户消息、助手消息、工具调用、工具结果、错误事件分别如何表示
- 是否存在类似 `session_meta` 的头部元信息

建议输出以下资料：

- 一组样本文件
- 一张字段映射表
- 一份格式稳定性说明

## 统一数据模型设计

为了支持多来源，需要把当前“Codex 摘要模型”提升为“统一会话模型”。

### 摘要模型建议

建议将 `summary` 扩展为：

- `id`
- `source_kind`
- `display_source`
- `timestamp`
- `last_timestamp`
- `model_provider`
- `cwd`
- `source`
- `originator`
- `file_path`
- `event_count`

字段含义建议：

- `id`
  - 对外展示的逻辑会话 ID
- `source_kind`
  - 技术来源标识，例如 `codex`、`claude_code`
- `display_source`
  - 面向 UI 的展示名，例如 `Codex`、`Claude Code`
- `model_provider`
  - 模型厂商或后端提供商，例如 `openai`、`anthropic`
- `source`
  - 原始文件内部记录的 source 字段，保留其原始语义

### 详情模型建议

详情模型继续保持：

- `summary`
- `raw_events`
- `conversation_messages`

这样前端改动成本最小。

### 内部主键建议

由于不同来源可能出现相同 `id`，内部不能继续只用 `id` 做主键。建议引入：

- `session_key = ${source_kind}:${id}`

这个主键用于：

- `summaryById` 或 `summaryByKey`
- detail cache
- 搜索索引
- SSE 更新
- 列表翻页 cursor

必要时，API 层也可以逐步从纯 `id` 迁移到 `session_key`。

## 配置层设计

### 当前问题

当前只有：

- `CODEX_SESSIONS_DIR`

这不满足多来源目录接入。

### 推荐方案

扩展为：

- `CODEX_SESSIONS_DIR`
- `CLAUDE_SESSIONS_DIR`

并在配置层构造统一来源定义，例如：

- Codex
  - `kind: codex`
  - `rootDir`
  - `fileMatcher`
  - `parser`
- Claude Code
  - `kind: claude_code`
  - `rootDir`
  - `fileMatcher`
  - `parser`

### 默认行为

- Codex 目录保持现有默认值
- Claude 目录优先从环境变量读取
- Claude 目录不存在时，不影响服务启动
- 若两个来源目录都为空，应用仍可启动，但展示空状态

## 解析器架构设计

### 当前问题

当前 `server/session-parser.js` 同时承担：

- 文件读取
- 原始事件构造
- Codex 特定字段识别
- 会话摘要生成
- 对话消息归一化

如果直接把 Claude 分支继续加进去，文件会迅速变得臃肿且难测。

### 推荐拆分

建议拆分为三层：

#### 公共层

负责：

- 文本抽取辅助函数
- 角色归一化
- 时间戳处理
- fallback 逻辑
- 通用 summary/detail 构造工具

#### Codex 解析器

负责：

- 继续解析当前 Codex JSONL 结构
- 保持现有行为兼容

#### Claude Code 解析器

负责：

- 识别 Claude Code 本地文件结构
- 将 Claude 的用户、助手、工具、错误事件映射到统一消息模型
- 生成统一摘要与原始事件列表

#### 统一入口层

负责：

- 根据来源定义或文件匹配规则分发到正确解析器

## Store 设计改造

### 当前问题

当前 `SessionStore`：

- 只接受一个 `sessionRoot`
- 只扫描 `.jsonl`
- 只监听一棵目录树
- 默认所有文件都交给同一解析器

### 推荐改造

把 `SessionStore` 提升为多来源聚合存储：

- 构造参数改为 `sources`
- 初始化时遍历所有来源
- 分来源收集文件
- 分来源解析详情
- 汇总为统一摘要数组
- 统一排序、索引、缓存和搜索

### 监听策略

每个来源根目录单独递归监听：

- 新增文件：解析并加入
- 文件更新：重建对应缓存与索引
- 文件删除：根据 `file_path + source_kind` 删除对应会话

### 建议维护的内部索引

- `sessionKey -> summary`
- `filePath -> sessionKey`

这样可以降低 watcher 更新和删除时串数据的风险。

## API 设计

### 保持路径稳定

优先保持现有 API 路径不变：

- `GET /api/sessions`
- `GET /api/sessions/:id`
- `GET /api/facets`
- `GET /api/stats`
- `GET /api/search`
- `GET /api/events`

### 数据结构扩展

#### `/api/sessions`

建议新增字段：

- `source_kind`
- `display_source`

并新增来源过滤参数：

- `source_kind=codex`
- `source_kind=claude_code`

#### `/api/facets`

建议新增：

- `source_kinds`

#### `/api/stats`

可选新增：

- `by_source_kind`

#### `/api/events`

SSE 事件中的摘要对象应包含：

- `source_kind`
- 内部唯一 key 或能唯一定位的 ID

#### `/api/sessions/:id`

这是最关键的设计点。推荐两种策略：

- **方案 A：保留路径不变，但使用命名空间 ID 作为 `id`**
  - 例如 `codex:abc123`
  - 优点：最简单，服务端唯一性好
  - 缺点：前端与导出文案需要适配
- **方案 B：改为复合路径**
  - 例如 `/api/sessions/:sourceKind/:id`
  - 优点：语义更清晰
  - 缺点：接口改动更大

建议首版采用 **方案 A**。

## 前端改造设计

### 列表展示

建议在会话列表中显式展示来源标签：

- `Codex`
- `Claude Code`

这样用户不需要通过 provider 猜测来源。

### 过滤器

新增来源过滤器：

- 全部
- Codex
- Claude Code

保留现有：

- provider
- date
- cwd

### 详情视图

详情摘要区新增：

- 来源类型

并继续保留：

- provider
- start time
- last time
- source
- originator
- cwd
- event count

### 顶部元信息

当前 `session_root` 是单值语义。多来源后建议升级为：

- `session_roots`
- 或在 UI 中显示“已接入来源目录数量/列表”

### 统计面板

首版可选支持：

- 按来源统计会话数量

这不是强制项，但如果实现成本低，体验会明显更好。

### i18n

建议新增以下文案：

- 来源过滤器标题
- `Codex`
- `Claude Code`
- 多来源目录展示文案
- 来源统计文案

## 测试策略

### 解析器测试

新增 Claude 样本测试，覆盖：

- 正常摘要提取
- 正常对话消息提取
- 缺元信息回退
- 工具调用和结果解析
- 错误事件解析
- 坏行容错

### Store 测试

覆盖：

- 多来源初始化
- 多来源混合排序
- 来源过滤
- 多来源搜索
- watcher 更新与删除
- ID 冲突场景

### HTTP 测试

覆盖：

- `/api/sessions` 混合返回
- `/api/facets` 返回 `source_kinds`
- 来源过滤参数生效
- `/api/sessions/:id` 可正确读取 Claude 会话详情
- SSE 事件在多来源下仍然正确

### 前端测试

覆盖：

- 新增来源过滤器存在
- 列表项展示来源标签
- i18n 切换后来源文案正确
- `session_root/session_roots` 新展示逻辑正确

## 实施路线

### 阶段 1：样本调研与字段映射

目标：确认 Claude Code 本地格式事实。

交付：

- 样本文件
- 字段映射表
- 解析边界说明

### 阶段 2：服务端多来源内核

目标：先完成后端可聚合多来源。

交付：

- 多来源配置层
- 多来源 parser 结构
- 聚合型 `SessionStore`
- 基础 API 扩展

### 阶段 3：前端来源感知

目标：让用户在 UI 上清晰区分来源。

交付：

- 来源过滤器
- 列表来源标签
- 详情来源字段
- 必要 i18n 文案

### 阶段 4：统计、回归与文档

目标：补齐体验和稳定性。

交付：

- 多来源统计
- 全量测试
- README 与环境变量说明更新

## 风险与应对

### 风险 1：Claude Code 本地格式不稳定

应对：

- 样本先行
- 解析器按来源独立实现
- 对坏行和缺字段保持回退策略

### 风险 2：ID 冲突导致缓存污染

应对：

- 内部统一使用 `session_key`
- 不再假设原始 `id` 全局唯一

### 风险 3：多来源后旧 API 语义不清

应对：

- 渐进式增加新字段
- 旧字段短期兼容
- 优先解决详情接口的主键策略

### 风险 4：前端来源与 provider 混淆

应对：

- 明确新增 `source_kind`
- `provider` 继续保持模型提供商语义，不混用

## 验收标准

完成后应满足：

- 能同时看到 Codex 与 Claude Code 本地会话
- 列表、详情、搜索、SSE 在多来源下正常工作
- 用户可以按来源过滤
- 不同来源即使 `id` 相同也不会串数据
- 测试覆盖新增核心链路
- README 明确说明当前支持来源与配置方式

## 推荐决策

如果准备开始实现，建议采用以下决策组合：

- **数据来源**：先只支持 Claude Code 本地目录
- **主键策略**：采用命名空间 key
- **API 兼容策略**：优先保持路径不变，使用唯一化 `id`
- **前端策略**：首版只补来源过滤和来源标签，不一次做过多 UI 改造
- **迭代顺序**：先服务端，再前端，最后统计与文档

## 下一步建议

在进入实现前，还需要补一个非常关键的输入：

- Claude Code 本地 session 样本

拿到样本后，就可以把这份规划进一步收敛成：

- 字段映射说明
- 具体代码改动清单
- 测试用例清单
- 分阶段实施任务表
