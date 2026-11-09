import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const script = path.resolve(
  import.meta.dirname,
  "../scripts/verify-ci-package.sh"
);

test(
  "安装包重试仅处理 Windows NSIS 临时下载错误并保留失败状态",
  {
    skip: process.platform === "win32",
  },
  (t) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "allsessions-ci-package-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const counter = path.join(root, "counter");
    for (const scenario of [
      { os: "Windows", failures: 0, kind: "network", calls: 1, status: 0 },
      { os: "Windows", failures: 2, kind: "network", calls: 3, status: 0 },
      { os: "Windows", failures: 9, kind: "network", calls: 3, status: 7 },
      { os: "Windows", failures: 9, kind: "compile", calls: 1, status: 7 },
      { os: "Windows", failures: 9, kind: "missing", calls: 1, status: 7 },
      { os: "Windows", failures: 0, kind: "tee", calls: 1, status: 9 },
      { os: "macOS", failures: 9, kind: "network", calls: 1, status: 7 },
      { os: "Linux", failures: 9, kind: "network", calls: 1, status: 7 },
    ]) {
      writeFileSync(counter, "0");
      const result = spawnSync(
        "bash",
        [
          "-c",
          `
pnpm() {
  count=$(cat "$COUNTER_PATH")
  count=$((count+1))
  echo "$count" > "$COUNTER_PATH"
  echo "构建调用"
  if [ "$count" -gt "$FAILURES" ]; then return 0; fi
  if [ "$KIND" = compile ]; then echo 'error: compilation failed'; return 7; fi
  echo 'Downloading https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.13/nsis-3.13.zip'
  if [ "$KIND" = missing ]; then
    echo 'failed to bundle project: http status: 404'
  else
    echo 'failed to bundle project: http status: 504'
  fi
  return 7
}
sleep() { echo "等待 $1"; }
tee() {
  if [ "$KIND" = tee ]; then cat; return 9; fi
  command tee "$@"
}
source "$1"
`,
          "test",
          script,
          "nsis",
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            RUNNER_OS: scenario.os,
            FAILURES: String(scenario.failures),
            KIND: scenario.kind,
            COUNTER_PATH: counter,
          },
        }
      );
      assert.equal(result.status, scenario.status, result.stderr);
      assert.equal(
        (result.stdout.match(/构建调用/g) || []).length,
        scenario.calls
      );
      const waits = result.stdout.match(/等待 \d+/g) || [];
      assert.deepEqual(
        waits,
        scenario.calls === 3 ? ["等待 10", "等待 30"] : []
      );
    }
  }
);
