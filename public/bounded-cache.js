// 按估算字节数和条目数双重限制的 LRU，避免缓存随阅读历史无限增长。
export function createBoundedCache({
  maxEntries = 128,
  maxBytes = 4 * 1024 * 1024,
} = {}) {
  const entries = new Map();
  let bytes = 0;
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },
    set(key, value, size) {
      if (!Number.isFinite(size) || size < 0 || size > maxBytes) return;
      const old = entries.get(key);
      if (old) bytes -= old.size;
      entries.delete(key);
      entries.set(key, { value, size });
      bytes += size;
      while (entries.size > maxEntries || bytes > maxBytes) {
        const oldest = entries.keys().next().value;
        bytes -= entries.get(oldest).size;
        entries.delete(oldest);
      }
    },
    clear() {
      entries.clear();
      bytes = 0;
    },
    get size() {
      return entries.size;
    },
    get bytes() {
      return bytes;
    },
  };
}
