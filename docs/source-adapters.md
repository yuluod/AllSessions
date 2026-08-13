# 来源适配器架构

AllSessions 通过来源适配器隔离不同 Agent 的本地文件格式。`SessionStore` 只负责统一会话索引、
搜索、筛选、统计、详情缓存与变更通知，不应判断具体的 `source_kind`。

## 适配器职责

每个适配器统一提供以下行为：

- 声明发现与监听目录，并精确判断目标文件。
- 初始化来源，复用持久化缓存并返回统一会话详情。
- 处理单个文件变化，返回需要替换的会话键和最新详情。
- 根据统一摘要加载详情，并报告用于详情缓存预算的源文件字节数。

普通的一文件一会话来源使用 `FileSourceAdapter`。Gemini 的一个会话可能跨多个
`tmp/*/logs.json`，因此使用 `GeminiSourceAdapter` 保存“文件 → 日志条目”分片，在单文件变化时
只重读该文件，再重新聚合受影响的 sessionId。

## 增加新来源

1. 在 `server/config.js` 声明来源目录、文件模式和显示名称。
2. 在 `server/parsers/` 增加解析器，将数据转换成统一的 `summary`、`conversation_messages` 和
   `raw_events`。
3. 如果是一文件一会话，在 `server/source-adapters.js` 注册 `FileSourceAdapter`；如果聚合模型不同，
   实现新的适配器并注册。
4. 添加脱敏解析器、缓存、增量刷新、详情和跨来源 ID 冲突测试。
5. 更新 README 的支持矩阵和已知限制。

前端会从 `/api/facets` 返回的 `sources` 动态生成来源筛选；新增来源不应再修改前端固定数组。
