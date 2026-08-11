export class ByteLruCache {
  constructor(maxBytes) {
    this.maxBytes = Math.max(0, Number(maxBytes) || 0);
    this.entries = new Map();
    this.bytes = 0;
  }

  get size() {
    return this.entries.size;
  }

  has(key) {
    return this.entries.has(key);
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key, value, byteSize) {
    const size = Math.max(0, Number(byteSize) || 0);
    this.delete(key);
    if (size > this.maxBytes || this.maxBytes === 0) return false;

    this.entries.set(key, { value, size });
    this.bytes += size;
    while (this.bytes > this.maxBytes && this.entries.size > 0) {
      const oldestKey = this.entries.keys().next().value;
      this.delete(oldestKey);
    }
    return this.entries.has(key);
  }

  delete(key) {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.entries.delete(key);
    this.bytes -= entry.size;
    return true;
  }

  clear() {
    this.entries.clear();
    this.bytes = 0;
  }
}
