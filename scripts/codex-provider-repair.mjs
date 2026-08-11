#!/usr/bin/env node
import { runCli } from "./migrate-codex-provider-to-custom.mjs";

runCli().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
