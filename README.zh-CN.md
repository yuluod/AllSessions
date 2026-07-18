<div align="center">

# AI 本地会话查看器

<p>一个仅供本机使用的轻量网页工具，用来浏览本地 AI 会话历史，并为后续扩展到多种来源预留定位。</p>

<p>
  <a href="./README.md">English</a>
  ·
  <a href="#快速启动">快速启动</a>
  ·
  <a href="#功能">功能</a>
  ·
  <a href="#开发">开发</a>
</p>

<p>
  <img alt="Node.js" src="https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white" />
  <img alt="pnpm" src="https://img.shields.io/badge/pnpm-10%2B-F69220?logo=pnpm&logoColor=white" />
  <img alt="许可证" src="https://img.shields.io/badge/License-Apache--2.0-blue.svg" />
  <img alt="多语言" src="https://img.shields.io/badge/i18n-ZH%20%7C%20EN-7B61FF" />
</p>

</div>

支持筛选、搜索、详情查看与实时监听刷新，适合本地快速回看 AI 会话。

> **定位**
> 一个本地 AI 会话查看器，当前实现以 Codex 为主。
>
> **当前状态**
> 现已支持 Codex、Claude Code 和 Gemini CLI。其他来源可在后续版本继续扩展。
>
> **演进方向**
> 逐步发展为一个统一查看多种 AI 编码助手本地历史的轻量工具。

## 当前范围

- 当前实现：支持 Codex、Claude Code、Gemini CLI 会话的解析与查看
- 多来源统一聚合，在同一界面中浏览
- 后续方向：可扩展支持更多会话来源

## 来源支持情况

| 来源 | 状态 | 说明 |
|------|------|------|
| Codex | 已支持 | 读取 `~/.codex/sessions` 或 `CODEX_SESSIONS_DIR` 指向的本地会话文件 |
| Codex 归档 | 已支持 | 读取 `~/.codex/archived_sessions` 或 `CODEX_ARCHIVED_SESSIONS_DIR` 指向的目录 |
| Claude Code | 已支持 | 读取 `~/.claude` 或 `CLAUDE_SESSIONS_DIR` 指向的目录；本地仅保存用户输入历史 |
| Gemini CLI | 已支持 | 读取 `~/.gemini/tmp/*/logs.json` 或 `GEMINI_SESSIONS_DIR` 指向的目录 |
| 其他 AI 工具 | 计划中 | 属于后续扩展方向，暂不承诺兼容性 |

## 功能

- 浏览多个来源的本地会话列表（Codex、Claude Code、Gemini CLI）
- 按来源类型、provider、日期、工作目录筛选
- 搜索会话正文、项目路径、provider、来源名称和派生标题
- 默认隐藏 Codex subagent 会话，可通过「显示隐藏会话」临时查看
- 查看单个会话详情
- 在「对话视图」和「原始事件流」之间切换
- 中英文语言切换
- 实时文件系统监听与自动刷新

## 适用场景

- 不想直接翻看原始 JSONL 文件时，快速回看最近的本地 AI 会话
- 搜索历史对话、工具调用和原始事件流
- 检查 provider、工作目录、时间戳等会话元信息
- 在本地保持一个轻量查看器，随 Codex 新会话写入自动刷新

## 运行要求

- Node.js 20 或更高版本
- 至少存在一个受支持的会话来源目录：
  - Codex: `~/.codex/sessions`
  - Claude Code: `~/.claude`
  - Gemini CLI: `~/.gemini`

## 快速启动

```bash
pnpm install
pnpm start
```

默认会启动在：

```text
http://127.0.0.1:3210
```

随后在浏览器打开该地址，应用会自动扫描当前的 Codex 会话目录。

## 可选环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 服务端口号 | `3210` |
| `HOST` | 监听地址 | `127.0.0.1` |
| `CODEX_SESSIONS_DIR` | Codex 会话根目录 | `~/.codex/sessions` |
| `CODEX_ARCHIVED_SESSIONS_DIR` | Codex 归档会话目录 | `~/.codex/archived_sessions` |
| `CLAUDE_SESSIONS_DIR` | Claude Code 会话根目录 | `~/.claude` |
| `GEMINI_SESSIONS_DIR` | Gemini CLI 根目录 | `~/.gemini` |

示例：

```bash
PORT=4000 CODEX_SESSIONS_DIR=/path/to/sessions pnpm start
```

## Codex Provider 可见性修复

普通 `pnpm start` 是只读模式，不注册任何 Provider 修复接口。需要从页面执行时，必须显式启动维护模式：

```bash
pnpm start:maintenance
```

然后打开左侧「工具」页签。工具只读 `config.toml` 来确定当前激活的第三方 provider，列出候选历史 provider，并要求用户明确勾选来源后生成精确计划；不会修改 `config.toml`，也不会读取或写入任何第三方工具的数据。确认 Codex App 已退出后才能执行；如果任一会话文件或数据库在预览后变化，必须重新生成计划。

注意：左侧「显示 Codex 归档会话」只是只读查看 `~/.codex/archived_sessions`；「显示隐藏会话」用于查看 Codex subagent 会话；「Codex Provider 可见性修复」只改写 Codex 自身的历史索引和会话元数据。

如果 Codex App 因 provider 切换而看不到旧会话，可以先运行只读诊断：

```bash
pnpm codex:provider-repair -- --dry-run
```

诊断会列出候选来源，但不会自动选择。官方及内建 provider（如 `openai`、`ollama`）始终保持不变。如果当前 provider 未定义、属于内建 provider 或配置不完整，工具会阻止执行。默认诊断不会写入任何文件。

明确选择来源并生成计划：

```bash
pnpm codex:provider-repair -- --dry-run \
  --providers right_code,cubence_codex
```

输出会包含 `Plan id`。确认结果后，退出 Codex App，再使用完全相同的来源和该指纹执行：

```bash
pnpm codex:provider-repair -- --apply \
  --providers right_code,cubence_codex \
  --plan-id <preview-plan-id> \
  --confirm-codex-closed
```

执行前会通过 SQLite 在线备份保存所有受影响的 `state_5.sqlite`，同时备份将被改写的 JSONL，并写入 `provider-manifest.json` 记录原始 provider 归属。备份位于 `~/.codex/backups/codex-history-provider-rebucket-v2/`；任一步失败会自动恢复全部已写入数据。工具同时支持 Codex 的 `sqlite_home` 和 `CODEX_SQLITE_HOME`。

如需手动恢复，确保 Codex App 已退出，再使用输出的备份目录：

```bash
pnpm codex:provider-repair -- \
  --rollback /path/to/backup-dir \
  --confirm-codex-closed
```

这是针对“当前激活 provider”的可见性修复，不会改变其他工具今后的切换行为，也不承诺永久统一；切到另一个 provider 后如再次不可见，需要重新诊断并执行。

## 已知边界

- 仅支持本机查看，不做登录和远程访问控制
- 默认只读 `~/.codex/sessions`
- 同时支持 Codex、Claude Code 和 Gemini CLI 会话文件
- 对历史格式差异较大的旧会话，只保证原始事件流可见
- 对加密字段只展示占位或原样结构，不尝试解密
- 启动时会全量扫描会话并缓存摘要；详情页按需读取单文件
- 默认启动不注册 Provider 修复接口；维护模式仍需要本地页面 token，并拒绝跨来源写入请求

## 路线图

- 继续保持多来源查看体验稳定、轻量
- 为后续接入更多会话格式扩展来源抽象
- 改进 Claude Code 从本地历史重建对话的能力
- 最终朝统一查看多种 AI 编码助手本地历史的方向演进

## 开发

```bash
# 运行测试
pnpm test

# 代码检查
pnpm lint

# 代码检查与自动修复
pnpm lint:fix

# 格式化
pnpm format

# 前端构建（输出到 dist/）
pnpm build
```

如果本地 `pnpm` 版本切换触发 registry 签名校验失败，可直接运行项目内二进制完成同等验证：

```bash
./node_modules/.bin/eslint server public test scripts
node --test
./node_modules/.bin/vite build
```

## 许可证

Apache-2.0
