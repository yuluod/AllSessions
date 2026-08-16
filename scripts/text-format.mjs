export function normalizeNewlines(value) {
  return String(value).replace(/\r\n?/g, "\n");
}
