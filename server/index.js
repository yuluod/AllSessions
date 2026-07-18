import path from "node:path";
import { fileURLToPath } from "node:url";

import { HOST, PORT, SOURCES } from "./config.js";
import { createHttpServer } from "./http-server.js";
import { SessionStore } from "./session-store.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(currentDir, "..", "public");

async function main() {
  const args = process.argv.slice(2);
  const unknownArgs = args.filter((arg) => arg !== "--enable-codex-maintenance");
  if (unknownArgs.length > 0) {
    throw new Error(`Unknown argument: ${unknownArgs.join(", ")}`);
  }
  const codexMaintenanceEnabled = args.includes("--enable-codex-maintenance");

  const store = new SessionStore({ sources: SOURCES });
  await store.initialize();
  await store.watch();

  const server = createHttpServer({
    store,
    publicDir,
    sessionRoots: SOURCES.map((s) => s.rootDir),
    codexMaintenanceEnabled
  });

  server.listen(PORT, HOST, () => {
    console.log(`Session viewer started: http://${HOST}:${PORT}`);
    const roots = SOURCES.map((s) => s.displayName + ": " + s.rootDir).join(", ");
    console.log(`Session roots: ${roots || "none"}`);
    console.log(`Cached sessions: ${store.summaries.length}`);
    console.log(`Codex maintenance: ${codexMaintenanceEnabled ? "enabled" : "disabled (read-only mode)"}`);
  });
}

main().catch((error) => {
  console.error("Startup failed:", error);
  process.exitCode = 1;
});
