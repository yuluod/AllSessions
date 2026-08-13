import path from "node:path";
import { fileURLToPath } from "node:url";

import { HOST, INDEX_CACHE_FILE, PORT, SOURCES } from "./config.js";
import { isAllSessionsViewer, localViewerUrl, openBrowser } from "./browser-launcher.js";
import { createHttpServer } from "./http-server.js";
import { assertLocalOnlyHost, assertValidPort, listenForHttpRequests } from "./server-binding.js";
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
  assertLocalOnlyHost(HOST);
  assertValidPort(PORT);
  const viewerUrl = localViewerUrl(HOST, PORT);

  const store = new SessionStore({ sources: SOURCES, indexCacheFile: INDEX_CACHE_FILE });
  let server;
  try {
    await store.initialize();
    await store.watch();

    server = createHttpServer({
      store,
      publicDir,
      sessionRoots: SOURCES.map((s) => s.rootDir),
      codexMaintenanceEnabled,
      desktopInstanceToken: process.env.ALLSESSIONS_INSTANCE_TOKEN || ""
    });
    server.once("close", () => store.stopWatching());
    await listenForHttpRequests(server, { host: HOST, port: PORT });
  } catch (error) {
    store.stopWatching();
    if (
      error?.code === "EADDRINUSE"
      && process.env.ALLSESSIONS_OPEN_BROWSER === "1"
      && await isAllSessionsViewer(viewerUrl)
    ) {
      console.log(`Session viewer is already running: ${viewerUrl}`);
      openBrowser(viewerUrl);
      return;
    }
    throw error;
  }

  console.log(`Session viewer started: ${viewerUrl}`);
  const roots = SOURCES.map((s) => s.displayName + ": " + s.rootDir).join(", ");
  console.log(`Session roots: ${roots || "none"}`);
  console.log(`Cached sessions: ${store.summaries.length}`);
  console.log(`Codex maintenance: ${codexMaintenanceEnabled ? "enabled" : "disabled (read-only mode)"}`);

  if (process.env.ALLSESSIONS_OPEN_BROWSER === "1") {
    openBrowser(viewerUrl);
  }
}

main().catch((error) => {
  console.error("Startup failed:", error);
  process.exitCode = 1;
});
