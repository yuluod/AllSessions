import fs from "node:fs/promises";
import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import zlib from "node:zlib";
import { URL } from "node:url";

const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

const SESSION_ID_RE = /^[a-zA-Z0-9_:.-]{1,128}$/;
const MUTATION_TOKEN_HEADER = "x-session-viewer-token";
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/g;
let codexMigrationModulePromise = null;

function loadCodexMigrationModule() {
  if (!codexMigrationModulePromise) {
    codexMigrationModulePromise = import("../scripts/migrate-codex-provider-to-custom.mjs");
  }
  return codexMigrationModulePromise;
}

function sanitizeFilterValue(value) {
  if (!value) return "";
  const cleaned = String(value).replace(CONTROL_CHAR_RE, "");
  return cleaned.length > 256 ? cleaned.slice(0, 256) : cleaned;
}

function readSessionFilters(url) {
  const showCodexArchived = url.searchParams.get("show_codex_archived");
  const showHidden = url.searchParams.get("show_hidden");
  return {
    provider: sanitizeFilterValue(url.searchParams.get("provider")),
    source_kind: sanitizeFilterValue(url.searchParams.get("source_kind")),
    date: sanitizeFilterValue(url.searchParams.get("date")),
    cwd: sanitizeFilterValue(url.searchParams.get("cwd")),
    show_codex_archived: showCodexArchived === "true" || showCodexArchived === "1",
    show_hidden: showHidden === "true" || showHidden === "1"
  };
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
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

function sendText(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store"
  });
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

function conflict(message) {
  const error = new Error(message);
  error.statusCode = 409;
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
    response.writeHead(304, { ETag: etag });
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
    response.writeHead(200, {
      "Content-Type": contentType,
      "Content-Encoding": "gzip",
      ETag: etag,
      "Cache-Control": extension === ".html" ? "no-cache" : "public, max-age=300"
    });
    response.end(compressed);
  } else {
    response.writeHead(200, {
      "Content-Type": contentType,
      ETag: etag,
      "Cache-Control": extension === ".html" ? "no-cache" : "public, max-age=300"
    });
    response.end(content);
  }
}

export function createHttpServer({
  store,
  publicDir,
  sessionRoots,
  codexMaintenanceEnabled = false,
  codexMigrationOptions = {}
}) {
  const sseClients = new Set();
  const mutationToken = codexMaintenanceEnabled
    ? codexMigrationOptions.mutationToken || crypto.randomBytes(24).toString("base64url")
    : "";

  const SSE_PING_INTERVAL = 30_000;
  let ssePingTimer = null;

  function startSsePing() {
    if (ssePingTimer) return;
    ssePingTimer = setInterval(() => {
      for (const client of sseClients) {
        try {
          client.write(":ping\n\n");
        } catch {
          sseClients.delete(client);
        }
      }
      if (sseClients.size === 0) {
        clearInterval(ssePingTimer);
        ssePingTimer = null;
      }
    }, SSE_PING_INTERVAL);
  }

  store.onChange((event) => {
    if (event.type === "session-added" || event.type === "session-updated" || event.type === "session-deleted") {
      const data = `event: ${event.type}\ndata: ${JSON.stringify(event.type === "session-deleted" ? { id: event.id } : event.summary)}\n\n`;
      for (const client of sseClients) {
        try { client.write(data); } catch { sseClients.delete(client); }
      }
    }
  });

  return http.createServer(async (request, response) => {
    const startMs = Date.now();
    if (!request.url) {
      sendText(response, 400, "Bad request");
      return;
    }

    const url = new URL(request.url, "http://127.0.0.1");

    try {
      if (url.pathname === "/api/capabilities") {
        if (request.method !== "GET") {
          sendText(response, 405, "Only GET is supported");
          return;
        }
        sendJson(response, 200, {
          codex_maintenance: {
            enabled: codexMaintenanceEnabled
          }
        });
        return;
      }

      if (url.pathname.startsWith("/api/codex-provider-migration/") && !codexMaintenanceEnabled) {
        sendJson(response, 404, { error: "Codex maintenance mode is disabled" });
        return;
      }

      if (url.pathname.startsWith("/api/") && request.method !== "GET") {
        const isMigrationPost = codexMaintenanceEnabled &&
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
        const { runMigration } = await loadCodexMigrationModule();
        const summary = await runMigration({
          ...codexMigrationOptions,
          providers,
          apply: false
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
        let summary;
        try {
          const { runMigration } = await loadCodexMigrationModule();
          summary = await runMigration({
            ...codexMigrationOptions,
            providers: readMigrationProviders(body.providers),
            planId: body.planId,
            confirmedCodexClosed: true,
            apply: true
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/plan changed|still running|Migration is blocked/i.test(message)) {
            throw conflict(message);
          }
          throw error;
        }
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
        let result;
        try {
          const { rollbackMigration } = await loadCodexMigrationModule();
          result = await rollbackMigration({
            ...codexMigrationOptions,
            backupDir: body.backupDir,
            confirmedCodexClosed: true
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/still running|Backup targets|Backup directory|Unsupported or invalid/i.test(message)) {
            throw conflict(message);
          }
          throw error;
        }
        await store.refresh();
        sendJson(response, 200, result);
        return;
      }

      if (url.pathname === "/api/sessions") {
        const filters = readSessionFilters(url);
        const limitParam = url.searchParams.get("limit");
        let limit;
        if (limitParam !== null) {
          const parsed = Number.parseInt(limitParam, 10);
          limit = Number.isNaN(parsed) ? 50 : Math.min(parsed, 200);
        }
        const cursor = sanitizeFilterValue(url.searchParams.get("cursor")) || undefined;
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
        const stats = store.getStats(readSessionFilters(url));
        sendJson(response, 200, stats);
        return;
      }

      if (url.pathname === "/api/events") {
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive"
        });
        response.write(`event: connected\ndata: {}\n\n`);
        sseClients.add(response);
        startSsePing();
        request.on("close", () => sseClients.delete(response));
        return;
      }

      if (url.pathname === "/api/search") {
        const q = sanitizeFilterValue(url.searchParams.get("q"));
        if (!q) {
          sendJson(response, 400, { error: "Missing search query" });
          return;
        }
        const filters = readSessionFilters(url);
        const results = store.search(q, filters);
        sendJson(response, 200, { session_roots: sessionRoots, query: q, sessions: results });
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
        : /^(Invalid provider name|Refusing to migrate (?:preserved|protected) provider):/.test(message)
          ? 400
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
}
