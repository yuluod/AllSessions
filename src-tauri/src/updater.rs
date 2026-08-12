use std::sync::atomic::{AtomicBool, Ordering};

use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

static UPDATE_RUNNING: AtomicBool = AtomicBool::new(false);

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
    tauri::async_runtime::spawn(async move {
        let _guard = UpdateGuard;
        if let Err(error) = run_update(&app).await {
            app.dialog()
                .message(format!("检查或安装更新失败：{error}"))
                .title("AllSessions 更新")
                .kind(MessageDialogKind::Error)
                .blocking_show();
        }
    });
}

async fn run_update(app: &tauri::AppHandle) -> Result<(), String> {
    let update = app
        .updater()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())?;
    let Some(update) = update else {
        app.dialog()
            .message(format!(
                "当前版本 v{} 已是最新版本。",
                app.package_info().version
            ))
            .title("AllSessions 更新")
            .kind(MessageDialogKind::Info)
            .blocking_show();
        return Ok(());
    };

    let confirmed = app
        .dialog()
        .message(format!(
            "发现新版本 v{}，是否立即下载并安装？",
            update.version
        ))
        .title("AllSessions 更新")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::YesNo)
        .blocking_show();
    if !confirmed {
        return Ok(());
    }

    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|error| error.to_string())?;
    app.request_restart();
    Ok(())
}
