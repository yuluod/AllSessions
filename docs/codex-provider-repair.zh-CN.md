# Codex Provider 可见性修复

[English](./codex-provider-repair.md)

AllSessions 包含一个可选维护工具，用于处理切换第三方模型 provider 后不可见的 Codex 历史。该流程会修改 Codex provider 元数据，与普通只读会话浏览相互独立。

## 安全边界

- 维护模式默认关闭；关闭时修复接口拒绝预览、执行和回滚请求。
- 修复只处理用户明确选择的 provider，并且仅修改受支持 SQLite 数据库和 JSONL 会话文件中的 Codex provider 元数据。
- 工具从 `config.toml` 读取当前激活 provider，但不会修改该文件。
- 内建和受保护 provider 不能作为迁移来源。
- 执行和回滚都要求确认 Codex App 已退出，并会检查正在运行的 Codex 进程。
- 预览会为精确计划生成指纹；文件或数据库变化后原计划立即失效。
- 备份可能包含敏感会话元数据，不应公开。

## 页面操作

正常启动 AllSessions：

```bash
pnpm start
```

打开 `http://127.0.0.1:3210`，进入「工具」页面并使用 Provider 修复卡片：

1. 打开维护模式开关。
2. 执行只读预览。
3. 检查候选 provider 和阻止项。
4. 明确选择需要修复的历史 provider。
5. 生成精确计划并核对影响数量。
6. 退出 Codex App，并确认它已经关闭。
7. 执行计划；完成后可关闭维护模式开关。

本地页面使用当前服务进程生成的写入 token，并检查同源请求。重启服务后，旧 token 和对应页面流程将失效。

## CLI 操作

### 1. 发现候选来源

```bash
pnpm codex:provider-repair -- --dry-run
```

发现过程不会自动选择 provider，因此不能直接用于执行。

### 2. 预览明确选择的来源

```bash
pnpm codex:provider-repair -- --dry-run \
  --providers legacy_provider_a,legacy_provider_b
```

检查阻止项、受影响 SQLite 线程数、JSONL 替换数、目标 provider 和返回的 `Plan id`。

### 3. 执行精确计划

退出 Codex App，然后使用完全相同的 provider 选择和预览返回的计划指纹：

```bash
pnpm codex:provider-repair -- --apply \
  --providers legacy_provider_a,legacy_provider_b \
  --plan-id <preview-plan-id> \
  --confirm-codex-closed
```

如果配置、状态数据库或目标 JSONL 文件在预览后发生变化，执行会停止，并要求重新预览。

## 备份与回滚

备份保存在：

```text
~/.codex/backups/codex-history-provider-rebucket-v2/
```

目录名中的 `v2` 是为兼容旧版本生成的备份而保留；当前备份元数据版本为 3。

任何写入开始前，工具会备份受影响的状态数据库和 JSONL 文件，并在 `provider-manifest.json` 中记录原始归属。执行途中失败会触发自动回滚。

如需手动回滚，先退出 Codex App，再运行：

```bash
pnpm codex:provider-repair -- \
  --rollback /path/to/backup-dir \
  --confirm-codex-closed
```

回滚会在写入前校验全部备份资源：

- 版本 3 备份只恢复受影响的 `model_provider` 字段，并保留之后新增的线程、归档状态变化和追加的 JSONL 消息。
- 已有版本 2 备份继续使用原有的完整 SQLite 与 JSONL 快照恢复语义。

## 修复不会执行的操作

- 不会永久合并所有 provider。
- 不会改变以后切换 provider 的行为。
- 不会修改第三方工具数据。
- 不会取消 Codex 会话归档，也不会让 Codex App 显示 subagent 会话。
- 不会让历史在所有 provider 下同时可见；再次切换 provider 后可能需要重新修复。

预览结果和备份路径都应视为本地运维数据。分享诊断信息前，应脱敏 provider 标识、用户目录和会话文件。
