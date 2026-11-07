# 参与贡献

感谢关注 AllSessions！本文说明开发环境、验证要求与提交约定；更完整的架构与约定见 [AGENTS.md](AGENTS.md)。

## 沟通

- 交流、提交说明与新增代码注释使用中文；标识符与既有术语保持原样。
- Issue 与 PR 请写清改动目的、影响范围和实际做过的验证；未验证的部分请明确说明。

## 开发环境

- Node 与 pnpm：版本以 `.nvmrc` 和 `package.json` 为准；安装依赖用 `pnpm install --frozen-lockfile`。
- Rust：版本以 `rust-toolchain.toml` 为准。
- Linux 另需 WebKitGTK 等系统依赖，参见 [Tauri 2 先决条件](https://tauri.app/start/prerequisites/)。

```bash
pnpm install --frozen-lockfile # 安装依赖
pnpm desktop:dev               # 桌面端开发（真实数据与系统集成）
pnpm web:dev                   # 仅前端界面，数据走测试桩
```

## 提交前验证

按改动范围选择（完整矩阵见 [AGENTS.md](AGENTS.md#开发与验证)）：

| 改动                   | 检查                                                                                                                                                             |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 前端逻辑 / 组件 / 样式 | `pnpm test`、`pnpm lint`、`pnpm build`；视觉改动另在六种主题及紧凑布局下抽查                                                                                     |
| Rust 或前后端契约      | 上表加上 `cargo test --manifest-path src-tauri/Cargo.toml --locked` 与 `cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings` |
| 仅文档                 | 核对事实，`pnpm exec prettier --check <改动文件>`                                                                                                                |

## 约定要点

- 新增界面文案同时补充中英文（`public/i18n.js`），空状态与错误状态一并考虑。
- 不放宽 CSP、路径约束或命令白名单；测试使用脱敏合成数据，不改动真实会话、来源数据库或备份。
- 行为变化同步更新 `docs/` 与双语 README；版本准备与发布由维护者统一处理。

## 提交 PR

1. Fork 仓库并从 `main` 拉出分支。
2. 按 PR 模板勾选实际做过的验证，说明未验证部分。
3. CI（Windows、macOS、Linux 三平台测试与构建）通过后由维护者审查合并；与 `main` 冲突时请先 rebase。
