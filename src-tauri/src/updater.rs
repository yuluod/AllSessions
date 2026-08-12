use std::{
    fs::{self, File},
    io::{self, Read},
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicBool, Ordering},
    thread,
};

use semver::Version;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

const LATEST_RELEASE_API: &str = "https://api.github.com/repos/yuluod/AllSessions/releases/latest";
static UPDATE_RUNNING: AtomicBool = AtomicBool::new(false);

#[derive(Deserialize)]
struct GitHubRelease {
    tag_name: String,
    assets: Vec<GitHubAsset>,
}

#[derive(Deserialize)]
struct GitHubAsset {
    name: String,
    browser_download_url: String,
    digest: Option<String>,
    size: u64,
}

struct UpdateGuard;

impl Drop for UpdateGuard {
    fn drop(&mut self) {
        UPDATE_RUNNING.store(false, Ordering::Release);
    }
}

pub fn check_for_updates(app: tauri::AppHandle) {
    if UPDATE_RUNNING.swap(true, Ordering::AcqRel) {
        return;
    }
    thread::spawn(move || {
        let _guard = UpdateGuard;
        if let Err(error) = run_update(&app) {
            app.dialog()
                .message(format!("检查或安装更新失败：{error}"))
                .title("AllSessions 更新")
                .kind(MessageDialogKind::Error)
                .blocking_show();
        }
    });
}

fn run_update(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let client = reqwest::blocking::Client::builder()
        .user_agent("AllSessions-Tauri")
        .build()?;
    let release: GitHubRelease = client
        .get(LATEST_RELEASE_API)
        .header("Accept", "application/vnd.github+json")
        .send()?
        .error_for_status()?
        .json()?;
    let current = app.package_info().version.clone();
    let latest = Version::parse(release.tag_name.trim_start_matches(['v', 'V']))?;
    if latest <= current {
        app.dialog()
            .message(format!("当前版本 v{current} 已是最新版本。"))
            .title("AllSessions 更新")
            .kind(MessageDialogKind::Info)
            .blocking_show();
        return Ok(());
    }

    let expected_name = asset_name(&latest)?;
    let asset = release
        .assets
        .iter()
        .find(|asset| asset.name == expected_name)
        .ok_or_else(|| format!("新版本中没有找到当前平台安装包：{expected_name}"))?;
    let confirmed = app
        .dialog()
        .message(format!(
            "发现新版本 {}，是否立即下载并安装？",
            release.tag_name
        ))
        .title("AllSessions 更新")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::YesNo)
        .blocking_show();
    if !confirmed {
        return Ok(());
    }

    let installer = download_installer(&client, asset)?;
    launch_installer(&installer)?;
    app.exit(0);
    Ok(())
}

fn asset_name(version: &Version) -> Result<String, &'static str> {
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        _ => return Err("当前处理器架构暂不支持自动更新"),
    };
    let name = match std::env::consts::OS {
        "windows" => format!("AllSessions-{version}-windows-{arch}-setup.exe"),
        "macos" => format!("AllSessions-{version}-mac-{arch}.dmg"),
        "linux" => format!("AllSessions-{version}-linux-{arch}.deb"),
        _ => return Err("当前操作系统暂不支持自动更新"),
    };
    Ok(name)
}

fn download_installer(
    client: &reqwest::blocking::Client,
    asset: &GitHubAsset,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let url = reqwest::Url::parse(&asset.browser_download_url)?;
    if url.scheme() != "https" || url.host_str() != Some("github.com") {
        return Err("更新包下载地址无效".into());
    }
    let update_dir = std::env::temp_dir().join("AllSessions").join("updates");
    fs::create_dir_all(&update_dir)?;
    let destination = update_dir.join(&asset.name);
    let partial = destination.with_extension("download");
    let result = (|| {
        let mut response = client.get(url).send()?.error_for_status()?;
        let mut file = File::create(&partial)?;
        io::copy(&mut response, &mut file)?;
        drop(file);
        validate_installer(&partial, asset)?;
        if destination.exists() {
            fs::remove_file(&destination)?;
        }
        fs::rename(&partial, &destination)?;
        Ok(destination)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&partial);
    }
    result
}

fn validate_installer(path: &Path, asset: &GitHubAsset) -> Result<(), Box<dyn std::error::Error>> {
    let metadata = fs::metadata(path)?;
    if metadata.len() == 0 || (asset.size > 0 && metadata.len() != asset.size) {
        return Err("下载的安装包大小与 Release 记录不一致".into());
    }
    validate_platform_header(path)?;
    if let Some(expected) = asset
        .digest
        .as_deref()
        .and_then(|value| value.strip_prefix("sha256:"))
    {
        let mut file = File::open(path)?;
        let mut hasher = Sha256::new();
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let count = file.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            hasher.update(&buffer[..count]);
        }
        if format!("{:x}", hasher.finalize()) != expected.to_ascii_lowercase() {
            return Err("下载的安装包 SHA-256 校验失败".into());
        }
    }
    Ok(())
}

fn validate_platform_header(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let mut file = File::open(path)?;
    #[cfg(target_os = "windows")]
    {
        let mut header = [0_u8; 2];
        file.read_exact(&mut header)?;
        if &header != b"MZ" {
            return Err("下载的文件不是有效的 Windows 安装程序".into());
        }
    }
    #[cfg(target_os = "linux")]
    {
        let mut header = [0_u8; 8];
        file.read_exact(&mut header)?;
        if &header != b"!<arch>\n" {
            return Err("下载的文件不是有效的 Debian 安装包".into());
        }
    }
    #[cfg(target_os = "macos")]
    {
        use std::io::{Seek, SeekFrom};
        file.seek(SeekFrom::End(-512))?;
        let mut signature = [0_u8; 4];
        file.read_exact(&mut signature)?;
        if &signature != b"koly" {
            return Err("下载的文件不是有效的 macOS 磁盘映像".into());
        }
    }
    Ok(())
}

fn launch_installer(path: &Path) -> io::Result<()> {
    #[cfg(target_os = "windows")]
    let mut command = Command::new(path);
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg(path);
        command
    };
    #[cfg(target_os = "linux")]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(path);
        command
    };
    command.spawn().map(|_| ())
}
