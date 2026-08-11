import fs from "node:fs/promises";
import fss from "node:fs";
import path from "node:path";

import {
  compareSummariesDesc,
  parseFile,
  parseFileSummary,
  parseGeminiSessions,
  sortTimestampValue
} from "./parsers/index.js";
import { ByteLruCache } from "./byte-lru-cache.js";
import { SessionSearchIndex } from "./session-index.js";
import { SessionIndexCache } from "./session-index-cache.js";
import { dateKeyFromTimestamp, matchesSessionFilters } from "./session-query.js";

const DEBOUNCE_MS = 500;
const INITIAL_PARSE_BATCH_SIZE = 4;
const MAX_CHANGE_RETRIES = 3;
const CHANGE_RETRY_DELAY_MS = 750;

function sessionKey(sourceKind, id) {
  return `${sourceKind}:${id}`;
}

function getMatchFn(source) {
  if (typeof source.matchFn === "function") return source.matchFn;
  const filename = (fp) => path.basename(fp);
  if (source.filePattern === "**/*.jsonl") return (fp) => fp.endsWith(".jsonl");
  if (source.filePattern === "sessions/*.json") {
    return (fp) => fp.endsWith(".json") && fp.includes(path.sep + "sessions" + path.sep + filename(fp));
  }
  if (source.filePattern === "tmp/*/logs.json") {
    return (fp) => {
      const parts = path.relative(source.rootDir, fp).split(path.sep);
      return parts.length === 3 && parts[0] === "tmp" && parts[2] === "logs.json";
    };
  }
  return () => false;
}

function isWithinRoot(filePath, rootDir) {
  const relativePath = path.relative(rootDir, filePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

const MAX_COLLECT_DEPTH = 15;

async function collectFiles(rootDir, source, depth = 0) {
  if (depth > MAX_COLLECT_DEPTH) {
    console.warn(`collectFiles: max depth ${MAX_COLLECT_DEPTH} reached at ${rootDir}, skipping deeper entries`);
    return [];
  }

  let entries = [];
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(rootDir, entry.name);
      if (entry.isDirectory()) {
        return collectFiles(fullPath, source, depth + 1);
      }
      if (entry.isFile() && getMatchFn(source)(fullPath)) {
        return [fullPath];
      }
      return [];
    })
  );

  return files.flat();
}

function sourceRoots(source, property) {
  const configured = Array.isArray(source[property]) && source[property].length > 0
    ? source[property]
    : [source.rootDir];
  return Array.from(new Set(configured.filter(Boolean).map((rootDir) => path.resolve(rootDir))));
}

function projectNameFromCwd(cwd) {
  if (!cwd || typeof cwd !== "string") {
    return "";
  }
  return path.basename(cwd) || cwd;
}

const DEFAULT_DETAIL_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const DETAIL_CACHE_SIZE_MULTIPLIER = 2;

async function parseFileSafely(filePath, sourceKind) {
  try {
    return await parseFileSummary(filePath, sourceKind);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Cannot parse session file (${filePath}): ${message}`);
    return null;
  }
}

export class SessionStore {
  constructor({
    sources,
    detailCacheMaxBytes = DEFAULT_DETAIL_CACHE_MAX_BYTES,
    indexCacheFile = null
  }) {
    this.sources = sources;
    this.summaries = [];
    this.summaryByKey = new Map();
    this.summaryById = new Map();
    this._filePathToKey = new Map();
    this._detailCache = new ByteLruCache(detailCacheMaxBytes);
    this._watchers = [];
    this._watchedDirs = new Set();
    this._debounceTimer = null;
    this._pendingChanges = new Set();
    this._changeRetryCounts = new Map();
    this._onChangeCallbacks = [];
    this._searchIndex = new SessionSearchIndex();
    this._indexCache = new SessionIndexCache(indexCacheFile);
    this._mutationQueue = Promise.resolve();
    this._parseFileSummary = parseFileSummary;
    this._parseGeminiSessions = parseGeminiSessions;
    this.cacheStats = { hits: 0, misses: 0 };
  }

  async initialize() {
    this.summaries = [];
    this.summaryByKey.clear();
    this.summaryById.clear();
    this._filePathToKey.clear();
    this._searchIndex.clear();
    this.cacheStats = { hits: 0, misses: 0 };
    await this._indexCache.load();
    const discoveredCacheFiles = new Set();

    for (const source of this.sources) {
      if (source.kind === "gemini") {
        const sessions = await this._parseGeminiSessions(source.rootDir);
        for (const detail of sessions) {
          this._addSessionDetail(detail);
        }
      } else {
        const discoveredFiles = await Promise.all(
          sourceRoots(source, "discoveryRoots").map((rootDir) => collectFiles(rootDir, source))
        );
        const files = Array.from(new Set(discoveredFiles.flat()));
        for (let start = 0; start < files.length; start += INITIAL_PARSE_BATCH_SIZE) {
          const batch = files.slice(start, start + INITIAL_PARSE_BATCH_SIZE);
          const parsed = await Promise.all(
            batch.map(async (filePath) => {
              let stat;
              try {
                stat = await fs.stat(filePath);
              } catch (error) {
                if (error && typeof error === "object" && error.code === "ENOENT") return null;
                throw error;
              }
              discoveredCacheFiles.add(filePath);
              const cached = this._indexCache.get(filePath, source.kind, stat);
              if (cached) {
                this.cacheStats.hits += 1;
                return { cached, filePath, stat };
              }
              this.cacheStats.misses += 1;
              const detail = await parseFileSafely(filePath, source.kind);
              return detail ? { detail, filePath, stat } : null;
            })
          );

          for (const result of parsed) {
            if (!result) continue;
            if (result.cached) {
              const summary = { ...result.cached.summary, file_path: result.filePath };
              this._addCachedSession(summary, result.cached.index_text);
              continue;
            }
            const summary = this._addSessionDetail(result.detail);
            this._indexCache.set(
              result.filePath,
              source.kind,
              result.stat,
              summary,
              this._searchIndex.getText(summary._key)
            );
          }
        }
      }
    }

    this.summaries.sort(compareSummariesDesc);
    this._indexCache.retain(discoveredCacheFiles);
    try {
      await this._indexCache.save();
    } catch (error) {
      console.warn("Cannot write session index cache:", error.message);
    } finally {
      this._indexCache.release();
    }
  }

  _registerSummary(summary) {
    const key = sessionKey(summary.source_kind, summary.id);
    summary._key = key;
    this.summaries.push(summary);
    this.summaryByKey.set(key, summary);
    if (!this.summaryById.has(summary.id)) {
      this.summaryById.set(summary.id, new Set());
    }
    this.summaryById.get(summary.id).add(key);
    this._filePathToKey.set(summary.file_path, key);
    return summary;
  }

  _addSessionDetail(detail) {
    const summary = this._registerSummary(detail.summary);
    this._indexSession(summary, detail.conversation_messages);
    return summary;
  }

  _addCachedSession(summary, indexText) {
    const registered = this._registerSummary(summary);
    this._searchIndex.addText(registered._key, indexText);
    return registered;
  }

  async _reloadGeminiSource(source) {
    const details = await this._parseGeminiSessions(source.rootDir);
    const previousKeys = new Set(
      this.summaries
        .filter((summary) => summary.source_kind === "gemini" && isWithinRoot(summary.file_path, source.rootDir))
        .map((summary) => summary._key)
    );

    for (const key of previousKeys) {
      this._removeSession(key);
    }

    const nextKeys = new Set();
    const nextSummaries = [];
    for (const detail of details) {
      const summary = this._addSessionDetail(detail);
      nextKeys.add(summary._key);
      nextSummaries.push(summary);
    }
    this.summaries.sort(compareSummariesDesc);

    for (const summary of nextSummaries) {
      this._notifyChange({ type: previousKeys.has(summary._key) ? "session-updated" : "session-added", summary });
    }
    for (const key of previousKeys) {
      if (!nextKeys.has(key)) {
        this._notifyChange({ type: "session-deleted", id: key });
      }
    }
  }

  _indexSession(summary, messages) {
    this._searchIndex.add(summary._key, summary, messages);
  }

  _unindexSessionText(key) {
    this._searchIndex.delete(key);
  }

  _removeSession(key) {
    this.summaries = this.summaries.filter((s) => s._key !== key);
    const summary = this.summaryByKey.get(key);
    if (summary) {
      this.summaryByKey.delete(key);
      const keySet = this.summaryById.get(summary.id);
      if (keySet) {
        keySet.delete(key);
        if (keySet.size === 0) {
          this.summaryById.delete(summary.id);
        }
      }
      this._filePathToKey.delete(summary.file_path);
    }
    this._detailCache.delete(key);
    this._unindexSessionText(key);
  }

  search(query, filters = {}) {
    if (!query || typeof query !== "string") {
      return [];
    }
    const summaries = [];
    for (const result of this._searchIndex.search(query)) {
      const summary = this.summaryByKey.get(result.key);
      if (summary && matchesSessionFilters(summary, filters)) {
        summaries.push(result.snippet ? { ...summary, search_snippet: result.snippet } : summary);
      }
    }

    return summaries.sort(compareSummariesDesc);
  }

  listSessions(filters = {}, { limit, cursor } = {}) {
    let filtered = this.summaries.filter((summary) => matchesSessionFilters(summary, filters));

    if (cursor) {
      const cursorIndex = filtered.findIndex((s) => s._key === cursor);
      if (cursorIndex >= 0) {
        filtered = filtered.slice(cursorIndex + 1);
      }
    }

    const hasMore = typeof limit === "number" && limit > 0 && filtered.length > limit;
    const sessions = hasMore ? filtered.slice(0, limit) : filtered;
    const nextCursor = hasMore && sessions.length > 0 ? sessions[sessions.length - 1]._key : null;

    return { sessions, has_more: hasMore, next_cursor: nextCursor };
  }

  getFacets() {
    const providers = new Set();
    const sourceKinds = new Set();
    const dates = new Set();
    const cwds = new Set();
    const hiddenReasons = new Set();
    const projectsByCwd = new Map();

    this.summaries.forEach((summary) => {
      if (summary.model_provider) {
        providers.add(summary.model_provider);
      }
      if (summary.source_kind) {
        sourceKinds.add(summary.source_kind);
      }
      const date = dateKeyFromTimestamp(summary.timestamp || summary.last_timestamp);
      if (date) {
        dates.add(date);
      }
      if (summary.cwd) {
        cwds.add(summary.cwd);
        if (!projectsByCwd.has(summary.cwd)) {
          projectsByCwd.set(summary.cwd, {
            name: projectNameFromCwd(summary.cwd),
            path: summary.cwd,
            count: 0,
            last_timestamp: null,
            providers: new Set(),
            source_kinds: new Set()
          });
        }
        const project = projectsByCwd.get(summary.cwd);
        project.count += 1;
        const timestamp = summary.last_timestamp || summary.timestamp || null;
        if (sortTimestampValue(timestamp) > sortTimestampValue(project.last_timestamp)) {
          project.last_timestamp = timestamp;
        }
        if (summary.model_provider) {
          project.providers.add(summary.model_provider);
        }
        if (summary.source_kind) {
          project.source_kinds.add(summary.source_kind);
        }
      }
      if (summary.hidden === true && summary.hidden_reason) {
        hiddenReasons.add(summary.hidden_reason);
      }
    });

    const projects = Array.from(projectsByCwd.values())
      .map((project) => ({
        name: project.name,
        path: project.path,
        count: project.count,
        last_timestamp: project.last_timestamp,
        providers: Array.from(project.providers).sort(),
        source_kinds: Array.from(project.source_kinds).sort()
      }))
      .sort((left, right) => {
        const byTime = sortTimestampValue(right.last_timestamp) - sortTimestampValue(left.last_timestamp);
        return byTime || left.name.localeCompare(right.name);
      });

    return {
      providers: Array.from(providers).sort(),
      source_kinds: Array.from(sourceKinds).sort(),
      dates: Array.from(dates).sort().reverse(),
      cwds: Array.from(cwds).sort(),
      hidden_reasons: Array.from(hiddenReasons).sort(),
      projects
    };
  }

  getStats(filters = {}) {
    const data = this.summaries.filter((summary) => matchesSessionFilters(summary, filters));
    const totalEvents = data.reduce((sum, summary) => sum + summary.event_count, 0);

    const byDate = new Map();
    const bySourceKind = new Map();
    const byProvider = new Map();
    const byCwd = new Map();

    data.forEach((summary) => {
      const date = dateKeyFromTimestamp(summary.timestamp || summary.last_timestamp);
      if (date) {
        byDate.set(date, (byDate.get(date) || 0) + 1);
      }
      if (summary.source_kind) {
        bySourceKind.set(summary.source_kind, (bySourceKind.get(summary.source_kind) || 0) + 1);
      }
      if (summary.model_provider) {
        byProvider.set(summary.model_provider, (byProvider.get(summary.model_provider) || 0) + 1);
      }
      if (summary.cwd) {
        byCwd.set(summary.cwd, (byCwd.get(summary.cwd) || 0) + 1);
      }
    });

    const toArray = (map) =>
      Array.from(map.entries())
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => b.count - a.count);

    return {
      total: data.length,
      total_events: totalEvents,
      active_days: byDate.size,
      avg_daily: byDate.size > 0 ? (data.length / byDate.size).toFixed(1) : "0",
      by_date: Array.from(byDate.entries())
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => a.label.localeCompare(b.label)),
      by_source_kind: toArray(bySourceKind),
      by_provider: toArray(byProvider),
      by_cwd: toArray(byCwd).slice(0, 16)
    };
  }

  async getSessionDetail(key) {
    let summary = this.summaryByKey.get(key);
    if (!summary) {
      const keySet = this.summaryById.get(key);
      if (keySet && keySet.size === 1) {
        summary = this.summaryByKey.get(keySet.values().next().value);
      }
    }
    if (!summary) {
      return null;
    }

    const cached = this._detailCache.get(summary._key);
    if (cached) return cached;

    let detail;
    if (summary.source_kind === "gemini") {
      const { parseGeminiSessionById } = await import("./parsers/gemini.js");
      const source = this.sources.find((s) => s.kind === "gemini" && isWithinRoot(summary.file_path, s.rootDir));
      if (!source) return null;
      detail = await parseGeminiSessionById(source.rootDir, summary.id);
      if (!detail) return null;
      detail.summary._key = summary._key;
    } else {
      detail = await parseFile(summary.file_path, summary.source_kind);
      detail.summary._key = summary._key;
    }

    const stat = await fs.stat(summary.file_path).catch(() => null);
    const estimatedBytes = stat
      ? Math.max(1, stat.size * DETAIL_CACHE_SIZE_MULTIPLIER)
      : DEFAULT_DETAIL_CACHE_MAX_BYTES + 1;
    this._detailCache.set(summary._key, detail, estimatedBytes);

    return detail;
  }

  onChange(callback) {
    this._onChangeCallbacks.push(callback);
    return () => {
      this._onChangeCallbacks = this._onChangeCallbacks.filter((item) => item !== callback);
    };
  }

  _notifyChange(event) {
    for (const callback of this._onChangeCallbacks) {
      try {
        callback(event);
      } catch (error) {
        console.error("Session change listener failed:", error.message);
      }
    }
  }

  _watchDir(dir, source) {
    if (this._watchedDirs.has(dir)) return;
    try {
      const watcher = fss.watch(dir, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        const fullPath = path.resolve(dir, String(filename));
        if (!isWithinRoot(fullPath, dir)) return;
        const isTargetFile = getMatchFn(source)(fullPath);
        if (isTargetFile) {
          this._pendingChanges.add(fullPath);
          this._schedulePendingChanges();
        }
      });
      watcher.on("error", (err) => {
        this._watchedDirs.delete(dir);
        console.error(`File watcher error (${dir}):`, err.message);
      });
      this._watchedDirs.add(dir);
      this._watchers.push(watcher);
    } catch (err) {
      if (!err || typeof err !== "object" || err.code !== "ENOENT") {
        console.error(`Cannot watch directory (${dir}):`, err.message);
      }
    }
  }

  async watch() {
    for (const source of this.sources) {
      for (const rootDir of sourceRoots(source, "watchRoots")) {
        this._watchDir(rootDir, source);
      }
    }
    console.log(`File system watcher enabled (${this._watchers.length} roots)`);
  }

  stopWatching() {
    clearTimeout(this._debounceTimer);
    for (const w of this._watchers) {
      w.close();
    }
    this._watchers = [];
    this._watchedDirs.clear();
  }

  _schedulePendingChanges(delay = DEBOUNCE_MS) {
    clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null;
      this.flushPendingChanges().catch((error) => {
        console.error("Cannot process pending session changes:", error.message);
      });
    }, delay);
  }

  _enqueueMutation(operation) {
    const run = this._mutationQueue.then(operation, operation);
    this._mutationQueue = run.catch(() => {});
    return run;
  }

  flushPendingChanges() {
    return this._enqueueMutation(() => this._processPendingChanges());
  }

  async _processPendingChanges() {
    const files = Array.from(this._pendingChanges);
    this._pendingChanges.clear();

    for (const filePath of files) {
      const key = this._filePathToKey.get(filePath);
      const source = this.sources.find((s) => isWithinRoot(filePath, s.rootDir));
      if (!source) continue;

      try {
        if (source.kind === "gemini") {
          await this._reloadGeminiSource(source);
          this._changeRetryCounts.delete(filePath);
          continue;
        }

        const detail = await this._parseFileSummary(filePath, source.kind);
        const summary = detail.summary;
        summary._key = sessionKey(summary.source_kind, summary.id);
        const existingKey = key || summary._key;
        const existingIndex = this.summaries.findIndex((s) => s._key === existingKey);
        if (existingIndex >= 0) {
          const needsKeyChange = existingKey !== summary._key;
          if (needsKeyChange) {
            this._removeSession(existingKey);
            this.summaries.push(summary);
            this.summaries.sort(compareSummariesDesc);
            this._indexSession(summary, detail.conversation_messages);
            this._notifyChange({ type: "session-added", summary });
          } else {
            this._unindexSessionText(existingKey);
            this.summaries[existingIndex] = summary;
            this.summaries.sort(compareSummariesDesc);
            this._detailCache.delete(existingKey);
            this._indexSession(summary, detail.conversation_messages);
            this._notifyChange({ type: "session-updated", summary });
          }
        } else {
          this.summaries.push(summary);
          this.summaries.sort(compareSummariesDesc);
          this._indexSession(summary, detail.conversation_messages);
          this._notifyChange({ type: "session-added", summary });
        }
        this.summaryByKey.set(summary._key, summary);
        if (!this.summaryById.has(summary.id)) {
          this.summaryById.set(summary.id, new Set());
        }
        this.summaryById.get(summary.id).add(summary._key);
        this._filePathToKey.set(summary.file_path, summary._key);
        this._changeRetryCounts.delete(filePath);
      } catch (err) {
        if (err && typeof err === "object" && err.code === "ENOENT") {
          const matchKey = key || this._filePathToKey.get(filePath);
          if (matchKey) {
            this._removeSession(matchKey);
            this._notifyChange({ type: "session-deleted", id: matchKey });
          }
          this._changeRetryCounts.delete(filePath);
          continue;
        }

        const attempt = (this._changeRetryCounts.get(filePath) || 0) + 1;
        this._changeRetryCounts.set(filePath, attempt);
        console.error(
          `Cannot update session file (${filePath}), attempt ${attempt}/${MAX_CHANGE_RETRIES}:`,
          err instanceof Error ? err.message : String(err)
        );
        if (attempt < MAX_CHANGE_RETRIES) {
          this._pendingChanges.add(filePath);
          this._schedulePendingChanges(CHANGE_RETRY_DELAY_MS * attempt);
        } else {
          this._changeRetryCounts.delete(filePath);
        }
      }
    }
  }

  async refresh() {
    return this._enqueueMutation(async () => {
      this._detailCache.clear();
      await this.initialize();
    });
  }
}
