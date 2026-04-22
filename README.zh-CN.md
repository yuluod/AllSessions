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
> 现在已支持 Codex。Claude 和其他来源属于后续方向，本次版本暂未实现。
>
> **演进方向**
> 逐步发展为一个统一查看多种 AI 编码助手本地历史的轻量工具。

## 当前范围

- 当前实现：仅支持 Codex 会话的解析与查看
- 后续方向：可扩展支持 Claude 等其他会话来源
- 本次版本不包含：多来源解析与统一接入能力

## 来源支持情况

| 来源 | 状态 | 说明 |
|------|------|------|
| Codex | 已支持 | 读取 `~/.codex/sessions` 或 `CODEX_SESSIONS_DIR` 指向的本地会话文件 |
| Claude | 计划中 | 当前版本尚未实现 |
| 其他 AI 工具 | 计划中 | 属于后续扩展方向，暂不承诺兼容性 |

## 功能

- 浏览本地会话列表
- 按 provider、日期、工作目录筛选
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
- 默认会话目录存在于 `~/.codex/sessions`

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
| `CODEX_SESSIONS_DIR` | 会话根目录 | `~/.codex/sessions` |

示例：

```bash
PORT=4000 CODEX_SESSIONS_DIR=/path/to/sessions pnpm start
```

## 已知边界

- 仅支持本机查看，不做登录和远程访问控制
- 默认只读 `~/.codex/sessions`
- 当前版本只支持 Codex 会话文件；Claude 等其他来源暂未实现
- 对历史格式差异较大的旧会话，只保证原始事件流可见
- 对加密字段只展示占位或原样结构，不尝试解密
- 启动时会全量扫描会话并缓存摘要；详情页按需读取单文件

## 路线图

- 继续保持当前 Codex 查看体验稳定、轻量
- 为后续接入更多会话格式整理更清晰的来源抽象
- 逐步探索对 Claude 风格本地导出或会话日志的支持
- 最终朝统一查看多种 AI 编码助手本地历史的方向演进

## 开发

```bash
# 运行测试
pnpm test

# 代码检查与自动修复
pnpm lint

# 格式化
pnpm format

# 前端构建（输出到 dist/）
pnpm build
```

## 许可证

Apache-2.0
