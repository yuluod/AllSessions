let mutationToken = "";

export function setMutationToken(token) {
  mutationToken = typeof token === "string" ? token : "";
}

export async function fetchJson(url, options = {}, { formatError } = {}) {
  const { mutation = false, headers, ...fetchOptions } = options;
  const nextHeaders = new Headers(headers || {});
  if (mutation && mutationToken) {
    nextHeaders.set("X-Session-Viewer-Token", mutationToken);
  }
  const response = await fetch(url, {
    ...fetchOptions,
    headers: nextHeaders
  });
  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(errorBody || (formatError ? formatError(response.status) : `Request failed: ${response.status}`));
  }
  return response.json();
}
