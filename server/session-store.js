import fs from "node:fs/promises";
import fss from "node:fs";
import path from "node:path";

import { compareSummariesDesc, parseSessionFile } from "./session-parser.js";

const DEBOUNCE_MS = 500;

async function collectJsonlFiles(rootDir) {
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
        return collectJsonlFiles(fullPath);
      }
      if (entry.isFile() && fullPath.endsWith(".jsonl")) {
        return [fullPath];
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
  constructor({ sessionRoot }) {
    this.sessionRoot = sessionRoot;
    this.summaries = [];
    this.summaryById = new Map();
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
    const files = await collectJsonlFiles(this.sessionRoot);
    const parsed = await Promise.all(
      files.map(async (filePath) => {
        return parseSessionFile(filePath);
      })
    );

    this.summaries = parsed.map((d) => d.summary).sort(compareSummariesDesc);
    this.summaryById = new Map(this.summaries.map((summary) => [summary.id, summary]));

    this._searchIndex.clear();
    this._sessionTexts.clear();
    for (const detail of parsed) {
      this._indexSessionText(detail.summary.id, detail.conversation_messages);
    }
  }

  _indexSessionText(sessionId, messages) {
    const allText = messages.map((m) => m.text).join(" ");
    this._sessionTexts.set(sessionId, allText);
    const tokens = tokenize(allText);
    const uniqueTokens = new Set(tokens);
    for (const token of uniqueTokens) {
      if (!this._searchIndex.has(token)) {
        this._searchIndex.set(token, new Set());
      }
      this._searchIndex.get(token).add(sessionId);
    }
  }

  _unindexSessionText(sessionId) {
    const text = this._sessionTexts.get(sessionId);
    if (!text) return;
    const tokens = tokenize(text);
    const uniqueTokens = new Set(tokens);
    for (const token of uniqueTokens) {
      const ids = this._searchIndex.get(token);
      if (ids) {
        ids.delete(sessionId);
        if (ids.size === 0) {
          this._searchIndex.delete(token);
        }
      }
    }
    this._sessionTexts.delete(sessionId);
  }

  _removeSession(sessionId) {
    this.summaries = this.summaries.filter((s) => s.id !== sessionId);
    this.summaryById.delete(sessionId);
    this._detailCache.delete(sessionId);
    this._unindexSessionText(sessionId);
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
      for (const [indexWord, ids] of this._searchIndex) {
        if (indexWord.includes(token)) {
          for (const id of ids) matched.add(id);
        }
      }
      return matched;
    });

    let intersection = resultSets[0];
    for (let i = 1; i < resultSets.length; i++) {
      intersection = new Set([...intersection].filter((id) => resultSets[i].has(id)));
    }

    const summaries = [];
    for (const id of intersection) {
      const summary = this.summaryById.get(id);
      if (summary) summaries.push(summary);
    }

    return summaries.sort(compareSummariesDesc);
  }

  listSessions(filters = {}, { limit, cursor } = {}) {
    let filtered = this.summaries.filter((summary) => matchesFilter(summary, filters));

    if (cursor) {
      const cursorIndex = filtered.findIndex((s) => s.id === cursor);
      if (cursorIndex >= 0) {
        filtered = filtered.slice(cursorIndex + 1);
      }
    }

    const hasMore = typeof limit === "number" && limit > 0 && filtered.length > limit;
    const sessions = hasMore ? filtered.slice(0, limit) : filtered;
    const nextCursor = hasMore && sessions.length > 0 ? sessions[sessions.length - 1].id : null;

    return { sessions, has_more: hasMore, next_cursor: nextCursor };
  }

  getFacets() {
    const providers = new Set();
    const dates = new Set();
    const cwds = new Set();

    this.summaries.forEach((summary) => {
      if (summary.model_provider) {
        providers.add(summary.model_provider);
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
      dates: Array.from(dates).sort().reverse(),
      cwds: Array.from(cwds).sort()
    };
  }

  async getSessionDetail(id) {
    const summary = this.summaryById.get(id);
    if (!summary) {
      return null;
    }

    if (this._detailCache.has(id)) {
      const cached = this._detailCache.get(id);
      this._detailCache.delete(id);
      this._detailCache.set(id, cached);
      return cached;
    }

    const detail = await parseSessionFile(summary.file_path);

    if (this._detailCache.size >= LRU_MAX) {
      const oldest = this._detailCache.keys().next().value;
      this._detailCache.delete(oldest);
    }
    this._detailCache.set(id, detail);

    return detail;
  }

  onChange(callback) {
    this._onChangeCallbacks.push(callback);
  }

  _notifyChange(event) {
    this._onChangeCallbacks.forEach((cb) => cb(event));
  }

  _watchDir(dir) {
    if (this._watchedDirs.has(dir)) return;
    try {
      const watcher = fss.watch(dir, (eventType, filename) => {
        if (!filename) return;
        const fullPath = path.join(dir, filename);
        if (filename.endsWith(".jsonl")) {
          clearTimeout(this._debounceTimer);
          this._pendingChanges.add(fullPath);
          this._debounceTimer = setTimeout(() => this._processPendingChanges(), DEBOUNCE_MS);
          return;
        }
        try {
          const stat = fss.statSync(fullPath);
          if (stat.isDirectory()) {
            this._watchRecursive(fullPath);
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

  async _watchRecursive(rootDir) {
    this._watchDir(rootDir);
    let entries = [];
    try {
      entries = await fs.readdir(rootDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await this._watchRecursive(path.join(rootDir, entry.name));
      }
    }
  }

  async watch() {
    await this._watchRecursive(this.sessionRoot);
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
      try {
        const detail = await parseSessionFile(filePath);
        const summary = detail.summary;
        const existingIndex = this.summaries.findIndex((s) => s.id === summary.id);
        if (existingIndex >= 0) {
          this._unindexSessionText(summary.id);
          this.summaries[existingIndex] = summary;
          this.summaries.sort(compareSummariesDesc);
          this._detailCache.delete(summary.id);
          this._indexSessionText(summary.id, detail.conversation_messages);
          this._notifyChange({ type: "session-updated", summary });
        } else {
          this.summaries.push(summary);
          this.summaries.sort(compareSummariesDesc);
          this._indexSessionText(summary.id, detail.conversation_messages);
          this._notifyChange({ type: "session-added", summary });
        }
        this.summaryById.set(summary.id, summary);
      } catch (err) {
        if (err && typeof err === "object" && err.code === "ENOENT") {
          const match = this.summaries.find((s) => s.file_path === filePath);
          if (match) {
            this._removeSession(match.id);
            this._notifyChange({ type: "session-deleted", id: match.id });
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
