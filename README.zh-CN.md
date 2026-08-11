<div align="center">

# AllSessions

<p>一个仅供本机使用的轻量 AI 编码助手会话查看器。</p>

<p>
  <a href="./README.md">English</a>
  ·
  <a href="#功能">功能</a>
  ·
  <a href="#快速开始">快速开始</a>
  ·
  <a href="#配置">配置</a>
</p>

<p>
  <img alt="Node.js" src="https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white" />
  <img alt="pnpm" src="https://img.shields.io/badge/pnpm-11.10.0-F69220?logo=pnpm&logoColor=white" />
  <img alt="许可证" src="https://img.shields.io/badge/License-Apache--2.0-blue.svg" />
  <img alt="多语言" src="https://img.shields.io/badge/i18n-ZH%20%7C%20EN-7B61FF" />
</p>

</div>

AllSessions 将受支持的本地 AI 会话来源聚合到同一个浏览器界面，提供浏览、筛选、全文搜索、统计和详情查看。普通查看模式不会修改来源数据，并且只允许监听 loopback 地址。

> AllSessions 是独立的社区项目，与 OpenAI、Anthropic、Google 不存在隶属、赞助或官方认可关系。文中产品及公司名称仅用于说明兼容的本地会话来源。

## 功能

- 统一浏览 Codex、Codex 归档、Claude Code 和 Gemini CLI 会话
- 按来源、provider、日期、项目和工作目录筛选
- 搜索会话派生文本，并可增量加载大量匹配结果
- 查看归一化对话和原始事件
- 默认隐藏 Codex subagent 和注入的系统上下文
- 监听本地会话文件并自动刷新界面
- 支持中英文切换
- 对 Codex 大会话限制内存占用，并明确标记截断内容

## 支持来源

| 来源 | 本地路径 | 当前支持范围 |
|------|----------|--------------|
| Codex | `~/.codex/sessions` | 会话元数据、消息、工具调用、原始事件和搜索 |
| Codex 归档 | `~/.codex/archived_sessions` | 只读浏览归档会话 |
| Claude Code | `~/.claude` | 当前解析器从受支持的本地元数据中提取用户输入历史 |
| Gemini CLI | `~/.gemini/tmp/*/logs.json` | 本地会话聚合和详情查看 |

可以通过环境变量指定自定义来源目录。

## 快速开始

运行要求：

- Node.js 20 或更高版本
- pnpm 11.10.0 或更高版本
- 至少存在一个受支持的本地会话目录

```bash
pnpm install
pnpm start
```

打开 `http://127.0.0.1:3210`。AllSessions 会扫描当前存在的受支持本地会话目录。服务没有远程认证，并会拒绝 `0.0.0.0`、局域网地址和公网地址。

## 配置

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 服务端口号 | `3210` |
| `HOST` | 监听地址，仅接受 loopback 地址 | `127.0.0.1` |
| `CODEX_SESSIONS_DIR` | Codex 会话根目录 | `~/.codex/sessions` |
| `CODEX_ARCHIVED_SESSIONS_DIR` | Codex 归档会话目录 | `~/.codex/archived_sessions` |
| `CLAUDE_SESSIONS_DIR` | Claude Code 根目录 | `~/.claude` |
| `GEMINI_SESSIONS_DIR` | Gemini CLI 根目录 | `~/.gemini` |
| `SESSION_VIEWER_CACHE_DIR` | 私有增量索引缓存目录 | 系统用户缓存目录下的 `AllSessions` |
| `SESSION_VIEWER_DISABLE_CACHE` | 设为 `1` 时禁用持久化索引缓存 | 未设置 |

示例：

```bash
PORT=4000 CODEX_SESSIONS_DIR=/path/to/sessions pnpm start
```

## 隐私与安全

本地 AI 历史可能包含提示词、工具输出、源代码片段、工作目录、provider 标识及其他敏感信息。

- 分享导出文件前应人工检查。
- 增量索引缓存和 Provider 修复备份都应视为敏感本地数据。
- 不要在公开 issue 中附加真实会话、数据库、缓存、备份、凭据或未经脱敏的路径。
- 不要绕过 loopback 限制将服务暴露到网络。

漏洞私下报告方式及安全边界见 [SECURITY.md](./SECURITY.md)。

## 可选的 Codex Provider 修复

AllSessions 包含一个默认关闭的维护工具，用于处理切换第三方 provider 后不可见的 Codex 历史。正常启动后，在「工具」页面打开维护模式开关即可使用。

```bash
pnpm start
```

维护流程要求精确预览、明确选择 provider、确认 Codex App 已退出、校验备份并支持回滚。它只修改选中的 Codex provider 元数据，不会修改 `config.toml` 或第三方工具数据。

维护开关关闭时服务保持只读；开启后仍需生成精确计划并确认 Codex App 已退出。使用维护模式或 CLI 前，请先阅读 [Codex Provider 可见性修复](./docs/codex-provider-repair.zh-CN.md)。

## 已知边界

- 上游工具的本地会话格式可能随版本变化；不受支持的历史记录可能只显示原始事件。
- Claude Code 支持范围受当前本地元数据中可用字段限制。
- Codex 大会话详情使用带标记的首尾安全窗口，搜索索引也会限制每个会话保存的文本长度。
- 注入的 developer 和环境上下文默认不进入对话与搜索视图，但仍存在于本地原始数据和完整导出中。

## 开发

```bash
pnpm install
pnpm test
pnpm lint
pnpm build
```

## 许可证

[Apache-2.0](./LICENSE)
