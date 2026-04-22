import fs from "node:fs/promises";
import fss from "node:fs";
import path from "node:path";

import { compareSummariesDesc, parseFile } from "./parsers/index.js";

const DEBOUNCE_MS = 500;

function sessionKey(sourceKind, id) {
  return `${sourceKind}:${id}`;
}

async function collectFiles(rootDir, pattern) {
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
        return collectFiles(fullPath, pattern);
      }
      if (entry.isFile()) {
        if (pattern === "**/*.jsonl" && fullPath.endsWith(".jsonl")) {
          return [fullPath];
        }
        if (pattern === "sessions/*.json" && fullPath.endsWith(".json") && rootDir.endsWith("sessions")) {
          return [fullPath];
        }
      }
      return [];
    })
  );

  return files.flat();
}

function dateKeyFromTimestamp(timestamp) {
  if (typeof timestamp !== "string" || timestamp.length < 10) {
    return "";
  }
  return timestamp.slice(0, 10);
}

function matchesFilter(summary, filters) {
  if (filters.provider && summary.model_provider !== filters.provider) {
    return false;
  }
  if (filters.source_kind && summary.source_kind !== filters.source_kind) {
    return false;
  }
  if (filters.date && dateKeyFromTimestamp(summary.timestamp || summary.last_timestamp) !== filters.date) {
    return false;
  }
  if (filters.cwd && summary.cwd !== filters.cwd) {
    return false;
  }
  return true;
}

const LRU_MAX = 50;
const MIN_WORD_LENGTH = 2;

function tokenize(text) {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .split(/[^a-zA-Z0-9\u4e00-\u9fff]+/)
    .filter((w) => w.length >= MIN_WORD_LENGTH);
}

export class SessionStore {
  constructor({ sources }) {
    this.sources = sources;
    this.summaries = [];
    this.summaryByKey = new Map();
    this.summaryById = new Map();
    this._filePathToKey = new Map();
    this._detailCache = new Map();
    this._watchers = [];
    this._watchedDirs = new Set();
    this._debounceTimer = null;
    this._pendingChanges = new Set();
    this._onChangeCallbacks = [];
    this._searchIndex = new Map();
    this._sessionTexts = new Map();
  }

  async initialize() {
    this.summaries = [];
    this.summaryByKey.clear();
    this.summaryById.clear();
    this._filePathToKey.clear();
    this._searchIndex.clear();
    this._sessionTexts.clear();

    for (const source of this.sources) {
      const files = await collectFiles(source.rootDir, source.filePattern);
      const parsed = await Promise.all(
        files.map(async (filePath) => {
          return parseFile(filePath, source.kind);
        })
      );

      for (const detail of parsed) {
        const summary = detail.summary;
        const key = sessionKey(summary.source_kind, summary.id);
        summary._key = key;
        this.summaries.push(summary);
        this.summaryByKey.set(key, summary);
        this.summaryById.set(summary.id, summary);
        this._filePathToKey.set(summary.file_path, key);
        this._indexSessionText(key, detail.conversation_messages);
      }
    }

    this.summaries.sort(compareSummariesDesc);
  }

  _indexSessionText(key, messages) {
    const allText = messages.map((m) => m.text).join(" ");
    this._sessionTexts.set(key, allText);
    const tokens = tokenize(allText);
    const uniqueTokens = new Set(tokens);
    for (const token of uniqueTokens) {
      if (!this._searchIndex.has(token)) {
        this._searchIndex.set(token, new Set());
      }
      this._searchIndex.get(token).add(key);
    }
  }

  _unindexSessionText(key) {
    const text = this._sessionTexts.get(key);
    if (!text) return;
    const tokens = tokenize(text);
    const uniqueTokens = new Set(tokens);
    for (const token of uniqueTokens) {
      const ids = this._searchIndex.get(token);
      if (ids) {
        ids.delete(key);
        if (ids.size === 0) {
          this._searchIndex.delete(token);
        }
      }
    }
    this._sessionTexts.delete(key);
  }

  _removeSession(key) {
    this.summaries = this.summaries.filter((s) => s._key !== key);
    const summary = this.summaryByKey.get(key);
    if (summary) {
      this.summaryByKey.delete(key);
      this.summaryById.delete(summary.id);
      this._filePathToKey.delete(summary.file_path);
    }
    this._detailCache.delete(key);
    this._unindexSessionText(key);
  }

  search(query) {
    if (!query || typeof query !== "string") {
      return [];
    }
    const tokens = tokenize(query);
    if (tokens.length === 0) {
      return [];
    }

    let resultSets = tokens.map((token) => {
      const matched = new Set();
      for (const [indexWord, keys] of this._searchIndex) {
        if (indexWord.includes(token)) {
          for (const key of keys) matched.add(key);
        }
      }
      return matched;
    });

    let intersection = resultSets[0];
    for (let i = 1; i < resultSets.length; i++) {
      intersection = new Set([...intersection].filter((key) => resultSets[i].has(key)));
    }

    const summaries = [];
    for (const key of intersection) {
      const summary = this.summaryByKey.get(key);
      if (summary) summaries.push(summary);
    }

    return summaries.sort(compareSummariesDesc);
  }

  listSessions(filters = {}, { limit, cursor } = {}) {
    let filtered = this.summaries.filter((summary) => matchesFilter(summary, filters));

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
      }
    });

    return {
      providers: Array.from(providers).sort(),
      source_kinds: Array.from(sourceKinds).sort(),
      dates: Array.from(dates).sort().reverse(),
      cwds: Array.from(cwds).sort()
    };
  }

  async getSessionDetail(key) {
    const summary = this.summaryByKey.get(key) || this.summaryById.get(key);
    if (!summary) {
      return null;
    }

    if (this._detailCache.has(summary._key)) {
      const cached = this._detailCache.get(summary._key);
      this._detailCache.delete(summary._key);
      this._detailCache.set(summary._key, cached);
      return cached;
    }

    const detail = await parseFile(summary.file_path, summary.source_kind);

    if (this._detailCache.size >= LRU_MAX) {
      const oldest = this._detailCache.keys().next().value;
      this._detailCache.delete(oldest);
    }
    this._detailCache.set(summary._key, detail);

    return detail;
  }

  onChange(callback) {
    this._onChangeCallbacks.push(callback);
  }

  _notifyChange(event) {
    this._onChangeCallbacks.forEach((cb) => cb(event));
  }

  _watchDir(dir, source) {
    if (this._watchedDirs.has(dir)) return;
    try {
      const watcher = fss.watch(dir, (eventType, filename) => {
        if (!filename) return;
        const fullPath = path.join(dir, filename);
        const isTargetFile =
          (source.filePattern === "**/*.jsonl" && filename.endsWith(".jsonl")) ||
          (source.filePattern === "sessions/*.json" && filename.endsWith(".json"));
        if (isTargetFile) {
          clearTimeout(this._debounceTimer);
          this._pendingChanges.add(fullPath);
          this._debounceTimer = setTimeout(() => this._processPendingChanges(), DEBOUNCE_MS);
          return;
        }
        try {
          const stat = fss.statSync(fullPath);
          if (stat.isDirectory()) {
            this._watchRecursive(fullPath, source);
          }
        } catch { /* ignore */ }
      });
      watcher.on("error", (err) => {
        console.error(`File watcher error (${dir}):`, err.message);
      });
      this._watchedDirs.add(dir);
      this._watchers.push(watcher);
    } catch (err) {
      console.error(`Cannot watch directory (${dir}):`, err.message);
    }
  }

  async _watchRecursive(rootDir, source) {
    this._watchDir(rootDir, source);
    let entries = [];
    try {
      entries = await fs.readdir(rootDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await this._watchRecursive(path.join(rootDir, entry.name), source);
      }
    }
  }

  async watch() {
    for (const source of this.sources) {
      await this._watchRecursive(source.rootDir, source);
    }
    console.log("File system watcher enabled");
  }

  stopWatching() {
    clearTimeout(this._debounceTimer);
    for (const w of this._watchers) {
      w.close();
    }
    this._watchers = [];
    this._watchedDirs.clear();
  }

  async _processPendingChanges() {
    const files = Array.from(this._pendingChanges);
    this._pendingChanges.clear();

    for (const filePath of files) {
      const key = this._filePathToKey.get(filePath);
      const source = this.sources.find((s) => filePath.startsWith(s.rootDir));
      if (!source) continue;

      try {
        const detail = await parseFile(filePath, source.kind);
        const summary = detail.summary;
        summary._key = sessionKey(summary.source_kind, summary.id);
        const existingKey = key || summary._key;
        const existingIndex = this.summaries.findIndex((s) => s._key === existingKey);
        if (existingIndex >= 0) {
          this._unindexSessionText(existingKey);
          this.summaries[existingIndex] = summary;
          this.summaries.sort(compareSummariesDesc);
          this._detailCache.delete(existingKey);
          this._indexSessionText(existingKey, detail.conversation_messages);
          this._notifyChange({ type: "session-updated", summary });
        } else {
          this.summaries.push(summary);
          this.summaries.sort(compareSummariesDesc);
          this._indexSessionText(summary._key, detail.conversation_messages);
          this._notifyChange({ type: "session-added", summary });
        }
        this.summaryByKey.set(summary._key, summary);
        this.summaryById.set(summary.id, summary);
        this._filePathToKey.set(summary.file_path, summary._key);
      } catch (err) {
        if (err && typeof err === "object" && err.code === "ENOENT") {
          const matchKey = key || this._filePathToKey.get(filePath);
          if (matchKey) {
            this._removeSession(matchKey);
            this._notifyChange({ type: "session-deleted", id: matchKey });
          }
        }
      }
    }
  }

  async refresh() {
    this._detailCache.clear();
    await this.initialize();
  }
}
