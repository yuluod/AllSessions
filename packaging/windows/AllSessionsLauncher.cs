using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using System.Web.Script.Serialization;

namespace AllSessionsLauncher
{
    internal static class Program
    {
        private const string ViewerUrl = "http://127.0.0.1:3210";
        private const string LatestReleaseApi = "https://api.github.com/repos/yuluod/AllSessions/releases/latest";
        private const string WindowsAssetSuffix = "-windows-x64-setup.exe";
        private static Mutex instanceMutex;
        private static NotifyIcon trayIcon;
        private static ContextMenuStrip trayMenu;
        private static ToolStripMenuItem checkUpdatesItem;
        private static Process serverProcess;
        private static System.Windows.Forms.Timer startupTimer;
        private static int startupChecks;
        private static bool viewerOpened;

        [STAThread]
        private static void Main()
        {
            bool createdNew;
            instanceMutex = new Mutex(true, @"Local\AllSessions.Tray", out createdNew);
            if (!createdNew)
            {
                OpenViewer();
                return;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            CreateTrayIcon();

            if (IsViewerAvailable())
            {
                OpenViewer();
            }
            else
            {
                StartServer();
                WaitForServer();
            }

            Application.Run();
            DisposeResources();
        }

        private static void CreateTrayIcon()
        {
            trayMenu = new ContextMenuStrip();
            trayMenu.Items.Add("打开 AllSessions", null, delegate { OpenViewer(); });
            checkUpdatesItem = new ToolStripMenuItem("检查更新");
            checkUpdatesItem.Click += delegate { CheckForUpdates(); };
            trayMenu.Items.Add(checkUpdatesItem);
            trayMenu.Items.Add(new ToolStripSeparator());
            trayMenu.Items.Add("退出", null, delegate { ExitApplication(); });

            var iconPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "AllSessions.ico");
            trayIcon = new NotifyIcon();
            trayIcon.Text = "AllSessions";
            trayIcon.Icon = File.Exists(iconPath) ? new Icon(iconPath) : SystemIcons.Application;
            trayIcon.ContextMenuStrip = trayMenu;
            trayIcon.Visible = true;
            trayIcon.DoubleClick += delegate { OpenViewer(); };
        }

        private static void StartServer()
        {
            var baseDirectory = AppDomain.CurrentDomain.BaseDirectory;
            var startInfo = new ProcessStartInfo();
            startInfo.FileName = Path.Combine(baseDirectory, "runtime", "node.exe");
            startInfo.Arguments = Quote(Path.Combine(baseDirectory, "server", "index.js"));
            startInfo.WorkingDirectory = baseDirectory;
            startInfo.UseShellExecute = false;
            startInfo.CreateNoWindow = true;
            startInfo.WindowStyle = ProcessWindowStyle.Hidden;
            startInfo.EnvironmentVariables["ALLSESSIONS_OPEN_BROWSER"] = "0";

            try
            {
                serverProcess = Process.Start(startInfo);
            }
            catch (Exception error)
            {
                ShowStartupError(error.Message);
            }
        }

        private static void WaitForServer()
        {
            startupTimer = new System.Windows.Forms.Timer();
            startupTimer.Interval = 500;
            startupTimer.Tick += delegate
            {
                startupChecks += 1;
                if (IsViewerAvailable())
                {
                    startupTimer.Stop();
                    OpenViewer();
                    return;
                }
                if (serverProcess != null && serverProcess.HasExited)
                {
                    startupTimer.Stop();
                    ShowStartupError("后台服务已退出，请确认端口 3210 未被其他程序占用。");
                    return;
                }
                if (startupChecks >= 120)
                {
                    startupTimer.Stop();
                    ShowStartupError("后台服务启动超时。");
                }
            };
            startupTimer.Start();
        }

        private static bool IsViewerAvailable()
        {
            try
            {
                var request = (HttpWebRequest)WebRequest.Create(ViewerUrl + "/api/capabilities");
                request.Method = "GET";
                request.Accept = "application/json";
                request.Timeout = 1000;
                using (var response = (HttpWebResponse)request.GetResponse())
                {
                    return response.StatusCode == HttpStatusCode.OK;
                }
            }
            catch (WebException)
            {
                return false;
            }
        }

        private static void OpenViewer()
        {
            OpenUrl(ViewerUrl);
        }

        private static void OpenUrl(string url)
        {
            try
            {
                var startInfo = new ProcessStartInfo(url);
                startInfo.UseShellExecute = true;
                Process.Start(startInfo);
                viewerOpened = true;
            }
            catch (Exception error)
            {
                if (!viewerOpened)
                {
                    MessageBox.Show(error.Message, "AllSessions", MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
            }
        }

        private static void CheckForUpdates()
        {
            checkUpdatesItem.Enabled = false;
            checkUpdatesItem.Text = "正在检查更新…";
            ThreadPool.QueueUserWorkItem(delegate
            {
                try
                {
                    ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
                    string releaseJson;
                    using (var client = new WebClient())
                    {
                        client.Headers[HttpRequestHeader.UserAgent] = "AllSessions-Windows-Launcher";
                        client.Headers[HttpRequestHeader.Accept] = "application/vnd.github+json";
                        releaseJson = client.DownloadString(LatestReleaseApi);
                    }

                    var release = new JavaScriptSerializer().Deserialize<GitHubRelease>(releaseJson);
                    if (release == null || String.IsNullOrWhiteSpace(release.tag_name))
                    {
                        throw new InvalidDataException("GitHub 返回的数据中没有版本号。");
                    }

                    var currentVersion = ReadCurrentVersion();
                    var latestVersion = ParseVersion(release.tag_name);
                    var releaseVersion = NormalizeReleaseVersion(release.tag_name);
                    var expectedAssetName = "AllSessions-" + releaseVersion + WindowsAssetSuffix;
                    var asset = FindAsset(release.assets, expectedAssetName);
                    RunOnUi(delegate
                    {
                        if (latestVersion > currentVersion)
                        {
                            if (asset == null)
                            {
                                ShowUpdateError("新版本中没有找到 Windows x64 安装包：" + expectedAssetName);
                                ResetUpdateMenu();
                                return;
                            }
                            var result = MessageBox.Show(
                                "发现新版本 " + release.tag_name + "，是否立即下载并安装？",
                                "AllSessions 更新",
                                MessageBoxButtons.YesNo,
                                MessageBoxIcon.Information
                            );
                            if (result == DialogResult.Yes)
                            {
                                DownloadAndInstallUpdate(release.tag_name, asset);
                                return;
                            }
                        }
                        else
                        {
                            MessageBox.Show(
                                "当前版本 v" + currentVersion + " 已是最新版本。",
                                "AllSessions 更新",
                                MessageBoxButtons.OK,
                                MessageBoxIcon.Information
                            );
                        }
                        ResetUpdateMenu();
                    });
                }
                catch (Exception error)
                {
                    RunOnUi(delegate
                    {
                        ShowUpdateError("检查更新失败：" + error.Message);
                        ResetUpdateMenu();
                    });
                }
            });
        }

        private static GitHubAsset FindAsset(GitHubAsset[] assets, string expectedName)
        {
            if (assets == null) return null;
            foreach (var asset in assets)
            {
                if (asset != null && String.Equals(asset.name, expectedName, StringComparison.OrdinalIgnoreCase))
                {
                    return asset;
                }
            }
            return null;
        }

        private static void DownloadAndInstallUpdate(string latestTag, GitHubAsset asset)
        {
            checkUpdatesItem.Text = "正在下载 " + latestTag + "…";
            ThreadPool.QueueUserWorkItem(delegate
            {
                string partialPath = null;
                try
                {
                    var downloadUri = ValidateDownloadUrl(asset.browser_download_url);
                    var updateDirectory = Path.Combine(Path.GetTempPath(), "AllSessions", "updates");
                    Directory.CreateDirectory(updateDirectory);
                    var installerPath = Path.Combine(updateDirectory, asset.name);
                    partialPath = installerPath + ".download";
                    DeleteIfExists(partialPath);

                    using (var client = new WebClient())
                    {
                        client.Headers[HttpRequestHeader.UserAgent] = "AllSessions-Windows-Launcher";
                        client.DownloadFile(downloadUri, partialPath);
                    }

                    ValidateInstaller(partialPath, asset);
                    DeleteIfExists(installerPath);
                    File.Move(partialPath, installerPath);
                    partialPath = null;

                    RunOnUi(delegate
                    {
                        try
                        {
                            StartInstaller(installerPath);
                        }
                        catch (Exception error)
                        {
                            ShowUpdateError("启动安装程序失败：" + error.Message);
                            ResetUpdateMenu();
                        }
                    });
                }
                catch (Exception error)
                {
                    DeleteIfExists(partialPath);
                    RunOnUi(delegate
                    {
                        ShowUpdateError("下载或启动安装程序失败：" + error.Message);
                        ResetUpdateMenu();
                    });
                }
            });
        }

        private static Uri ValidateDownloadUrl(string value)
        {
            Uri uri;
            if (!Uri.TryCreate(value, UriKind.Absolute, out uri)
                || uri.Scheme != Uri.UriSchemeHttps
                || !String.Equals(uri.Host, "github.com", StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidDataException("更新包下载地址无效。");
            }
            return uri;
        }

        private static void ValidateInstaller(string installerPath, GitHubAsset asset)
        {
            var fileInfo = new FileInfo(installerPath);
            if (!fileInfo.Exists || fileInfo.Length < 2)
            {
                throw new InvalidDataException("下载的安装程序为空。");
            }
            if (asset.size > 0 && fileInfo.Length != asset.size)
            {
                throw new InvalidDataException("下载的安装程序大小与 Release 记录不一致。");
            }
            using (var stream = File.OpenRead(installerPath))
            {
                if (stream.ReadByte() != 'M' || stream.ReadByte() != 'Z')
                {
                    throw new InvalidDataException("下载的文件不是有效的 Windows 安装程序。");
                }
            }
            ValidateSha256(installerPath, asset.digest);
        }

        private static void ValidateSha256(string installerPath, string digest)
        {
            if (String.IsNullOrWhiteSpace(digest) || !digest.StartsWith("sha256:", StringComparison.OrdinalIgnoreCase))
            {
                return;
            }
            var expected = digest.Substring("sha256:".Length).Trim();
            using (var algorithm = SHA256.Create())
            using (var stream = File.OpenRead(installerPath))
            {
                var actual = BitConverter.ToString(algorithm.ComputeHash(stream)).Replace("-", "");
                if (!String.Equals(actual, expected, StringComparison.OrdinalIgnoreCase))
                {
                    throw new InvalidDataException("下载的安装程序 SHA-256 校验失败。");
                }
            }
        }

        private static void StartInstaller(string installerPath)
        {
            checkUpdatesItem.Text = "正在启动安装程序…";
            ReleaseInstanceMutex();
            try
            {
                var startInfo = new ProcessStartInfo(installerPath);
                startInfo.UseShellExecute = true;
                startInfo.WorkingDirectory = Path.GetDirectoryName(installerPath);
                if (Process.Start(startInfo) == null)
                {
                    throw new InvalidOperationException("系统没有返回安装程序进程。");
                }
            }
            catch
            {
                bool createdNew;
                instanceMutex = new Mutex(true, @"Local\AllSessions.Tray", out createdNew);
                throw;
            }
            StopServer();
            Application.Exit();
        }

        private static void ShowUpdateError(string message)
        {
            MessageBox.Show(message, "AllSessions 更新", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }

        private static void ResetUpdateMenu()
        {
            checkUpdatesItem.Enabled = true;
            checkUpdatesItem.Text = "检查更新";
        }

        private static void DeleteIfExists(string filePath)
        {
            if (!String.IsNullOrEmpty(filePath) && File.Exists(filePath)) File.Delete(filePath);
        }

        private static Version ReadCurrentVersion()
        {
            var packagePath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "package.json");
            var packageJson = File.ReadAllText(packagePath);
            var versionMatch = Regex.Match(packageJson, "\\\"version\\\"\\s*:\\s*\\\"([^\\\"]+)\\\"");
            if (!versionMatch.Success)
            {
                throw new InvalidDataException("安装目录中的 package.json 没有版本号。");
            }
            return ParseVersion(versionMatch.Groups[1].Value);
        }

        private static Version ParseVersion(string value)
        {
            var normalized = NormalizeReleaseVersion(value);
            var suffixIndex = normalized.IndexOfAny(new[] { '-', '+' });
            if (suffixIndex >= 0) normalized = normalized.Substring(0, suffixIndex);
            Version version;
            if (!Version.TryParse(normalized, out version))
            {
                throw new InvalidDataException("无法识别版本号：" + value);
            }
            return version;
        }

        private static string NormalizeReleaseVersion(string value)
        {
            return value.Trim().TrimStart('v', 'V');
        }

        private static void RunOnUi(MethodInvoker action)
        {
            if (trayMenu == null || trayMenu.IsDisposed) return;
            if (trayMenu.InvokeRequired)
            {
                trayMenu.BeginInvoke(action);
            }
            else
            {
                action();
            }
        }

        private static void ShowStartupError(string message)
        {
            trayIcon.ShowBalloonTip(5000, "AllSessions 启动失败", message, ToolTipIcon.Error);
        }

        private static void ExitApplication()
        {
            StopServer();
            Application.Exit();
        }

        private static void StopServer()
        {
            if (serverProcess != null && !serverProcess.HasExited)
            {
                try
                {
                    serverProcess.Kill();
                    serverProcess.WaitForExit(3000);
                }
                catch (Exception error)
                {
                    trayIcon.ShowBalloonTip(5000, "AllSessions 退出失败", error.Message, ToolTipIcon.Error);
                }
            }
        }

        private static void ReleaseInstanceMutex()
        {
            if (instanceMutex == null) return;
            instanceMutex.ReleaseMutex();
            instanceMutex.Dispose();
            instanceMutex = null;
        }

        private static void DisposeResources()
        {
            if (startupTimer != null) startupTimer.Dispose();
            if (trayIcon != null)
            {
                trayIcon.Visible = false;
                trayIcon.Dispose();
            }
            if (trayMenu != null) trayMenu.Dispose();
            if (serverProcess != null) serverProcess.Dispose();
            if (instanceMutex != null) instanceMutex.Dispose();
        }

        private static string Quote(string value)
        {
            return "\"" + value.Replace("\"", "\\\"") + "\"";
        }

        public sealed class GitHubRelease
        {
            public string tag_name { get; set; }
            public GitHubAsset[] assets { get; set; }
        }

        public sealed class GitHubAsset
        {
            public string name { get; set; }
            public string browser_download_url { get; set; }
            public string digest { get; set; }
            public long size { get; set; }
        }
    }
}
