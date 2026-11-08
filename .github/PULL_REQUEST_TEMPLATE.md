## 改动说明

<!-- 做了什么、为什么；关联 Issue 请写 `closes #N` -->

## 验证

<!-- 只勾选实际跑过的检查，并在下方补充说明（输出摘要、截图、未验证项） -->

- [ ] `pnpm test`
- [ ] `pnpm lint`
- [ ] `pnpm build`
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml --locked`
- [ ] `cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings`
- [ ] 格式检查：`pnpm exec prettier --check <改动文件>` / `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`

## 文案与文档

- [ ] 新增界面文案已同时补充中英文（`public/i18n.js`）
- [ ] README / `docs/` 已同步（如适用）

## 安全边界

- [ ] 未放宽 CSP、路径约束或命令白名单
- [ ] 测试数据为脱敏合成数据；未改动真实会话、来源数据库或备份
