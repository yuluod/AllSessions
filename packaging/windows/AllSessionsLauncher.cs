using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Threading;
using System.Windows.Forms;

namespace AllSessionsLauncher
{
    internal static class Program
    {
        private const string ViewerUrl = "http://127.0.0.1:3210";
        private static Mutex instanceMutex;
        private static NotifyIcon trayIcon;
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
            var menu = new ContextMenuStrip();
            menu.Items.Add("打开 AllSessions", null, delegate { OpenViewer(); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("退出", null, delegate { ExitApplication(); });

            var iconPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "AllSessions.ico");
            trayIcon = new NotifyIcon();
            trayIcon.Text = "AllSessions";
            trayIcon.Icon = File.Exists(iconPath) ? new Icon(iconPath) : SystemIcons.Application;
            trayIcon.ContextMenuStrip = menu;
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
            try
            {
                var startInfo = new ProcessStartInfo(ViewerUrl);
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

        private static void ShowStartupError(string message)
        {
            trayIcon.ShowBalloonTip(5000, "AllSessions 启动失败", message, ToolTipIcon.Error);
        }

        private static void ExitApplication()
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
            Application.Exit();
        }

        private static void DisposeResources()
        {
            if (startupTimer != null) startupTimer.Dispose();
            if (trayIcon != null)
            {
                trayIcon.Visible = false;
                trayIcon.Dispose();
            }
            if (serverProcess != null) serverProcess.Dispose();
            if (instanceMutex != null) instanceMutex.Dispose();
        }

        private static string Quote(string value)
        {
            return "\"" + value.Replace("\"", "\\\"") + "\"";
        }
    }
}
