import AppKit
import CryptoKit
import Foundation

private struct GitHubRelease: Decodable {
    let tag_name: String
    let assets: [GitHubAsset]
}

private struct GitHubAsset: Decodable {
    let name: String
    let browser_download_url: String
    let digest: String?
    let size: Int64
}

@main
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let viewerURL = URL(string: "http://127.0.0.1:3210")!
    private let latestReleaseURL = URL(string: "https://api.github.com/repos/yuluod/AllSessions/releases/latest")!
    private var serverProcess: Process?
    private var statusItem: NSStatusItem!
    private var checkUpdatesItem: NSMenuItem!
    private var startupTimer: Timer?
    private var startupChecks = 0

    private var appRoot: URL {
        Bundle.main.resourceURL!.appendingPathComponent("app", isDirectory: true)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        createStatusItem()
        checkViewer { [weak self] available in
            guard let self else { return }
            if available {
                self.openViewer()
            } else {
                self.startServer()
                self.waitForServer()
            }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        stopServer()
    }

    private func createStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = statusItem.button {
            let iconURL = appRoot.appendingPathComponent("public/assets/allsessions-icon-v2.png")
            if let image = NSImage(contentsOf: iconURL) {
                image.size = NSSize(width: 18, height: 18)
                button.image = image
            } else {
                button.title = "AS"
            }
            button.toolTip = "AllSessions"
        }

        let menu = NSMenu()
        menu.addItem(withTitle: "打开 AllSessions", action: #selector(openViewerAction), keyEquivalent: "")
        checkUpdatesItem = menu.addItem(withTitle: "检查更新", action: #selector(checkForUpdatesAction), keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: "退出", action: #selector(exitAction), keyEquivalent: "q")
        menu.items.forEach { $0.target = self }
        statusItem.menu = menu
    }

    private func startServer() {
        let process = Process()
        process.executableURL = appRoot.appendingPathComponent("runtime/bin/node")
        process.arguments = [appRoot.appendingPathComponent("server/index.js").path]
        process.currentDirectoryURL = appRoot
        var environment = ProcessInfo.processInfo.environment
        environment["ALLSESSIONS_OPEN_BROWSER"] = "0"
        process.environment = environment
        do {
            try process.run()
            serverProcess = process
        } catch {
            showError(title: "AllSessions 启动失败", message: error.localizedDescription)
        }
    }

    private func waitForServer() {
        startupTimer?.invalidate()
        startupChecks = 0
        startupTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] timer in
            guard let self else {
                timer.invalidate()
                return
            }
            self.startupChecks += 1
            self.checkViewer { available in
                if available {
                    timer.invalidate()
                    self.openViewer()
                } else if self.serverProcess?.isRunning == false {
                    timer.invalidate()
                    self.showError(title: "AllSessions 启动失败", message: "后台服务已退出，请确认端口 3210 未被占用。")
                } else if self.startupChecks >= 120 {
                    timer.invalidate()
                    self.showError(title: "AllSessions 启动失败", message: "后台服务启动超时。")
                }
            }
        }
    }

    private func checkViewer(completion: @escaping (Bool) -> Void) {
        var request = URLRequest(url: viewerURL.appendingPathComponent("api/capabilities"))
        request.timeoutInterval = 1
        URLSession.shared.dataTask(with: request) { _, response, _ in
            let available = (response as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async { completion(available) }
        }.resume()
    }

    @objc private func openViewerAction() {
        openViewer()
    }

    private func openViewer() {
        NSWorkspace.shared.open(viewerURL)
    }

    @objc private func checkForUpdatesAction() {
        setUpdateState(title: "正在检查更新…", enabled: false)
        var request = URLRequest(url: latestReleaseURL)
        request.setValue("AllSessions-macOS-Launcher", forHTTPHeaderField: "User-Agent")
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        URLSession.shared.dataTask(with: request) { [weak self] data, _, error in
            guard let self else { return }
            do {
                if let error { throw error }
                guard let data else { throw UpdateError("GitHub 没有返回更新数据。") }
                let release = try JSONDecoder().decode(GitHubRelease.self, from: data)
                let currentVersion = try self.readCurrentVersion()
                let releaseVersion = self.normalizedVersion(release.tag_name)
                guard releaseVersion.compare(currentVersion, options: .numeric) == .orderedDescending else {
                    DispatchQueue.main.async {
                        self.showInfo(title: "AllSessions 更新", message: "当前版本 v\(currentVersion) 已是最新版本。")
                        self.resetUpdateState()
                    }
                    return
                }

                let assetName = "AllSessions-\(releaseVersion)-mac-\(self.packageArchitecture()).pkg"
                guard let asset = release.assets.first(where: { $0.name.caseInsensitiveCompare(assetName) == .orderedSame }) else {
                    throw UpdateError("新版本中没有找到安装包：\(assetName)")
                }
                DispatchQueue.main.async {
                    let alert = NSAlert()
                    alert.messageText = "发现新版本 \(release.tag_name)"
                    alert.informativeText = "是否立即下载并安装？"
                    alert.addButton(withTitle: "下载并安装")
                    alert.addButton(withTitle: "取消")
                    NSApp.activate(ignoringOtherApps: true)
                    if alert.runModal() == .alertFirstButtonReturn {
                        self.downloadAndInstall(tag: release.tag_name, asset: asset)
                    } else {
                        self.resetUpdateState()
                    }
                }
            } catch {
                DispatchQueue.main.async {
                    self.showError(title: "AllSessions 更新", message: "检查更新失败：\(error.localizedDescription)")
                    self.resetUpdateState()
                }
            }
        }.resume()
    }

    private func downloadAndInstall(tag: String, asset: GitHubAsset) {
        guard let url = URL(string: asset.browser_download_url), url.scheme == "https", url.host == "github.com" else {
            showError(title: "AllSessions 更新", message: "更新包下载地址无效。")
            resetUpdateState()
            return
        }
        setUpdateState(title: "正在下载 \(tag)…", enabled: false)
        var request = URLRequest(url: url)
        request.setValue("AllSessions-macOS-Launcher", forHTTPHeaderField: "User-Agent")
        URLSession.shared.downloadTask(with: request) { [weak self] temporaryURL, _, error in
            guard let self else { return }
            do {
                if let error { throw error }
                guard let temporaryURL else { throw UpdateError("下载的安装程序不存在。") }
                let updateDirectory = FileManager.default.temporaryDirectory
                    .appendingPathComponent("AllSessions/updates", isDirectory: true)
                try FileManager.default.createDirectory(at: updateDirectory, withIntermediateDirectories: true)
                let installerURL = updateDirectory.appendingPathComponent(asset.name)
                try? FileManager.default.removeItem(at: installerURL)
                try FileManager.default.moveItem(at: temporaryURL, to: installerURL)
                try self.validateInstaller(at: installerURL, asset: asset)
                DispatchQueue.main.async {
                    self.setUpdateState(title: "正在启动安装程序…", enabled: false)
                    if NSWorkspace.shared.open(installerURL) {
                        self.stopServer()
                        NSApp.terminate(nil)
                    } else {
                        self.showError(title: "AllSessions 更新", message: "系统无法打开安装程序。")
                        self.resetUpdateState()
                    }
                }
            } catch {
                DispatchQueue.main.async {
                    self.showError(title: "AllSessions 更新", message: "下载或校验安装程序失败：\(error.localizedDescription)")
                    self.resetUpdateState()
                }
            }
        }.resume()
    }

    private func validateInstaller(at url: URL, asset: GitHubAsset) throws {
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        let size = (attributes[.size] as? NSNumber)?.int64Value ?? 0
        guard size > 4 else { throw UpdateError("下载的安装程序为空。") }
        if asset.size > 0 && size != asset.size {
            throw UpdateError("下载的安装程序大小与 Release 记录不一致。")
        }
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        guard try handle.read(upToCount: 4) == Data([0x78, 0x61, 0x72, 0x21]) else {
            throw UpdateError("下载的文件不是有效的 macOS 安装程序。")
        }
        if let digest = asset.digest, digest.lowercased().hasPrefix("sha256:") {
            try handle.seek(toOffset: 0)
            var hasher = SHA256()
            while let chunk = try handle.read(upToCount: 1024 * 1024), !chunk.isEmpty {
                hasher.update(data: chunk)
            }
            let actual = hasher.finalize().map { String(format: "%02x", $0) }.joined()
            let expected = String(digest.dropFirst("sha256:".count)).lowercased()
            guard actual == expected else { throw UpdateError("下载的安装程序 SHA-256 校验失败。") }
        }
    }

    private func readCurrentVersion() throws -> String {
        let data = try Data(contentsOf: appRoot.appendingPathComponent("package.json"))
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let version = json["version"] as? String else {
            throw UpdateError("安装目录中的 package.json 没有版本号。")
        }
        return normalizedVersion(version)
    }

    private func normalizedVersion(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.first == "v" || trimmed.first == "V" ? String(trimmed.dropFirst()) : trimmed
    }

    private func packageArchitecture() -> String {
        #if arch(arm64)
        return "arm64"
        #else
        return "x64"
        #endif
    }

    private func setUpdateState(title: String, enabled: Bool) {
        checkUpdatesItem.title = title
        checkUpdatesItem.isEnabled = enabled
    }

    private func resetUpdateState() {
        setUpdateState(title: "检查更新", enabled: true)
    }

    private func showInfo(title: String, message: String) {
        showAlert(title: title, message: message, style: .informational)
    }

    private func showError(title: String, message: String) {
        showAlert(title: title, message: message, style: .critical)
    }

    private func showAlert(title: String, message: String, style: NSAlert.Style) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.alertStyle = style
        alert.addButton(withTitle: "确定")
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }

    private func stopServer() {
        startupTimer?.invalidate()
        if serverProcess?.isRunning == true {
            serverProcess?.terminate()
        }
    }

    @objc private func exitAction() {
        stopServer()
        NSApp.terminate(nil)
    }
}

private struct UpdateError: LocalizedError {
    let message: String

    init(_ message: String) {
        self.message = message
    }

    var errorDescription: String? { message }
}
