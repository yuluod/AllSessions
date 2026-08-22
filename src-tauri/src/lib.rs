mod backend;
mod cache;
mod config;
mod maintenance;
mod sessions;
mod updater;
mod watcher;

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};

use backend::{request_json, BackendState};

/// 托盘图标资产由 v3 原图生成，来源 `icons/128x128.png`。
/// 原图已经使用透明画布；近白背景清理仅作为旧资产兼容保护。
const TRAY_ICON_BYTES: &[u8] = include_bytes!("../icons/128x128.png");
const TRAY_BACKGROUND_CHANNEL_MIN: u8 = 245;

fn transparent_tray_icon() -> tauri::Result<tauri::image::Image<'static>> {
    let source = tauri::image::Image::from_bytes(TRAY_ICON_BYTES)?;
    let mut rgba = source.rgba().to_vec();
    transparentize_tray_background(&mut rgba);
    Ok(tauri::image::Image::new_owned(
        rgba,
        source.width(),
        source.height(),
    ))
}

fn transparentize_tray_background(rgba: &mut [u8]) {
    for pixel in rgba.as_chunks_mut::<4>().0 {
        if pixel[3] > 0
            && pixel[..3]
                .iter()
                .all(|channel| *channel >= TRAY_BACKGROUND_CHANNEL_MIN)
        {
            pixel[3] = 0;
        }
    }
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn show_settings(app: &tauri::AppHandle) {
    show_main_window(app);
    if let Err(error) = app.emit("open-settings", ()) {
        eprintln!("无法打开设置：{error}");
    }
}

fn create_tray(app: &tauri::App) -> tauri::Result<()> {
    let open_item = MenuItem::with_id(app, "open", "打开 AllSessions", true, None::<&str>)?;
    let settings_item = MenuItem::with_id(app, "settings", "设置…", true, None::<&str>)?;
    let update_item = MenuItem::with_id(app, "update", "检查更新", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(
        app,
        &[
            &open_item,
            &settings_item,
            &update_item,
            &separator,
            &quit_item,
        ],
    )?;

    TrayIconBuilder::new()
        .icon(transparent_tray_icon()?)
        .icon_as_template(true)
        .tooltip("AllSessions")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main_window(app),
            "settings" => show_settings(app),
            "update" => updater::check_for_updates(app.clone()),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            show_main_window(app)
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![request_json])
        .setup(|app| {
            let backend = BackendState::load().map_err(|error| format!("加载会话失败：{error}"))?;
            let check_updates_on_startup = backend
                .check_updates_on_startup()
                .map_err(|error| format!("读取常规设置失败：{error}"))?;
            app.manage(backend);
            app.manage(watcher::start(app.handle()));
            create_tray(app)?;
            if check_updates_on_startup {
                updater::check_for_updates_silently(app.handle().clone());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                match window.state::<BackendState>().keep_running_in_tray() {
                    Ok(true) => {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                    Ok(false) => window.app_handle().exit(0),
                    Err(error) => {
                        eprintln!("读取关闭窗口设置失败：{error}");
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("无法启动 AllSessions");
}

#[cfg(test)]
mod tests {
    use super::{transparent_tray_icon, transparentize_tray_background};

    #[test]
    fn 托盘图标会移除白色方形背景() {
        let mut rgba = [
            255, 255, 255, 255, 244, 244, 244, 255, 18, 112, 110, 255, 255, 255, 255, 0,
        ];

        transparentize_tray_background(&mut rgba);

        assert_eq!(rgba[3], 0);
        assert_eq!(rgba[7], 255);
        assert_eq!(rgba[11], 255);
        assert_eq!(rgba[15], 0);
    }

    #[test]
    fn 托盘图标使用透明画布() {
        let icon = transparent_tray_icon().expect("托盘图标必须可被解码");
        let width = icon.width() as usize;
        let height = icon.height() as usize;
        let rgba = icon.rgba();

        assert!(rgba.as_chunks::<4>().0.iter().any(|pixel| pixel[3] > 0));
        assert!(rgba[..width * 4]
            .as_chunks::<4>()
            .0
            .iter()
            .all(|pixel| pixel[3] == 0));
        assert!(rgba[(height - 1) * width * 4..]
            .as_chunks::<4>()
            .0
            .iter()
            .all(|pixel| pixel[3] == 0));
    }
}
