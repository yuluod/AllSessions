import fs from "node:fs/promises";
import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import zlib from "node:zlib";
import { URL } from "node:url";

import {
  applyCodexProviderRepair,
  previewCodexProviderRepair,
  rollbackCodexProviderRepair
} from "./codex-provider-repair.js";
import { isLoopbackHost } from "./server-binding.js";
import { readPageLimit, readSessionFilters, sanitizeQueryValue } from "./session-query.js";

const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

const SESSION_ID_RE = /^[a-zA-Z0-9_:.-]{1,128}$/;
const MUTATION_TOKEN_HEADER = "x-session-viewer-token";
const SECURITY_HEADERS = Object.freeze({
  "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY"
});

function responseHeaders(headers = {}) {
  return { ...SECURITY_HEADERS, ...headers };
}

function validateSessionId(raw) {
  try {
    const id = decodeURIComponent(raw);
    if (!SESSION_ID_RE.test(id)) {
      return null;
    }
    return id;
  } catch {
    return null;
  }
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, responseHeaders({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  }));
  response.end(JSON.stringify(payload));
}

function sendText(response, statusCode, payload) {
  response.writeHead(statusCode, responseHeaders({
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store"
  }));
  response.end(payload);
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function forbidden(message) {
  const error = new Error(message);
  error.statusCode = 403;
  return error;
}

function requestOriginFromHeader(value) {
  if (!value || typeof value !== "string") return "";
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

function assertSameBrowserOrigin(request) {
  const host = request.headers.host;
  if (!host) return;
  const allowed = new Set([`http://${host}`, `https://${host}`]);
  const origin = requestOriginFromHeader(request.headers.origin);
  const referer = requestOriginFromHeader(request.headers.referer);
  if (origin && !allowed.has(origin)) {
    throw forbidden("Cross-origin mutation request is not allowed");
  }
  if (!origin && referer && !allowed.has(referer)) {
    throw forbidden("Cross-origin mutation request is not allowed");
  }
}

function assertMutationToken(request, expectedToken) {
  assertSameBrowserOrigin(request);
  if (!expectedToken || request.headers[MUTATION_TOKEN_HEADER] !== expectedToken) {
    throw forbidden("Mutation token is required");
  }
}

function assertLoopbackRequestHost(request) {
  const host = request.headers.host;
  try {
    if (host && isLoopbackHost(new URL(`http://${host}`).hostname)) return;
  } catch {
    // 统一按不可信 Host 处理。
  }
  throw forbidden("Request Host must be a loopback address");
}

async function readJsonBody(request, { maxBytes = 64 * 1024 } = {}) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      throw badRequest("Request body is too large");
    }
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw badRequest("Invalid JSON body");
  }
}

function readMigrationProviders(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const list = Array.isArray(value) ? value : String(value).split(",");
  return list.map((provider) => String(provider).trim()).filter(Boolean);
}

async function sendStaticFile(publicDir, pathname, request, response) {
  const normalized = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.join(publicDir, normalized);
  const relative = path.relative(publicDir, filePath);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    sendText(response, 403, "Forbidden");
    return;
  }

  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      sendText(response, 404, "Page not found");
      return;
    }
    throw error;
  }

  const etag = `"${Math.floor(stat.mtimeMs).toString(36)}-${stat.size.toString(36)}"`;
  if (request.headers["if-none-match"] === etag) {
    response.writeHead(304, responseHeaders({ ETag: etag, "Cache-Control": "no-cache" }));
    response.end();
    return;
  }

  const content = await fs.readFile(filePath);
  const extension = path.extname(filePath);
  const contentType = CONTENT_TYPES[extension] || "application/octet-stream";
  const isText = extension === ".css" || extension === ".html" || extension === ".js" || extension === ".json";
  const acceptGzip = /\bgzip\b/.test(request.headers["accept-encoding"] || "");

  if (isText && acceptGzip) {
    const compressed = await new Promise((resolve, reject) => {
      zlib.gzip(content, (err, result) => (err ? reject(err) : resolve(result)));
    });
    response.writeHead(200, responseHeaders({
      "Content-Type": contentType,
      "Content-Encoding": "gzip",
      ETag: etag,
      "Cache-Control": "no-cache"
    }));
    response.end(compressed);
  } else {
    response.writeHead(200, responseHeaders({
      "Content-Type": contentType,
      ETag: etag,
      "Cache-Control": "no-cache"
    }));
    response.end(content);
  }
}

export function createHttpServer({
  store,
  publicDir,
  sessionRoots,
  codexMaintenanceEnabled = false,
  codexMigrationOptions = {},
  desktopInstanceToken = ""
}) {
  const sseClients = new Set();
  const mutationToken = codexMigrationOptions.mutationToken || crypto.randomBytes(24).toString("base64url");
  let maintenanceEnabled = codexMaintenanceEnabled;

  const SSE_PING_INTERVAL = 30_000;
  let ssePingTimer = null;
  let resourcesClosed = false;

  function removeSseClient(client) {
    sseClients.delete(client);
    if (sseClients.size === 0 && ssePingTimer) {
      clearInterval(ssePingTimer);
      ssePingTimer = null;
    }
  }

  function startSsePing() {
    if (ssePingTimer) return;
    ssePingTimer = setInterval(() => {
      for (const client of sseClients) {
        try {
          client.write(":ping\n\n");
        } catch {
          removeSseClient(client);
        }
      }
    }, SSE_PING_INTERVAL);
  }

  const unsubscribeStore = store.onChange((event) => {
    if (event.type === "session-added" || event.type === "session-updated" || event.type === "session-deleted") {
      const data = `event: ${event.type}\ndata: ${JSON.stringify(event.type === "session-deleted" ? { id: event.id } : event.summary)}\n\n`;
      for (const client of sseClients) {
        try { client.write(data); } catch { removeSseClient(client); }
      }
    }
  });

  const server = http.createServer(async (request, response) => {
    const startMs = Date.now();
    if (!request.url) {
      sendText(response, 400, "Bad request");
      return;
    }

    const url = new URL(request.url, "http://127.0.0.1");

    try {
      assertLoopbackRequestHost(request);
      if (url.pathname === "/api/capabilities") {
        if (request.method !== "GET") {
          sendText(response, 405, "Only GET is supported");
          return;
        }
        sendJson(response, 200, {
          service: {
            name: "AllSessions",
            protocol_version: 1,
            desktop_instance_token: desktopInstanceToken
          },
          codex_maintenance: {
            enabled: maintenanceEnabled,
            mutation_token: mutationToken
          }
        });
        return;
      }

      if (url.pathname === "/api/codex-maintenance") {
        if (request.method !== "POST") {
          sendText(response, 405, "Only POST is supported");
          return;
        }
        assertMutationToken(request, mutationToken);
        const body = await readJsonBody(request);
        if (typeof body.enabled !== "boolean") {
          throw badRequest("enabled must be a boolean");
        }
        maintenanceEnabled = body.enabled;
        sendJson(response, 200, { enabled: maintenanceEnabled });
        return;
      }

      if (url.pathname.startsWith("/api/codex-provider-migration/") && !maintenanceEnabled) {
        sendJson(response, 404, { error: "Codex maintenance mode is disabled" });
        return;
      }

      if (url.pathname.startsWith("/api/") && request.method !== "GET") {
        const isMigrationPost = maintenanceEnabled &&
          url.pathname.startsWith("/api/codex-provider-migration/") &&
          request.method === "POST";
        if (!isMigrationPost) {
          sendText(response, 405, "Only GET is supported");
          return;
        }
      }

      if (url.pathname === "/api/codex-provider-migration/preview") {
        if (request.method !== "GET") {
          sendText(response, 405, "Only GET is supported");
          return;
        }
        const providers = readMigrationProviders(url.searchParams.get("providers"));
        const summary = await previewCodexProviderRepair({
          ...codexMigrationOptions,
          providers
        });
        summary.mutation_token = mutationToken;
        sendJson(response, 200, summary);
        return;
      }

      if (url.pathname === "/api/codex-provider-migration/apply") {
        if (request.method !== "POST") {
          sendText(response, 405, "Only POST is supported");
          return;
        }
        assertMutationToken(request, mutationToken);
        const body = await readJsonBody(request);
        if (body.confirmedCodexAppClosed !== true) {
          throw badRequest("Codex App closed confirmation is required");
        }
        if (typeof body.planId !== "string" || !/^[a-f0-9]{64}$/i.test(body.planId)) {
          throw badRequest("A valid migration plan id is required");
        }
        const summary = await applyCodexProviderRepair({
          ...codexMigrationOptions,
          providers: readMigrationProviders(body.providers),
          planId: body.planId,
          confirmedCodexClosed: true
        });
        await store.refresh();
        sendJson(response, 200, summary);
        return;
      }

      if (url.pathname === "/api/codex-provider-migration/rollback") {
        if (request.method !== "POST") {
          sendText(response, 405, "Only POST is supported");
          return;
        }
        assertMutationToken(request, mutationToken);
        const body = await readJsonBody(request);
        if (body.confirmedCodexAppClosed !== true) {
          throw badRequest("Codex App closed confirmation is required");
        }
        if (!body.backupDir || typeof body.backupDir !== "string") {
          throw badRequest("backupDir is required");
        }
        const result = await rollbackCodexProviderRepair({
          ...codexMigrationOptions,
          backupDir: body.backupDir,
          confirmedCodexClosed: true
        });
        await store.refresh();
        sendJson(response, 200, result);
        return;
      }

      if (url.pathname === "/api/sessions") {
        const filters = readSessionFilters(url.searchParams);
        const limit = readPageLimit(url.searchParams);
        const cursor = sanitizeQueryValue(url.searchParams.get("cursor")) || undefined;
        const result = store.listSessions(filters, { limit, cursor });
        sendJson(response, 200, {
          session_roots: sessionRoots,
          ...result
        });
        return;
      }

      if (url.pathname === "/api/facets") {
        sendJson(response, 200, {
          session_roots: sessionRoots,
          ...store.getFacets()
        });
        return;
      }

      if (url.pathname === "/api/refresh") {
        await store.refresh();
        sendJson(response, 200, { ok: true, count: store.summaries.length });
        return;
      }

      if (url.pathname === "/api/stats") {
        const stats = store.getStats(readSessionFilters(url.searchParams));
        sendJson(response, 200, stats);
        return;
      }

      if (url.pathname === "/api/events") {
        response.writeHead(200, responseHeaders({
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive"
        }));
        response.write(`event: connected\ndata: {}\n\n`);
        sseClients.add(response);
        startSsePing();
        request.on("close", () => removeSseClient(response));
        return;
      }

      if (url.pathname === "/api/search") {
        const q = sanitizeQueryValue(url.searchParams.get("q"));
        if (!q) {
          sendJson(response, 400, { error: "Missing search query" });
          return;
        }
        const filters = readSessionFilters(url.searchParams);
        const limit = readPageLimit(url.searchParams);
        const cursor = sanitizeQueryValue(url.searchParams.get("cursor")) || undefined;
        let results = store.search(q, filters);
        if (cursor) {
          const cursorIndex = results.findIndex((session) => session._key === cursor);
          if (cursorIndex >= 0) results = results.slice(cursorIndex + 1);
        }
        const hasMore = results.length > limit;
        const sessions = hasMore ? results.slice(0, limit) : results;
        sendJson(response, 200, {
          session_roots: sessionRoots,
          query: q,
          sessions,
          has_more: hasMore,
          next_cursor: hasMore && sessions.length > 0 ? sessions.at(-1)._key : null
        });
        return;
      }

      if (url.pathname.startsWith("/api/sessions/")) {
        const rawId = url.pathname.replace("/api/sessions/", "");
        const id = validateSessionId(rawId);
        if (!id) {
          sendJson(response, 400, { error: "Invalid session ID" });
          return;
        }
        const detail = await store.getSessionDetail(id);
        if (!detail) {
          sendJson(response, 404, { error: "Session not found" });
          return;
        }
        sendJson(response, 200, detail);
        return;
      }

      await sendStaticFile(publicDir, url.pathname, request, response);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const statusCode = error && typeof error === "object" && Number.isInteger(error.statusCode)
        ? error.statusCode
        : 500;
      if (statusCode >= 500) {
        console.error(`[ERROR] ${request.method} ${url.pathname}:`, error);
      } else {
        console.warn(`[WARN] ${request.method} ${url.pathname}: ${message}`);
      }
      sendJson(response, statusCode, {
        error: statusCode === 500
          ? "Internal server error"
          : message
      });
    } finally {
      const duration = Date.now() - startMs;
      console.log(`${request.method} ${url.pathname} ${response.statusCode} ${duration}ms`);
    }
  });

  function closeResources() {
    if (resourcesClosed) return;
    resourcesClosed = true;
    unsubscribeStore();
    if (ssePingTimer) clearInterval(ssePingTimer);
    ssePingTimer = null;
    for (const client of sseClients) {
      try {
        client.end();
      } catch {
        client.destroy();
      }
    }
    sseClients.clear();
  }

  const closeServer = server.close.bind(server);
  server.close = (callback) => {
    closeResources();
    return closeServer(callback);
  };
  server.on("close", closeResources);

  return server;
}
