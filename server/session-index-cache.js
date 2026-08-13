import crypto from "node:crypto";
import fss from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

const CACHE_VERSION = 8;
const CACHE_WRITE_CHUNK_CHARS = 1024 * 1024;
const CACHE_HEADER = `${JSON.stringify({ version: CACHE_VERSION })}\n`;

function fingerprint(stat) {
  return {
    size: stat.size,
    mtime_ms: Math.trunc(stat.mtimeMs)
  };
}

function hasCacheFingerprint(value) {
  return value &&
    typeof value === "object" &&
    typeof value.file_path === "string" &&
    typeof value.source_kind === "string" &&
    Number.isFinite(value.size) &&
    Number.isFinite(value.mtime_ms);
}

function isCacheEntry(value) {
  if (!hasCacheFingerprint(value)) return false;
  if (value.entry_type === "source_fragment") {
    return value.payload && typeof value.payload === "object";
  }
  return value.summary &&
    typeof value.summary === "object" &&
    typeof value.index_text === "string";
}

export class SessionIndexCache {
  constructor(filePath) {
    this.filePath = filePath ? path.resolve(filePath) : null;
    this.entries = new Map();
    this.dirty = false;
  }

  async load() {
    this.entries.clear();
    this.dirty = false;
    if (!this.filePath) return;
    try {
      const handle = await fs.open(this.filePath, "r");
      try {
        const header = Buffer.alloc(Buffer.byteLength(CACHE_HEADER));
        const { bytesRead } = await handle.read(header, 0, header.length, 0);
        if (bytesRead !== header.length || header.toString("utf8") !== CACHE_HEADER) return;
      } finally {
        await handle.close();
      }

      const input = fss.createReadStream(this.filePath, { encoding: "utf8" });
      const lines = readline.createInterface({ input, crlfDelay: Infinity });
      let headerSeen = false;

      for await (const line of lines) {
        if (!line.trim()) continue;
        const value = JSON.parse(line);
        if (!headerSeen) {
          headerSeen = true;
          if (value?.version !== CACHE_VERSION) {
            this.entries.clear();
            return;
          }
          continue;
        }
        if (isCacheEntry(value)) this.entries.set(value.file_path, value);
      }

      if (!headerSeen) this.entries.clear();
    } catch (error) {
      this.entries.clear();
      if (!error || typeof error !== "object" || error.code !== "ENOENT") {
        console.warn(`Cannot read session index cache (${this.filePath}):`, error.message);
      }
    }
  }

  get(filePath, sourceKind, stat) {
    const entry = this.entries.get(filePath);
    const current = fingerprint(stat);
    if (!entry ||
      entry.source_kind !== sourceKind ||
      entry.size !== current.size ||
      entry.mtime_ms !== current.mtime_ms) {
      return null;
    }
    return entry.entry_type === "source_fragment" ? null : entry;
  }

  getFragment(filePath, sourceKind, stat) {
    const entry = this.entries.get(filePath);
    const current = fingerprint(stat);
    if (!entry ||
      entry.entry_type !== "source_fragment" ||
      entry.source_kind !== sourceKind ||
      entry.size !== current.size ||
      entry.mtime_ms !== current.mtime_ms) {
      return null;
    }
    return entry.payload;
  }

  set(filePath, sourceKind, stat, summary, indexText) {
    this.entries.set(filePath, {
      file_path: filePath,
      source_kind: sourceKind,
      ...fingerprint(stat),
      summary,
      index_text: indexText
    });
    this.dirty = true;
  }

  setFragment(filePath, sourceKind, stat, payload) {
    this.entries.set(filePath, {
      entry_type: "source_fragment",
      file_path: filePath,
      source_kind: sourceKind,
      ...fingerprint(stat),
      payload
    });
    this.dirty = true;
  }

  retain(filePaths) {
    const retained = new Set(filePaths);
    for (const filePath of this.entries.keys()) {
      if (!retained.has(filePath)) {
        this.entries.delete(filePath);
        this.dirty = true;
      }
    }
  }

  release() {
    this.entries.clear();
    this.dirty = false;
  }

  async save() {
    if (!this.filePath || !this.dirty) return;
    const directory = path.dirname(this.filePath);
    const tempPath = path.join(
      directory,
      `.${path.basename(this.filePath)}.${process.pid}-${crypto.randomUUID()}.tmp`
    );
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    let handle;
    try {
      handle = await fs.open(tempPath, "wx", 0o600);
      let chunk = CACHE_HEADER;
      for (const entry of this.entries.values()) {
        chunk += `${JSON.stringify(entry)}\n`;
        if (chunk.length >= CACHE_WRITE_CHUNK_CHARS) {
          await handle.writeFile(chunk, "utf8");
          chunk = "";
        }
      }
      if (chunk) await handle.writeFile(chunk, "utf8");
      await handle.close();
      handle = null;
      await fs.rename(tempPath, this.filePath);
      await fs.chmod(this.filePath, 0o600);
      this.dirty = false;
    } catch (error) {
      await handle?.close().catch(() => {});
      await fs.rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
  }
}
