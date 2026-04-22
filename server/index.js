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
  await store.watch();

  const server = createHttpServer({
    store,
    publicDir,
    sessionRoot: SESSION_ROOT
  });

  server.listen(PORT, HOST, () => {
    console.log(`Session viewer started: http://${HOST}:${PORT}`);
    console.log(`Session root: ${SESSION_ROOT}`);
    console.log(`Cached sessions: ${store.summaries.length}`);
  });
}

main().catch((error) => {
  console.error("Startup failed:", error);
  process.exitCode = 1;
});
