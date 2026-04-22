# Codex 本地会话查看器

一个仅供本机使用的极简网页工具，用来浏览 `~/.codex/sessions` 下的 Codex 本地会话历史。

## 功能

- 浏览本地会话列表
- 按 `provider`、日期、工作目录筛选
- 查看单个会话详情
- 在“对话视图”和“原始事件流”之间切换

## 运行要求

- Node.js 20 或更高版本
- 默认会话目录存在于 `~/.codex/sessions`

## 启动方式

```bash
pnpm start
```

默认会启动在：

```text
http://127.0.0.1:3210
```

## 可选环境变量

- `PORT`：自定义端口，默认 `3210`
- `HOST`：自定义监听地址，默认 `127.0.0.1`
- `CODEX_SESSIONS_DIR`：自定义会话根目录，默认 `~/.codex/sessions`

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
- 第一版不包含全文搜索、多目录聚合、统计面板、自动热刷新

## 测试

```bash
pnpm test
```

## 代码规范与构建

```bash
# 代码检查与自动修复
pnpm lint

# 格式化
pnpm format

# 前端构建（输出到 dist/）
pnpm build
```
