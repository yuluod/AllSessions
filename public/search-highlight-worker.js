// 原始正则只在可终止的 Worker 中执行，主线程仅消费匹配区间。
self.onmessage = ({ data: { texts, query } }) => {
  try {
    const pattern = new RegExp(query, "giu");
    let count = 0;
    const ranges = texts.map((text) => {
      const matches = [];
      for (const match of text.matchAll(pattern)) {
        if (!match[0].length) continue;
        if (++count > 10_000) {
          throw new RangeError("limit");
        }
        matches.push([match.index, match.index + match[0].length]);
      }
      return matches;
    });
    self.postMessage({ ranges });
  } catch (error) {
    self.postMessage({
      error: error instanceof RangeError ? "limit" : "invalid",
    });
  }
};
