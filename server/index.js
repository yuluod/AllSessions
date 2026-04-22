import path from "node:path";
import { fileURLToPath } from "node:url";

import { HOST, PORT, SOURCES } from "./config.js";
import { createHttpServer } from "./http-server.js";
import { SessionStore } from "./session-store.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(currentDir, "..", "public");

async function main() {
  const store = new SessionStore({ sources: SOURCES });
  await store.initialize();
  await store.watch();

  const server = createHttpServer({
    store,
    publicDir,
    sessionRoots: SOURCES.map((s) => s.rootDir)
  });

  server.listen(PORT, HOST, () => {
    console.log(`Session viewer started: http://${HOST}:${PORT}`);
    const roots = SOURCES.map((s) => s.displayName + ": " + s.rootDir).join(", ");
    console.log(`Session roots: ${roots || "none"}`);
    console.log(`Cached sessions: ${store.summaries.length}`);
  });
}

main().catch((error) => {
  console.error("Startup failed:", error);
  process.exitCode = 1;
});
