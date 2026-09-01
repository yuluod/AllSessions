use std::sync::atomic::{AtomicBool, Ordering};

use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
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

fn spawn_update_check(app: tauri::AppHandle, mode: UpdateCheckMode) {
    if UPDATE_RUNNING.swap(true, Ordering::AcqRel) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let _guard = UpdateGuard;
        if let Err(error) = run_update(&app, mode).await {
            if mode == UpdateCheckMode::Silent {
                return;
            }
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

fn update_confirmation_message(version: &str, body: Option<&str>) -> String {
    let mut message = format!("发现新版本 v{version}，是否立即下载并安装？");
    let notes = body
        .map(str::trim)
        .filter(|notes| !notes.is_empty())
        .map(plain_text_notes)
        .unwrap_or_default();
    if notes.is_empty() {
        return message;
    }

    message.push_str("\n\n更新内容：");
    if notes.chars().count() <= MAX_NOTES_CHARS {
        message.push('\n');
        message.push_str(&notes);
        return message;
    }

    let mut truncated: String = notes.chars().take(MAX_NOTES_CHARS).collect();
    if let Some(line_break) = truncated.rfind('\n') {
        if truncated[..line_break].chars().count() >= MAX_NOTES_CHARS / 2 {
            truncated.truncate(line_break);
        }
    }
    message.push_str(&format!(
        "\n{truncated}\n\n以上为部分更新内容，完整更新日志请前往 GitHub Releases 查看。"
    ));
    message
}

fn update_confirmation_buttons() -> MessageDialogButtons {
    MessageDialogButtons::OkCancelCustom("立即下载并安装".into(), "暂不".into())
}

async fn run_update(app: &tauri::AppHandle, mode: UpdateCheckMode) -> Result<(), String> {
    let update = app
        .updater()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())?;
    let Some(update) = update else {
        if mode == UpdateCheckMode::Interactive {
            app.dialog()
                .message(format!(
                    "当前版本 v{} 已是最新版本。",
                    app.package_info().version
                ))
                .title("AllSessions 更新")
                .kind(MessageDialogKind::Info)
                .blocking_show();
        }
        return Ok(());
    };

    let confirmed = app
        .dialog()
        .message(update_confirmation_message(
            &update.version,
            update.body.as_deref(),
        ))
        .title("AllSessions 更新")
        .kind(MessageDialogKind::Info)
        .buttons(update_confirmation_buttons())
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
    use tauri_plugin_dialog::MessageDialogButtons;

    use super::{
        update_confirmation_buttons, update_confirmation_message, update_error_message,
        UpdateCheckMode,
    };

    #[test]
    fn 更新确认使用中文操作文案() {
        match update_confirmation_buttons() {
            MessageDialogButtons::OkCancelCustom(confirm, cancel) => {
                assert_eq!(confirm, "立即下载并安装");
                assert_eq!(cancel, "暂不");
            }
            _ => panic!("更新确认必须使用自定义的确定和取消文案"),
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
    fn 更新确认附带清理后的更新日志() {
        let message = update_confirmation_message(
            "0.1.0",
            Some("### 新增\n\n- **支持**在更新提示中显示更新日志。\n\n### 修复\n\n- 修复 `滚动条` 布局跳动。"),
        );

        assert!(message.starts_with("发现新版本 v0.1.0，是否立即下载并安装？"));
        assert!(message.contains("更新内容："));
        assert!(message.contains("【新增】"));
        assert!(message.contains("- 支持在更新提示中显示更新日志。"));
        assert!(message.contains("【修复】"));
        assert!(!message.contains("**"));
        assert!(!message.contains("###"));
    }

    #[test]
    fn 缺少更新日志时保持原有确认文案() {
        let message = update_confirmation_message("0.1.0", None);
        assert_eq!(message, "发现新版本 v0.1.0，是否立即下载并安装？");

        let empty = update_confirmation_message("0.1.0", Some("  \n"));
        assert_eq!(empty, "发现新版本 v0.1.0，是否立即下载并安装？");
    }

    #[test]
    fn 超长更新日志截断并引导查看完整内容() {
        let long_notes = (0..80)
            .map(|index| format!("- 第 {index} 条更新说明，用于验证截断行为。"))
            .collect::<Vec<_>>()
            .join("\n");
        let message = update_confirmation_message("0.1.0", Some(&long_notes));

        assert!(message.contains("以上为部分更新内容，完整更新日志请前往 GitHub Releases 查看。"));
        assert!(message.chars().count() < long_notes.chars().count());
    }

    #[test]
    fn 中文更新日志按字符位置判断截断换行() {
        let notes = format!("{}\n{}", "甲".repeat(100), "乙".repeat(600));
        let message = update_confirmation_message("0.1.0", Some(&notes));

        assert!(message.contains('乙'));
    }

    #[test]
    fn 启动检查与手动检查使用不同提示模式() {
        assert_ne!(UpdateCheckMode::Silent, UpdateCheckMode::Interactive);
    }
}
