import fss from "node:fs";
import path from "node:path";

import { compareSummariesDesc, sortTimestampValue } from "./parsers/index.js";
import { ByteLruCache } from "./byte-lru-cache.js";
import { createSourceAdapter } from "./source-adapters.js";
import { SessionSearchIndex } from "./session-index.js";
import { SessionIndexCache } from "./session-index-cache.js";
import { dateKeyFromTimestamp, matchesSessionFilters } from "./session-query.js";

const DEBOUNCE_MS = 500;
const MAX_CHANGE_RETRIES = 3;
const CHANGE_RETRY_DELAY_MS = 750;

function sessionKey(sourceKind, id) {
  return `${sourceKind}:${id}`;
}

function isWithinRoot(filePath, rootDir) {
  const relativePath = path.relative(rootDir, filePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function projectNameFromCwd(cwd) {
  if (!cwd || typeof cwd !== "string") {
    return "";
  }
  return path.basename(cwd) || cwd;
}

const DEFAULT_DETAIL_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const DETAIL_CACHE_SIZE_MULTIPLIER = 2;

export class SessionStore {
  constructor({
    sources,
    detailCacheMaxBytes = DEFAULT_DETAIL_CACHE_MAX_BYTES,
    indexCacheFile = null
  }) {
    this.sources = sources;
    this._sourceAdapters = sources.map((source) => createSourceAdapter(source));
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

    for (const adapter of this._sourceAdapters) {
      const initialized = await adapter.initialize({
        indexCache: this._indexCache,
        onCacheHit: () => { this.cacheStats.hits += 1; },
        onCacheMiss: () => { this.cacheStats.misses += 1; }
      });
      for (const filePath of initialized.files) discoveredCacheFiles.add(filePath);
      for (const result of initialized.records) {
        if (result.cached) {
          this._addCachedSession(result.cached.summary, result.cached.index_text);
          continue;
        }
        const summary = this._addSessionDetail(result.detail);
        if (result.filePath && result.stat) {
          this._indexCache.set(
            result.filePath,
            adapter.kind,
            result.stat,
            summary,
            this._searchIndex.getText(summary._key)
          );
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
      sources: this._sourceAdapters.map((adapter) => ({
        kind: adapter.kind,
        display_name: adapter.source.displayName || adapter.kind
      })),
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

    const adapter = this._sourceAdapters.find(
      (candidate) => candidate.kind === summary.source_kind && candidate.contains(summary.file_path)
    ) || this._sourceAdapters.find((candidate) => candidate.kind === summary.source_kind);
    if (!adapter) return null;
    const { detail, sourceBytes } = await adapter.getDetail(summary);
    if (!detail) return null;
    detail.summary._key = summary._key;

    const estimatedBytes = sourceBytes > 0
      ? Math.max(1, sourceBytes * DETAIL_CACHE_SIZE_MULTIPLIER)
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

  _watchDir(dir) {
    if (this._watchedDirs.has(dir)) return;
    try {
      const watcher = fss.watch(dir, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        const fullPath = path.resolve(dir, String(filename));
        if (!isWithinRoot(fullPath, dir)) return;
        const isTargetFile = this._sourceAdapters.some(
          (adapter) => adapter.contains(fullPath) && adapter.matches(fullPath)
        );
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
    for (const adapter of this._sourceAdapters) {
      for (const rootDir of adapter.watchRoots()) {
        this._watchDir(rootDir);
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
      const adapter = this._sourceAdapters.find((candidate) => candidate.contains(filePath) && candidate.matches(filePath));
      if (!adapter) continue;

      try {
        const update = await adapter.handleChange(filePath, key);
        const previousKeys = new Set(update.replaceKeys);
        for (const replaceKey of previousKeys) this._removeSession(replaceKey);

        const nextKeys = new Set();
        for (const detail of update.details) {
          const summary = this._addSessionDetail(detail);
          nextKeys.add(summary._key);
          this._notifyChange({
            type: previousKeys.has(summary._key) ? "session-updated" : "session-added",
            summary
          });
        }
        for (const previousKey of previousKeys) {
          if (!nextKeys.has(previousKey)) this._notifyChange({ type: "session-deleted", id: previousKey });
        }
        this.summaries.sort(compareSummariesDesc);
        this._changeRetryCounts.delete(filePath);
      } catch (err) {
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
