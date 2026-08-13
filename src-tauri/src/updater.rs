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
                .message(update_error_message(&error))
                .title("AllSessions 更新")
                .kind(MessageDialogKind::Error)
                .blocking_show();
        }
    });
}

fn update_error_message(error: &str) -> String {
    if error.contains("None of the fallback platforms") {
        return "当前发布没有适用于此设备架构的更新包。请从 GitHub Releases 手动下载安装，或等待包含此平台更新包的新版本。".to_string();
    }
    format!("检查或安装更新失败：{error}")
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

#[cfg(test)]
mod tests {
    use super::update_error_message;

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
}
