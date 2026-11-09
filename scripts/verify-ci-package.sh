#!/usr/bin/env bash
set -euo pipefail

log_file=$(mktemp)
trap 'rm -f "$log_file"' EXIT

for attempt in 1 2 3; do
  # 保留实时日志及原始退出码，不能让 tee 把构建失败变成成功。
  if pnpm desktop:build --ci --bundles "$1" --config .github/tauri-ci.json -- --locked 2>&1 | tee "$log_file"; then
    exit 0
  else
    statuses=("${PIPESTATUS[@]}")
  fi
  status=${statuses[0]}
  if [ "${statuses[1]}" -ne 0 ]; then
    echo "::error::无法保存安装包构建日志"
    exit "${statuses[1]}"
  fi

  # 只处理已知的 NSIS 下载暂时失败；编译、配置及签名错误直接返回。
  if [ "${RUNNER_OS:-}" != Windows ] \
    || ! grep -Eq 'Downloading https://github\.com/tauri-apps/binary-releases/releases/download/nsis-' "$log_file" \
    || ! grep -Eiq 'failed to bundle project:.*(http status: (502|503|504)|timed out|connection reset|connection closed|temporary failure)' "$log_file"; then
    exit "$status"
  fi
  if [ "$attempt" -eq 3 ]; then
    echo "::error::NSIS 下载连续三次失败，停止构建"
    exit "$status"
  fi
  delay=$((attempt == 1 ? 10 : 30))
  echo "::warning::NSIS 下载暂时失败（第 ${attempt}/3 次），${delay} 秒后重试打包"
  sleep "$delay"
done
