import net from "node:net";

export function isLoopbackHost(host) {
  const normalized = String(host || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  if (net.isIPv4(normalized)) return normalized.startsWith("127.");
  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice("::ffff:".length);
    return net.isIPv4(mapped) && mapped.startsWith("127.");
  }
  return false;
}

export function assertLocalOnlyHost(host) {
  if (!isLoopbackHost(host)) {
    throw new Error(
      `AllSessions is local-only and has no remote authentication; HOST must be a loopback address, received: ${host || "(empty)"}`
    );
  }
}

export function assertValidPort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`PORT must be an integer between 1 and 65535, received: ${port}`);
  }
}

export function listenForHttpRequests(server, { host, port }) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.off("error", onError);
      server.off("listening", onListening);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onListening = () => {
      cleanup();
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    try {
      server.listen(port, host);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}
