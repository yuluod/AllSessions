import path from "node:path";
import { fileURLToPath } from "node:url";

import { HOST, PORT, SESSION_ROOT } from "./config.js";
import { createHttpServer } from "./http-server.js";
import { SessionStore } from "./session-store.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(currentDir, "..", "public");

async function main() {
  const store = new SessionStore({ sessionRoot: SESSION_ROOT });
  await store.initialize();
  store.watch();

  const server = createHttpServer({
    store,
    publicDir,
    sessionRoot: SESSION_ROOT
  });

  server.listen(PORT, HOST, () => {
    console.log(`会话查看器已启动: http://${HOST}:${PORT}`);
    console.log(`会话根目录: ${SESSION_ROOT}`);
    console.log(`已缓存会话数: ${store.summaries.length}`);
  });
}

main().catch((error) => {
  console.error("启动失败:", error);
  process.exitCode = 1;
});
