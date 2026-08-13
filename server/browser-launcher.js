import { execFile } from "node:child_process";

export function localViewerUrl(host, port) {
  const address = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${address}:${port}`;
}

export function browserLaunchCommand(url, platform = process.platform) {
  if (platform === "win32") {
    return { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] };
  }
  if (platform === "darwin") {
    return { command: "open", args: [url] };
  }
  return { command: "xdg-open", args: [url] };
}

export async function isAllSessionsViewer(url, { fetchImpl = fetch } = {}) {
  try {
    const response = await fetchImpl(`${url}/api/capabilities`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(3_000)
    });
    if (!response.ok) return false;
    const payload = await response.json();
    return payload?.service?.name === "AllSessions" &&
      payload.service.protocol_version === 1 &&
      Boolean(payload.codex_maintenance);
  } catch {
    return false;
  }
}

export function openBrowser(url, { platform = process.platform, execFileImpl = execFile } = {}) {
  const { command, args } = browserLaunchCommand(url, platform);
  const child = execFileImpl(
    command,
    args,
    { detached: true, stdio: "ignore", windowsHide: true },
    (error) => {
      if (error) {
        console.warn(`Unable to open the browser automatically: ${error.message}`);
      }
    }
  );
  child.unref?.();
}
