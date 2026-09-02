use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::{json, Value};
use tauri::Emitter;
use tauri_plugin_updater::UpdaterExt;

static UPDATE_RUNNING: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Copy, Debug, PartialEq)]
enum UpdateCheckMode {
    Interactive,
    Silent,
}

struct UpdateGuard;

impl Drop for UpdateGuard {
    fn drop(&mut self) {
        UPDATE_RUNNING.store(false, Ordering::Release);
    }
}

pub fn check_for_updates(app: tauri::AppHandle) {
    spawn_update_check(app, UpdateCheckMode::Interactive);
}

pub fn check_for_updates_silently(app: tauri::AppHandle) {
    spawn_update_check(app, UpdateCheckMode::Silent);
}

pub fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    if UPDATE_RUNNING.swap(true, Ordering::AcqRel) {
        return Err("另一项更新操作仍在进行，请稍后重试。".into());
    }
    tauri::async_runtime::spawn(async move {
        let _guard = UpdateGuard;
        if let Err(error) = run_install(&app).await {
            emit_status(
                &app,
                json!({ "phase": "error", "message": update_error_message(&error) }),
            );
        }
    });
    Ok(())
}

fn spawn_update_check(app: tauri::AppHandle, mode: UpdateCheckMode) {
    if UPDATE_RUNNING.swap(true, Ordering::AcqRel) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let _guard = UpdateGuard;
        if let Err(error) = run_update_check(&app, mode).await {
            if mode == UpdateCheckMode::Interactive {
                emit_status(
                    &app,
                    json!({ "phase": "error", "message": update_error_message(&error) }),
                );
            }
        }
    });
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

const MAX_NOTES_CHARS: usize = 600;

fn plain_text_notes(notes: &str) -> String {
    let mut lines: Vec<String> = Vec::new();
    for line in notes.lines() {
        let trimmed = line.trim();
        let text = match trimmed.strip_prefix('#') {
            Some(heading) => format!("【{}】", heading.trim_start_matches('#').trim()),
            None => trimmed.to_string(),
        };
        let text = text.replace("**", "").replace('`', "");
        if !lines.is_empty() || !text.is_empty() {
            lines.push(text);
        }
    }
    while lines.last().is_some_and(|line| line.is_empty()) {
        lines.pop();
    }
    lines.join("\n")
}

fn bounded_notes(body: Option<&str>) -> String {
    let notes = body
        .map(str::trim)
        .filter(|notes| !notes.is_empty())
        .map(plain_text_notes)
        .unwrap_or_default();
    if notes.chars().count() <= MAX_NOTES_CHARS {
        return notes;
    }

    let mut truncated: String = notes.chars().take(MAX_NOTES_CHARS).collect();
    if let Some(line_break) = truncated.rfind('\n') {
        if truncated[..line_break].chars().count() >= MAX_NOTES_CHARS / 2 {
            truncated.truncate(line_break);
        }
    }
    format!("{truncated}\n\n以上为部分更新内容，完整更新日志请前往 GitHub Releases 查看。")
}

async fn check(app: &tauri::AppHandle) -> Result<Option<tauri_plugin_updater::Update>, String> {
    app.updater()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())
}

async fn run_update_check(app: &tauri::AppHandle, mode: UpdateCheckMode) -> Result<(), String> {
    if mode == UpdateCheckMode::Interactive {
        emit_status(app, json!({ "phase": "checking" }));
    }
    let Some(update) = check(app).await? else {
        if mode == UpdateCheckMode::Interactive {
            emit_status(
                app,
                json!({
                    "phase": "latest",
                    "version": app.package_info().version.to_string(),
                }),
            );
        }
        return Ok(());
    };

    emit_status(
        app,
        json!({
            "phase": "available",
            "version": update.version,
            "notes": bounded_notes(update.body.as_deref()),
        }),
    );
    Ok(())
}

async fn run_install(app: &tauri::AppHandle) -> Result<(), String> {
    let Some(update) = check(app).await? else {
        return Err("更新已不可用，请重新检查。".into());
    };

    emit_status(
        app,
        json!({
            "phase": "downloading",
            "version": update.version,
            "downloaded": 0,
            "total": null,
        }),
    );

    let mut downloaded = 0_u64;
    let progress_app = app.clone();
    let install_app = app.clone();
    update
        .download_and_install(
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
            move || emit_status(&install_app, json!({ "phase": "installing" })),
        )
        .await
        .map_err(|error| error.to_string())?;
    app.request_restart();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{bounded_notes, update_error_message, UpdateCheckMode};

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
    fn 更新日志转换为适合窗口展示的纯文本() {
        let notes = bounded_notes(Some(
            "### 新增\n\n- **支持**在更新提示中显示更新日志。\n\n### 修复\n\n- 修复 `滚动条` 布局跳动。",
        ));

        assert!(notes.contains("【新增】"));
        assert!(notes.contains("- 支持在更新提示中显示更新日志。"));
        assert!(notes.contains("【修复】"));
        assert!(!notes.contains("**"));
        assert!(!notes.contains("###"));
    }

    #[test]
    fn 缺少更新日志时返回空文本() {
        assert_eq!(bounded_notes(None), "");
        assert_eq!(bounded_notes(Some("  \n")), "");
    }

    #[test]
    fn 超长更新日志截断并引导查看完整内容() {
        let long_notes = (0..80)
            .map(|index| format!("- 第 {index} 条更新说明，用于验证截断行为。"))
            .collect::<Vec<_>>()
            .join("\n");
        let notes = bounded_notes(Some(&long_notes));

        assert!(notes.contains("以上为部分更新内容，完整更新日志请前往 GitHub Releases 查看。"));
        assert!(notes.chars().count() < long_notes.chars().count());
    }

    #[test]
    fn 中文更新日志按字符位置判断截断换行() {
        let notes = format!("{}\n{}", "甲".repeat(100), "乙".repeat(600));
        let result = bounded_notes(Some(&notes));

        assert!(result.contains('乙'));
    }

    #[test]
    fn 启动检查与手动检查使用不同提示模式() {
        assert_ne!(UpdateCheckMode::Silent, UpdateCheckMode::Interactive);
    }
}
