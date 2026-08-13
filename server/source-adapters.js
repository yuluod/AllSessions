import fs from "node:fs/promises";
import path from "node:path";

import { parseFile, parseFileSummary } from "./parsers/index.js";
import { buildGeminiSessions, parseGeminiLogFile } from "./parsers/gemini.js";

const MAX_COLLECT_DEPTH = 15;

function isWithinRoot(filePath, rootDir) {
  const relativePath = path.relative(rootDir, filePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function sourceRoots(source, property) {
  const configured = Array.isArray(source[property]) && source[property].length > 0
    ? source[property]
    : [source.rootDir];
  return Array.from(new Set(configured.filter(Boolean).map((rootDir) => path.resolve(rootDir))));
}

function defaultMatch(source, filePath) {
  if (source.filePattern === "**/*.jsonl") return filePath.endsWith(".jsonl");
  if (source.filePattern === "sessions/*.json") {
    return filePath.endsWith(".json") && path.basename(path.dirname(filePath)) === "sessions";
  }
  if (source.filePattern === "tmp/*/logs.json") {
    const parts = path.relative(source.rootDir, filePath).split(path.sep);
    return parts.length === 3 && parts[0] === "tmp" && parts[2] === "logs.json";
  }
  return false;
}

async function collectFiles(rootDir, matches, depth = 0) {
  if (depth > MAX_COLLECT_DEPTH) {
    console.warn(`collectFiles: max depth ${MAX_COLLECT_DEPTH} reached at ${rootDir}, skipping deeper entries`);
    return [];
  }
  let entries;
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return [];
    throw error;
  }
  const nested = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) return collectFiles(fullPath, matches, depth + 1);
    return entry.isFile() && matches(fullPath) ? [fullPath] : [];
  }));
  return nested.flat();
}

class SourceAdapter {
  constructor(source) {
    this.source = source;
  }

  get kind() {
    return this.source.kind;
  }

  discoveryRoots() {
    return sourceRoots(this.source, "discoveryRoots");
  }

  watchRoots() {
    return sourceRoots(this.source, "watchRoots");
  }

  contains(filePath) {
    return this.watchRoots().some((rootDir) => isWithinRoot(filePath, rootDir));
  }

  matches(filePath) {
    return typeof this.source.matchFn === "function"
      ? this.source.matchFn(filePath)
      : defaultMatch(this.source, filePath);
  }

  async discoverFiles() {
    const groups = await Promise.all(this.discoveryRoots().map((rootDir) => collectFiles(rootDir, (file) => this.matches(file))));
    return Array.from(new Set(groups.flat())).sort();
  }
}

class FileSourceAdapter extends SourceAdapter {
  async initialize({ indexCache, onCacheHit, onCacheMiss }) {
    const files = await this.discoverFiles();
    const records = [];
    for (let start = 0; start < files.length; start += 4) {
      const batch = files.slice(start, start + 4);
      const parsed = await Promise.all(batch.map(async (filePath) => {
        const stat = await fs.stat(filePath).catch((error) => {
          if (error && typeof error === "object" && error.code === "ENOENT") return null;
          throw error;
        });
        if (!stat) return null;
        const cached = indexCache.get(filePath, this.kind, stat);
        if (cached) {
          onCacheHit();
          return { cached: { ...cached, summary: { ...cached.summary, file_path: filePath } } };
        }
        onCacheMiss();
        try {
          const detail = await parseFileSummary(filePath, this.kind);
          return { detail, filePath, stat };
        } catch (error) {
          console.error(`Cannot parse session file (${filePath}): ${error instanceof Error ? error.message : String(error)}`);
          return null;
        }
      }));
      records.push(...parsed.filter(Boolean));
    }
    return { files, records };
  }

  async handleChange(filePath, existingKey) {
    try {
      const detail = await parseFileSummary(filePath, this.kind);
      return { replaceKeys: existingKey ? [existingKey] : [], details: [detail] };
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") {
        return { replaceKeys: existingKey ? [existingKey] : [], details: [] };
      }
      throw error;
    }
  }

  async getDetail(summary) {
    const detail = await parseFile(summary.file_path, this.kind);
    const stat = await fs.stat(summary.file_path).catch(() => null);
    return { detail, sourceBytes: stat?.size || 0 };
  }
}

class GeminiSourceAdapter extends SourceAdapter {
  constructor(source) {
    super(source);
    this.fragments = new Map();
    this.parseLogFile = parseGeminiLogFile;
  }

  async initialize({ indexCache, onCacheHit, onCacheMiss }) {
    this.fragments.clear();
    const files = await this.discoverFiles();
    for (const filePath of files) {
      const stat = await fs.stat(filePath).catch((error) => {
        if (error && typeof error === "object" && error.code === "ENOENT") return null;
        throw error;
      });
      if (!stat) continue;
      const cached = indexCache.getFragment(filePath, this.kind, stat);
      if (cached && Array.isArray(cached.entries)) {
        onCacheHit();
        this.fragments.set(filePath, cached.entries);
        continue;
      }
      onCacheMiss();
      try {
        const entries = await this.parseLogFile(filePath);
        this.fragments.set(filePath, entries);
        indexCache.setFragment(filePath, this.kind, stat, { entries });
      } catch (error) {
        console.error(`Cannot parse session file (${filePath}): ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const details = await buildGeminiSessions(this.source.rootDir, this.fragments);
    return { files, records: details.map((detail) => ({ detail })) };
  }

  async handleChange(filePath) {
    const previous = this.fragments.get(filePath) || [];
    let next = [];
    try {
      next = await this.parseLogFile(filePath);
    } catch (error) {
      if (!error || typeof error !== "object" || error.code !== "ENOENT") throw error;
    }
    const affectedIds = new Set([...previous, ...next].map((entry) => entry.sessionId).filter(Boolean));
    if (next.length > 0) this.fragments.set(filePath, next);
    else this.fragments.delete(filePath);
    const details = await buildGeminiSessions(this.source.rootDir, this.fragments, affectedIds);
    return {
      replaceKeys: [...affectedIds].map((id) => `${this.kind}:${id}`),
      details
    };
  }

  async getDetail(summary) {
    const [detail] = await buildGeminiSessions(this.source.rootDir, this.fragments, [summary.id]);
    if (!detail) return { detail: null, sourceBytes: 0 };
    const paths = [...this.fragments]
      .filter(([, entries]) => entries.some((entry) => entry.sessionId === summary.id))
      .map(([filePath]) => filePath);
    const stats = await Promise.all(paths.map((filePath) => fs.stat(filePath).catch(() => null)));
    return { detail, sourceBytes: stats.reduce((sum, stat) => sum + (stat?.size || 0), 0) };
  }
}

const ADAPTERS = new Map([
  ["codex", FileSourceAdapter],
  ["codex_archived", FileSourceAdapter],
  ["claude_code", FileSourceAdapter],
  ["gemini", GeminiSourceAdapter]
]);

export function createSourceAdapter(source) {
  const Adapter = ADAPTERS.get(source.kind);
  if (!Adapter) throw new Error(`Unknown source kind: ${source.kind}`);
  return new Adapter(source);
}
