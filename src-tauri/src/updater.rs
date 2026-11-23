use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use reqwest::{StatusCode, header::ACCEPT};
use serde_json::{Value, json};
use tauri::{Emitter, Runtime};
use tauri_plugin_updater::{Update, UpdaterExt};
use url::Url;

static UPDATE_OPERATION: Mutex<UpdateOperation> = Mutex::new(UpdateOperation::Idle);
static DOWNLOADED_UPDATE: Mutex<Option<(Update, Vec<u8>)>> = Mutex::new(None);
const CHECK_TIMEOUT: Duration = Duration::from_secs(15);
const DOWNLOAD_IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const MANIFEST_CONFIRM_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, Debug, PartialEq)]
enum UpdateCheckMode {
    Interactive,
    Silent,
}

#[derive(Clone, Copy)]
enum UpdateOperation {
    Idle,
    Checking(UpdateCheckMode),
    DownloadingOrInstalling,
}

impl UpdateOperation {
    fn request_check(&mut self, mode: UpdateCheckMode, emit: impl FnOnce(Value)) -> bool {
        let start = matches!(self, Self::Idle);
        match (*self, mode) {
            (Self::Idle, _) | (Self::Checking(_), UpdateCheckMode::Interactive) => {
                *self = Self::Checking(mode);
            }
            _ => {}
        }
        if mode == UpdateCheckMode::Interactive {
            let phase = if matches!(self, Self::Checking(_)) {
                "checking"
            } else {
                "show"
            };
            emit(json!({ "phase": phase }));
        }
        start
    }
}

fn update_operation() -> MutexGuard<'static, UpdateOperation> {
    UPDATE_OPERATION
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

struct UpdateGuard {
    finished: bool,
}

impl UpdateGuard {
    fn finish(mut self, emit_result: impl FnOnce(UpdateOperation)) {
        let mut operation = update_operation();
        let completed = std::mem::replace(&mut *operation, UpdateOperation::Idle);
        self.finished = true;
        // 保证检查进度与最终结果按顺序发送，同时允许收到结果后立即操作。
        emit_result(completed);
    }
}

impl Drop for UpdateGuard {
    fn drop(&mut self) {
        if !self.finished {
            *update_operation() = UpdateOperation::Idle;
        }
    }
}

pub fn check_for_updates(app: tauri::AppHandle) {
    spawn_update_check(app, UpdateCheckMode::Interactive);
}

pub fn check_for_updates_silently(app: tauri::AppHandle) {
    spawn_update_check(app, UpdateCheckMode::Silent);
}

fn begin_update() -> Result<UpdateGuard, String> {
    let mut operation = update_operation();
    if !matches!(*operation, UpdateOperation::Idle) {
        return Err("另一项更新操作仍在进行，请稍后重试。".into());
    }
    *operation = UpdateOperation::DownloadingOrInstalling;
    Ok(UpdateGuard { finished: false })
}

pub fn download_update(app: tauri::AppHandle) -> Result<(), String> {
    let guard = begin_update()?;
    if DOWNLOADED_UPDATE
        .lock()
        .map_err(|error| error.to_string())?
        .is_some()
    {
        return Err("更新已下载，请先安装。".into());
    }
    tauri::async_runtime::spawn(async move {
        let result = run_download(&app).await;
        guard.finish(|_| match result {
            Ok(()) => emit_status(&app, json!({ "phase": "ready" })),
            Err(error) => emit_error(&app, &error),
        });
    });
    Ok(())
}

pub fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    let guard = begin_update()?;
    let package = DOWNLOADED_UPDATE
        .lock()
        .map_err(|error| error.to_string())?
        .take()
        .ok_or("请先下载更新。")?;
    tauri::async_runtime::spawn_blocking(move || {
        emit_status(&app, json!({ "phase": "installing" }));
        if let Err(status) = install_downloaded(package, &DOWNLOADED_UPDATE, |(update, bytes)| {
            update.install(bytes)
        }) {
            guard.finish(|_| emit_status(&app, status));
        } else {
            app.request_restart();
        }
    });
    Ok(())
}

fn install_downloaded<T>(
    package: T,
    cache: &Mutex<Option<T>>,
    install: impl FnOnce(&T) -> tauri_plugin_updater::Result<()>,
) -> Result<(), Value> {
    use std::io::ErrorKind;
    use tauri_plugin_updater::Error;

    let retryable_io = |io: &std::io::Error| {
        matches!(
            io.kind(),
            ErrorKind::PermissionDenied
                | ErrorKind::StorageFull
                | ErrorKind::QuotaExceeded
                | ErrorKind::ReadOnlyFilesystem
                | ErrorKind::ResourceBusy
                | ErrorKind::ExecutableFileBusy
                | ErrorKind::Interrupted
                | ErrorKind::WouldBlock
        )
    };
    install(&package).map_err(|error| {
        let retryable = match &error {
            Error::Io(io) => retryable_io(io),
            #[cfg(windows)]
            Error::Extract(zip) => std::error::Error::source(zip)
                .and_then(|cause| cause.downcast_ref::<std::io::Error>())
                .is_some_and(retryable_io),
            Error::TempDirNotFound
            | Error::TempDirNotOnSameMountPoint
            | Error::AuthenticationFailed => true,
            _ => false,
        };
        let mut status = error_status(&error.to_string());
        if retryable {
            *cache.lock().unwrap_or_else(PoisonError::into_inner) = Some(package);
            status["phase"] = json!("install_error");
        }
        status
    })
}

fn spawn_update_check(app: tauri::AppHandle, mode: UpdateCheckMode) {
    if !update_operation().request_check(mode, |payload| emit_status(&app, payload)) {
        return;
    }
    let guard = UpdateGuard { finished: false };
    tauri::async_runtime::spawn(async move {
        let result = refresh_downloaded(
            check(&app, CHECK_TIMEOUT, DOWNLOAD_IDLE_TIMEOUT),
            &DOWNLOADED_UPDATE,
            |(cached, _), release| {
                cached.version == release.version && cached.signature == release.signature
            },
            async {
                match manifest_endpoint(&app) {
                    Some(endpoint) => manifest_is_gone(endpoint).await,
                    None => false,
                }
            },
        )
        .await;
        guard.finish(|operation| {
            if let Some(payload) =
                check_result_status(operation, result, || app.package_info().version.to_string())
            {
                emit_status(&app, payload);
            }
        });
    });
}

fn check_result_status(
    operation: UpdateOperation,
    result: Result<Option<(Update, bool)>, String>,
    current_version: impl FnOnce() -> String,
) -> Option<Value> {
    let interactive = matches!(
        operation,
        UpdateOperation::Checking(UpdateCheckMode::Interactive)
    );
    match result {
        Ok(Some((update, false))) => Some(status_with_notes("available", &update)),
        Ok(Some((update, true))) if interactive => Some(status_with_notes("ready", &update)),
        Ok(None) if interactive => Some(json!({
            "phase": "latest",
            "version": current_version(),
        })),
        Err(error) if interactive => Some(error_status(&error)),
        _ => None,
    }
}

fn emit_error(app: &tauri::AppHandle, error: &str) {
    emit_status(app, error_status(error));
}

fn error_status(error: &str) -> Value {
    json!({ "phase": "error", "message": update_error_message(error) })
}

fn emit_status(app: &tauri::AppHandle, payload: Value) {
    if let Err(error) = app.emit("update-status", payload) {
        eprintln!("无法发送更新状态：{error}");
    }
}

fn update_error_message(error: &str) -> String {
    if error.contains("None of the fallback platforms") {
        return "当前发布没有适用于此设备架构的更新包。请从 GitHub Releases 手动下载安装，或等待包含此平台更新包的新版本。".to_string();
    }
    format!("检查或安装更新失败：{error}")
}

const MAX_NOTES_CHARS: usize = 16_000;

fn bounded_notes(body: Option<&str>) -> (&str, bool) {
    let notes = body.unwrap_or_default().trim();
    let Some((end, _)) = notes.char_indices().nth(MAX_NOTES_CHARS) else {
        return (notes, false);
    };
    let mut truncated = &notes[..end];
    if let Some(line_break) = truncated.rfind('\n')
        && truncated[..line_break].chars().count() >= MAX_NOTES_CHARS / 2
    {
        truncated = &truncated[..line_break];
    }
    (truncated.trim_end(), true)
}

fn status_with_notes(phase: &str, update: &Update) -> Value {
    let (notes, truncated) = bounded_notes(update.body.as_deref());
    json!({
        "phase": phase,
        "version": update.version,
        "notes": notes,
        "notes_truncated": truncated,
    })
}

async fn check<R: Runtime>(
    app: &tauri::AppHandle<R>,
    timeout: Duration,
    read_timeout: Duration,
) -> tauri_plugin_updater::Result<Option<Update>> {
    app.updater_builder()
        .timeout(timeout)
        .configure_client(move |client| client.read_timeout(read_timeout).connect_timeout(timeout))
        .build()?
        .check()
        .await
}

fn manifest_endpoint<R: Runtime>(app: &tauri::AppHandle<R>) -> Option<Url> {
    let endpoints = app.config().plugins.0.get("updater")?["endpoints"].as_array()?;
    let [endpoint] = endpoints.as_slice() else {
        return None;
    };
    // 当前清单地址是固定 URL。模板和备用地址仍由更新插件解析。
    let endpoint = endpoint.as_str()?;
    if endpoint.contains('{') {
        return None;
    }
    Url::parse(endpoint).ok()
}

async fn manifest_is_gone(endpoint: Url) -> bool {
    let result = async {
        reqwest::Client::builder()
            .timeout(MANIFEST_CONFIRM_TIMEOUT)
            .build()?
            .get(endpoint)
            .header(ACCEPT, "application/json")
            .send()
            .await
    }
    .await;
    result
        .is_ok_and(|response| matches!(response.status(), StatusCode::NOT_FOUND | StatusCode::GONE))
}

async fn refresh_downloaded<Cached, Release>(
    check: impl Future<Output = tauri_plugin_updater::Result<Option<Release>>>,
    downloaded: &Mutex<Option<Cached>>,
    same_package: impl FnOnce(&Cached, &Release) -> bool,
    confirm_manifest_gone: impl Future<Output = bool>,
) -> Result<Option<(Release, bool)>, String> {
    use tauri_plugin_updater::Error::{ReleaseNotFound, TargetNotFound, TargetsNotFound};

    let result = check.await;
    match &result {
        Ok(_) | Err(TargetNotFound(_) | TargetsNotFound(_)) => {}
        Err(ReleaseNotFound) => {
            let has_download = downloaded
                .lock()
                .map_err(|error| error.to_string())?
                .is_some();
            // 插件把清单缺失、限流和服务异常归为同一个错误。
            if !has_download || !confirm_manifest_gone.await {
                return Err(ReleaseNotFound.to_string());
            }
        }
        Err(error) => return Err(error.to_string()),
    }

    let mut downloaded = downloaded.lock().map_err(|error| error.to_string())?;
    let ready = downloaded
        .as_ref()
        .zip(result.as_ref().ok().and_then(Option::as_ref))
        .is_some_and(|(cached, release)| same_package(cached, release));
    if !ready {
        *downloaded = None;
    }
    result
        .map(|release| release.map(|release| (release, ready)))
        .map_err(|error| error.to_string())
}

async fn run_download(app: &tauri::AppHandle) -> Result<(), String> {
    let Some(update) = check(app, CHECK_TIMEOUT, DOWNLOAD_IDLE_TIMEOUT)
        .await
        .map_err(|error| error.to_string())?
    else {
        return Err("更新已不可用，请重新检查。".into());
    };

    emit_status(app, status_with_notes("downloading", &update));

    let mut downloaded = 0_u64;
    let progress_app = app.clone();
    let bytes = update
        .download(
            move |chunk_length, total| {
                downloaded = downloaded.saturating_add(chunk_length as u64);
                emit_status(
                    &progress_app,
                    json!({
                        "phase": "downloading",
                        "downloaded": downloaded,
                        "total": total,
                    }),
                );
            },
            || {},
        )
        .await
        .map_err(|error| error.to_string())?;
    *DOWNLOADED_UPDATE
        .lock()
        .map_err(|error| error.to_string())? = Some((update, bytes));
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::future::ready;
    use std::sync::Mutex;

    use tauri::async_runtime::block_on;
    use tauri_plugin_updater::Error;

    use super::{
        MAX_NOTES_CHARS, UpdateCheckMode, UpdateOperation, bounded_notes, check,
        check_result_status, manifest_endpoint, manifest_is_gone, refresh_downloaded,
        update_error_message,
    };

    #[test]
    fn 安装失败时仅保留可重试的包() {
        let cache = Mutex::new(None);
        let status = super::install_downloaded(vec![1, 2], &cache, |_| {
            Err(std::io::Error::from(std::io::ErrorKind::StorageFull).into())
        })
        .unwrap_err();
        assert_eq!(status["phase"], "install_error");
        let package = cache.lock().unwrap().take().unwrap();
        super::install_downloaded(package, &cache, |bytes| {
            assert_eq!(bytes, &[1, 2]);
            Ok(())
        })
        .unwrap();
        for error in [Error::MissingSignedVersion, Error::InvalidUpdaterFormat] {
            let status = super::install_downloaded(vec![1, 2], &cache, |_| Err(error)).unwrap_err();
            assert_eq!(status["phase"], "error");
            assert!(cache.lock().unwrap().is_none());
        }
    }

    #[test]
    fn 缺少当前平台时提供可执行的提示() {
        let message = update_error_message(
            "None of the fallback platforms [\"darwin-aarch64-app\", \"darwin-aarch64\"] were found",
        );

        assert!(message.contains("没有适用于此设备架构的更新包"));
        assert!(!message.contains("fallback platforms"));
    }

    #[test]
    fn 未知更新错误保留原始详情() {
        assert_eq!(
            update_error_message("network unavailable"),
            "检查或安装更新失败：network unavailable"
        );
    }

    #[test]
    fn 更新日志保留原始_markdown_语义() {
        let markdown = "### 新增\n\n- **支持**更新日志。\n\n  `代码`";
        assert_eq!(bounded_notes(Some(markdown)), (markdown, false));
    }

    #[test]
    fn 缺少更新日志时返回空文本() {
        assert_eq!(bounded_notes(None), ("", false));
        assert_eq!(bounded_notes(Some("  \n")), ("", false));
    }

    #[test]
    fn 超长更新日志截断并引导查看完整内容() {
        let long_notes = (0..1000)
            .map(|index| format!("- 第 {index} 条更新说明，用于验证截断行为。"))
            .collect::<Vec<_>>()
            .join("\n");
        let (notes, truncated) = bounded_notes(Some(&long_notes));

        assert!(truncated);
        assert!(notes.chars().count() <= MAX_NOTES_CHARS);
        assert!(long_notes[notes.len()..].starts_with('\n'));
    }

    #[test]
    fn 中文更新日志按字符位置判断截断换行() {
        let notes = format!("{}\n{}", "甲".repeat(100), "乙".repeat(MAX_NOTES_CHARS));
        let (result, truncated) = bounded_notes(Some(&notes));

        assert!(truncated);
        assert_eq!(result.chars().count(), MAX_NOTES_CHARS);
        assert!(result.contains('乙'));
    }

    #[test]
    fn 下载旧版后手动检查发现新版并清除旧包() {
        let downloaded = Mutex::new(Some(("1.1.0", vec![1])));
        let result = block_on(refresh_downloaded(
            ready(Ok(Some("1.2.0"))),
            &downloaded,
            |(version, _), release| version == release,
            ready(false),
        ));

        assert_eq!(result, Ok(Some(("1.2.0", false))));
        assert_eq!(downloaded.into_inner().unwrap(), None);
    }

    #[test]
    fn 同一发布复用安装包且撤回后清除缓存() {
        let downloaded = Mutex::new(Some(("1.1.0", vec![1])));
        let same_version = |(version, _): &(&str, Vec<u8>), release: &&str| version == release;

        let unchanged = block_on(refresh_downloaded(
            ready(Ok(Some("1.1.0"))),
            &downloaded,
            same_version,
            ready(false),
        ));
        assert_eq!(unchanged, Ok(Some(("1.1.0", true))));
        assert_eq!(*downloaded.lock().unwrap(), Some(("1.1.0", vec![1])));

        let withdrawn = block_on(refresh_downloaded(
            ready(Ok(None)),
            &downloaded,
            same_version,
            ready(false),
        ));
        assert_eq!(withdrawn, Ok(None));
        assert_eq!(downloaded.into_inner().unwrap(), None);
    }

    #[test]
    fn 网络失败保留缓存但平台包被撤回则清除() {
        let downloaded = Mutex::new(Some("1.1.0"));
        let transient = block_on(refresh_downloaded(
            ready(Err::<Option<&str>, _>(Error::Network("网络错误".into()))),
            &downloaded,
            PartialEq::eq,
            ready(false),
        ));
        assert!(transient.is_err());
        assert_eq!(*downloaded.lock().unwrap(), Some("1.1.0"));

        for error in [
            Error::TargetNotFound("darwin-aarch64".into()),
            Error::TargetsNotFound(vec!["darwin-aarch64".into()]),
        ] {
            let downloaded = Mutex::new(Some("1.1.0"));
            let result = block_on(refresh_downloaded(
                ready(Err::<Option<&str>, _>(error)),
                &downloaded,
                PartialEq::eq,
                ready(false),
            ));
            assert!(result.is_err());
            assert_eq!(downloaded.into_inner().unwrap(), None);
        }
    }

    #[test]
    fn 以实际_http_状态区分暂时故障与清单撤回() {
        use std::io::{BufRead, BufReader, Write};
        use std::net::TcpListener;
        use std::time::Duration;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let app = updater_app(format!("http://{}", listener.local_addr().unwrap()));
        let server = std::thread::spawn(move || {
            let manifest =
                r#"{"version":"1.1.0","url":"https://example.invalid/update","signature":"test"}"#;
            for (status, body) in [
                ("429 Too Many Requests", ""),
                ("429 Too Many Requests", ""),
                ("503 Service Unavailable", ""),
                ("503 Service Unavailable", ""),
                ("200 OK", manifest),
                ("404 Not Found", ""),
                ("404 Not Found", ""),
            ] {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                for line in BufReader::new(&stream).lines() {
                    if line.unwrap().is_empty() {
                        break;
                    }
                }
                write!(
                    stream,
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .unwrap();
            }
        });
        let cached = Mutex::new(Some(("1.1.0", "test", vec![1u8])));
        let run = || {
            block_on(refresh_downloaded(
                check(app.handle(), Duration::from_secs(5), Duration::from_secs(5)),
                &cached,
                |(version, signature, _), update| {
                    update.version == *version && update.signature == *signature
                },
                manifest_is_gone(manifest_endpoint(app.handle()).unwrap()),
            ))
        };
        for _ in 0..2 {
            assert!(run().is_err());
            assert!(cached.lock().unwrap().is_some());
        }
        let (release, ready) = run().unwrap().unwrap();
        assert!(ready);
        assert_eq!(release.version, "1.1.0");
        assert_eq!(cached.lock().unwrap().as_ref().unwrap().2, vec![1]);
        assert!(run().is_err());
        assert!(cached.into_inner().unwrap().is_none());
        server.join().unwrap();
    }

    fn updater_app(url: String) -> tauri::App<tauri::test::MockRuntime> {
        use tauri::test::{mock_builder, mock_context, noop_assets};

        let mut context = mock_context(noop_assets());
        context.config_mut().plugins.0.insert(
            "updater".into(),
            serde_json::json!({
                "pubkey": "", "endpoints": [url], "dangerousInsecureTransportProtocol": true
            }),
        );
        mock_builder()
            .plugin(tauri_plugin_updater::Builder::new().build())
            .build(context)
            .unwrap()
    }

    #[test]
    fn 发布端不响应时检查会超时() {
        use std::net::TcpListener;
        use std::time::Duration;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let app = updater_app(format!("http://{}", listener.local_addr().unwrap()));
        let result = block_on(check(
            app.handle(),
            Duration::from_millis(100),
            Duration::from_secs(5),
        ));
        assert!(matches!(result, Err(Error::Reqwest(error)) if error.is_timeout()));
    }

    #[test]
    fn 安装包首块后停滞会超时并可重新检查() {
        use std::io::{BufRead, BufReader, Write};
        use std::net::TcpListener;
        use std::sync::mpsc;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let app = updater_app(url.clone());
        let (release, wait) = mpsc::channel();
        let server = std::thread::spawn(move || {
            let manifest = serde_json::json!({
                "version": "1.1.0", "url": format!("{url}/package"), "signature": "test"
            })
            .to_string();
            for request in 0..3 {
                let (mut stream, _) = listener.accept().unwrap();
                for line in BufReader::new(&stream).lines() {
                    if line.unwrap().is_empty() {
                        break;
                    }
                }
                if request == 1 {
                    stream
                        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nx")
                        .unwrap();
                    wait.recv_timeout(std::time::Duration::from_secs(5))
                        .unwrap();
                } else {
                    write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{manifest}", manifest.len()).unwrap();
                }
            }
        });
        let check_release = || {
            check(
                app.handle(),
                std::time::Duration::from_secs(5),
                std::time::Duration::from_millis(300),
            )
        };
        let update = block_on(check_release()).unwrap().unwrap();
        let mut received = 0;
        let result = block_on(update.download(|bytes, _| received += bytes, || {}));
        release.send(()).unwrap();
        assert_eq!(received, 1);
        assert!(matches!(result, Err(Error::Reqwest(error)) if error.is_timeout()));
        assert!(block_on(check_release()).unwrap().is_some());
        server.join().unwrap();
    }

    #[test]
    fn 手动检查接管在途静默检查并显示结果() {
        for (result, phase) in [(Ok(None), "latest"), (Err("网络错误".into()), "error")] {
            let mut operation = UpdateOperation::Idle;
            assert!(operation.request_check(UpdateCheckMode::Silent, |_| {
                panic!("静默检查不发送进度");
            }));
            assert!(check_result_status(operation, result.clone(), || "1.0.0".into()).is_none());

            let mut statuses = Vec::new();
            assert!(
                !operation.request_check(UpdateCheckMode::Interactive, |status| {
                    statuses.push(status);
                })
            );
            statuses.extend(check_result_status(operation, result, || "1.0.0".into()));

            assert_eq!(statuses.len(), 2);
            assert_eq!(statuses[0]["phase"], "checking");
            assert_eq!(statuses[1]["phase"], phase);
        }
    }
}
