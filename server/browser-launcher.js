import { execFile } from "node:child_process";

export function localViewerUrl(host, port) {
  const address = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${address}:${port}`;
}

export function browserLaunchCommand(url, platform = process.platform) {
  if (platform === "win32") {
    return { command: "explorer.exe", args: [url] };
  }
  if (platform === "darwin") {
    return { command: "open", args: [url] };
  }
  return { command: "xdg-open", args: [url] };
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
