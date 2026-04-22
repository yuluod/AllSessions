# Codex 本地会话查看器

[English](./README.md)

一个仅供本机使用的极简网页工具，用来浏览 `~/.codex/sessions` 下的 Codex 本地会话历史。

## 功能

- 浏览本地会话列表
- 按 provider、日期、工作目录筛选
- 查看单个会话详情
- 在「对话视图」和「原始事件流」之间切换
- 中英文语言切换
- 实时文件系统监听与自动刷新

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
- 对历史格式差异较大的旧会话，只保证原始事件流可见
- 对加密字段只展示占位或原样结构，不尝试解密
- 启动时会全量扫描会话并缓存摘要；详情页按需读取单文件

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
