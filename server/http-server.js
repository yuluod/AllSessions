import fs from "node:fs/promises";
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
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/g;

function sanitizeFilterValue(value) {
  if (!value) return "";
  const cleaned = String(value).replace(CONTROL_CHAR_RE, "");
  return cleaned.length > 256 ? cleaned.slice(0, 256) : cleaned;
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

export function createHttpServer({ store, publicDir, sessionRoots }) {
  const sseClients = new Set();

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
      if (url.pathname.startsWith("/api/") && request.method !== "GET") {
        sendText(response, 405, "Only GET is supported");
        return;
      }

      if (url.pathname === "/api/sessions") {
        const filters = {
          provider: sanitizeFilterValue(url.searchParams.get("provider")),
          source_kind: sanitizeFilterValue(url.searchParams.get("source_kind")),
          date: sanitizeFilterValue(url.searchParams.get("date")),
          cwd: sanitizeFilterValue(url.searchParams.get("cwd"))
        };
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
        const byDateMap = new Map();
        const byProviderMap = new Map();
        const byCwdMap = new Map();
        const bySourceKindMap = new Map();
        for (const s of store.summaries) {
          const date = (s.timestamp || s.last_timestamp || "").slice(0, 10);
          if (date) byDateMap.set(date, (byDateMap.get(date) || 0) + 1);
          if (s.model_provider) byProviderMap.set(s.model_provider, (byProviderMap.get(s.model_provider) || 0) + 1);
          if (s.cwd) byCwdMap.set(s.cwd, (byCwdMap.get(s.cwd) || 0) + 1);
          if (s.source_kind) bySourceKindMap.set(s.source_kind, (bySourceKindMap.get(s.source_kind) || 0) + 1);
        }
        const toSorted = (map) =>
          Array.from(map.entries())
            .map(([label, count]) => ({ label, count }))
            .sort((a, b) => b.count - a.count);
        sendJson(response, 200, {
          by_date: Array.from(byDateMap.entries())
            .map(([label, count]) => ({ label, count }))
            .sort((a, b) => b.label.localeCompare(a.label)),
          by_provider: toSorted(byProviderMap),
          by_source_kind: toSorted(bySourceKindMap),
          by_cwd: toSorted(byCwdMap)
        });
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
        const results = store.search(q);
        sendJson(response, 200, { query: q, sessions: results });
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
      console.error(`[ERROR] ${request.method} ${url.pathname}:`, error);
      sendJson(response, 500, { error: "Internal server error" });
    } finally {
      const duration = Date.now() - startMs;
      console.log(`${request.method} ${url.pathname} ${response.statusCode} ${duration}ms`);
    }
  });
}
