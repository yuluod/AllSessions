import { execFileSync } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as prettier from "prettier";

import { normalizeNewlines } from "./text-format.mjs";

export function requiresPackaging(files) {
  return files.some((file) =>
    /^(?:src-tauri\/|scripts\/|\.github\/(?:workflows\/|tauri-ci\.json$)|package\.json$|pnpm-lock\.yaml$|\.nvmrc$|rust-toolchain\.toml$|vite\.config\.|CHANGELOG\.md$|LICENSE$|THIRD_PARTY_NOTICES\.md$)/.test(
      file
    )
  );
}

export async function checkFormatting(files) {
  const failures = [];
  for (const file of files) {
    const info = await prettier.getFileInfo(file, {
      ignorePath: ".prettierignore",
    });
    if (info.ignored || !info.inferredParser) continue;
    const options = await prettier.resolveConfig(file);
    if (
      !(await prettier.check(normalizeNewlines(await readFile(file, "utf8")), {
        ...options,
        filepath: file,
      }))
    ) {
      failures.push(file);
    }
  }
  if (failures.length) {
    throw new Error(`以下变更文件未通过格式检查：\n${failures.join("\n")}`);
  }
}

async function main() {
  const {
    CI_BASE_SHA: base,
    CI_HEAD_SHA: head,
    GITHUB_OUTPUT: output,
  } = process.env;
  if (![base, head].every((sha) => /^[a-f0-9]{40}$/.test(sha ?? ""))) {
    throw new Error("CI_BASE_SHA 和 CI_HEAD_SHA 必须是完整提交 SHA");
  }
  const diffBase = /^0+$/.test(base)
    ? execFileSync("git", ["hash-object", "-t", "tree", "--stdin"], {
        input: "",
        encoding: "utf8",
      }).trim()
    : base;
  const changedFiles = (extra = []) =>
    execFileSync(
      "git",
      ["diff", "--name-only", "--no-renames", "-z", ...extra, diffBase, head],
      { encoding: "utf8" }
    )
      .split("\0")
      .filter(Boolean);

  // 删除的打包文件也应触发构建，但只检查仍存在的文件格式。
  const packaging = requiresPackaging(changedFiles());
  await checkFormatting(changedFiles(["--diff-filter=ACMT"]));
  if (output) await appendFile(output, `packaging=${packaging}\n`);
  console.log(`变更文件格式检查通过；安装包验证：${packaging}`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await main();
}
