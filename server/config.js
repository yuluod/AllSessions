import os from "node:os";
import path from "node:path";

export const SESSION_ROOT =
  process.env.CODEX_SESSIONS_DIR || path.join(os.homedir(), ".codex", "sessions");

export const HOST = process.env.HOST || "127.0.0.1";
export const PORT = Number.parseInt(process.env.PORT || "3210", 10);
