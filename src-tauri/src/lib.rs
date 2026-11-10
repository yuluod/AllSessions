mod app_icon;
mod backend;
mod cache;
mod config;
mod deletion_backup;
mod error;
mod external_link;
mod maintenance;
mod platform;
mod resume;
mod search;
mod sessions;
mod updater;
mod watcher;
mod workspace;

use serde_json::{Value, json};
use tauri::{
    Emitter, Manager,
    menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
};

use backend::{BackendState, cancel_read_request, request_json};
mod request_control;

/// 托盘图标资产由 v3 原图生成，来源 `icons/128x128.png`。
/// 原图已经使用透明画布；近白背景清理仅作为旧资产兼容保护。
const TRAY_ICON_BYTES: &[u8] = include_bytes!("../icons/128x128.png");
const TRAY_BACKGROUND_CHANNEL_MIN: u8 = 245;
const TRAY_SESSION_OPEN_PREFIX: &str = "session-open:";
const TRAY_SESSION_RESUME_PREFIX: &str = "session-resume:";
/// 菜单项标题过长会被系统截断；按显示宽度收敛（全角计 2），保证来源后缀可见。
const TRAY_MENU_TITLE_WIDTH: usize = 36;

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

/// 常见 CJK/全角区间按 2 列计，其余按 1 列计；覆盖常用区间即可，
/// 不需要完整的 wcwidth 表。
fn char_display_width(c: char) -> usize {
    match c {
        '\u{1100}'..='\u{115f}'
        | '\u{2e80}'..='\u{a4cf}'
        | '\u{ac00}'..='\u{d7a3}'
        | '\u{f900}'..='\u{faff}'
        | '\u{fe30}'..='\u{fe6f}'
        | '\u{ff00}'..='\u{ff60}'
        | '\u{ffe0}'..='\u{ffe6}'
        | '\u{1f300}'..='\u{1faff}'
        | '\u{20000}'..='\u{2fffd}'
        | '\u{30000}'..='\u{3fffd}' => 2,
        _ => 1,
    }
}

/// 把连续空白折叠为单个空格并按显示宽度截断，避免菜单项出现换行
/// 或 CJK 标题挤掉来源后缀。
fn compact_menu_text(text: &str, width_limit: usize) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut width = 0;
    let mut out = String::new();
    for c in collapsed.chars() {
        let char_width = char_display_width(c);
        if width + char_width > width_limit {
            out.push('…');
            return out;
        }
        width += char_width;
        out.push(c);
    }
    out
}

/// 「最近会话」菜单项：时间前缀 + 标题 + 来源后缀，与列表标题口径一致。
fn tray_session_label(summary: &Value) -> String {
    let title = summary["title"]
        .as_str()
        .map(|title| compact_menu_text(title, TRAY_MENU_TITLE_WIDTH))
        .filter(|title| !title.is_empty())
        .or_else(|| {
            summary["cwd"]
                .as_str()
                .and_then(|cwd| cwd.rsplit(['/', '\\']).find(|part| !part.is_empty()))
                .map(str::to_string)
        })
        .or_else(|| summary["id"].as_str().map(str::to_string))
        .unwrap_or_else(|| "未命名会话".to_string());
    let time = summary["last_timestamp"]
        .as_str()
        .or_else(|| summary["timestamp"].as_str())
        .and_then(|timestamp| {
            let parsed = chrono::DateTime::parse_from_rfc3339(timestamp).ok()?;
            let local = parsed.with_timezone(&chrono::Local);
            let today = chrono::Local::now().date_naive();
            Some(if local.date_naive() == today {
                local.format("%H:%M").to_string()
            } else if Some(local.date_naive()) == today.pred_opt() {
                "昨天".to_string()
            } else {
                local.format("%m-%d").to_string()
            })
        });
    let source = summary["display_source"]
        .as_str()
        .or_else(|| summary["source_kind"].as_str())
        .filter(|source| !source.is_empty());
    let mut label = match time {
        Some(time) => format!("{time} {title}"),
        None => title,
    };
    if let Some(source) = source {
        label.push_str(&format!(" · {source}"));
    }
    label
}

/// 一组会话子菜单（收藏段/最近段共用结构）。
fn build_session_submenus(
    app: &tauri::AppHandle,
    sessions: &[Value],
) -> tauri::Result<Vec<Submenu<tauri::Wry>>> {
    let mut items = Vec::with_capacity(sessions.len());
    for summary in sessions {
        let Some(key) = summary["_key"].as_str() else {
            continue;
        };
        let open_item = MenuItem::with_id(
            app,
            format!("{TRAY_SESSION_OPEN_PREFIX}{key}"),
            "打开详情",
            true,
            None::<&str>,
        )?;
        // 不支持恢复的来源保留禁用项，比隐藏更能说明「此来源不可恢复」。
        let resumable = summary["source_kind"]
            .as_str()
            .map(resume::resume_supported)
            .unwrap_or_default();
        let resume_item = MenuItem::with_id(
            app,
            format!("{TRAY_SESSION_RESUME_PREFIX}{key}"),
            "恢复会话",
            resumable,
            None::<&str>,
        )?;
        // 父项只负责展开子菜单，不会触发菜单事件；用独立前缀避免被
        // 事件分发误匹配。
        items.push(Submenu::with_id_and_items(
            app,
            format!("session-group:{key}"),
            tray_session_label(summary),
            true,
            &[&open_item, &resume_item],
        )?);
    }
    Ok(items)
}

fn build_tray_menu(
    app: &tauri::AppHandle,
    favorites: &[Value],
    recents: &[Value],
) -> tauri::Result<Menu<tauri::Wry>> {
    let open_item = MenuItem::with_id(app, "open", "打开 AllSessions", true, None::<&str>)?;
    let settings_item = MenuItem::with_id(app, "settings", "设置…", true, None::<&str>)?;
    let update_item = MenuItem::with_id(app, "update", "检查更新", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let sessions_separator = PredefinedMenuItem::separator(app)?;
    let quit_separator = PredefinedMenuItem::separator(app)?;
    // 分节标题做成禁用项，既分组又不抢点击。
    let favorites_header =
        MenuItem::with_id(app, "section-favorites", "收藏会话", false, None::<&str>)?;
    let recents_header =
        MenuItem::with_id(app, "section-recents", "最近会话", false, None::<&str>)?;

    let favorite_items = build_session_submenus(app, favorites)?;
    let recent_items = build_session_submenus(app, recents)?;

    let mut items: Vec<&dyn IsMenuItem<tauri::Wry>> =
        vec![&open_item, &settings_item, &update_item];
    if !favorite_items.is_empty() || !recent_items.is_empty() {
        items.push(&sessions_separator);
        if !favorite_items.is_empty() {
            items.push(&favorites_header);
            for item in &favorite_items {
                items.push(item);
            }
        }
        if !recent_items.is_empty() {
            items.push(&recents_header);
            for item in &recent_items {
                items.push(item);
            }
        }
    }
    items.push(&quit_separator);
    items.push(&quit_item);
    Menu::with_items(app, &items)
}

/// 会话列表发布后同步托盘会话段；失败只记日志，不影响发布结果。
pub(crate) fn refresh_tray_menu(app: &tauri::AppHandle) {
    let Some(tray) = app.tray_by_id(app_icon::TRAY_ID) else {
        return;
    };
    let (favorites, recents) = app
        .try_state::<BackendState>()
        .map(|state| state.tray_sessions())
        .unwrap_or_default();
    match build_tray_menu(app, &favorites, &recents) {
        Ok(menu) => {
            if let Err(error) = tray.set_menu(Some(menu)) {
                eprintln!("更新托盘菜单失败：{error}");
            }
        }
        Err(error) => eprintln!("构建托盘菜单失败：{error}"),
    }
}

/// 把登录自启动偏好同步到系统注册项；已处于目标状态时不再重写注册。
/// debug 构建整体跳过：开发二进制与正式版共享同一注册标识，
/// 任一方向的同步都可能覆盖正式版的自启动注册。
pub(crate) fn sync_autostart(app: &tauri::AppHandle, enabled: bool) {
    if cfg!(debug_assertions) {
        eprintln!("开发构建跳过登录自启动同步（目标状态：{enabled}）");
        return;
    }
    use tauri_plugin_autostart::ManagerExt;
    let manager = app.autolaunch();
    let registered = manager.is_enabled().unwrap_or(false);
    let result = if enabled && !registered {
        manager.enable().map(|_| ())
    } else if !enabled && registered {
        manager.disable().map(|_| ())
    } else {
        Ok(())
    };
    if let Err(error) = result {
        eprintln!("同步登录自启动失败：{error}");
    }
}

fn create_tray(app: &tauri::App) -> tauri::Result<()> {
    // 首次扫描尚未发布，菜单先不含会话段；扫描完成后由
    // refresh_tray_menu 重建补齐。
    let menu = build_tray_menu(app.handle(), &[], &[])?;

    TrayIconBuilder::with_id(app_icon::TRAY_ID)
        .icon(transparent_tray_icon()?)
        .icon_as_template(true)
        .tooltip("AllSessions")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let id = event.id();
            let session_action = id
                .as_ref()
                .strip_prefix(TRAY_SESSION_OPEN_PREFIX)
                .map(|key| ("open-session", key))
                .or_else(|| {
                    id.as_ref()
                        .strip_prefix(TRAY_SESSION_RESUME_PREFIX)
                        .map(|key| ("resume-session", key))
                });
            if let Some((event_name, key)) = session_action
                && !key.is_empty()
            {
                show_main_window(app);
                if let Err(error) = app.emit(event_name, json!({ "key": key })) {
                    eprintln!("无法打开会话：{error}");
                }
                return;
            }
            match id.as_ref() {
                "open" => show_main_window(app),
                "settings" => show_settings(app),
                "update" => {
                    show_main_window(app);
                    updater::check_for_updates(app.clone());
                }
                "quit" => app.exit(0),
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            // 单击与双击左键都直接打开主窗口；菜单保持右键弹出。
            // 单击被忽略会显得“点了没反应”，与 Dock 图标行为也不一致。
            match event {
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    ..
                }
                | TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                } => show_main_window(tray.app_handle()),
                _ => {}
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
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![request_json, cancel_read_request])
        .setup(|app| {
            let backend = BackendState::load().map_err(|error| format!("加载会话失败：{error}"))?;
            app.manage(backend);
            app.manage(watcher::start(app.handle()));
            app.state::<BackendState>().spawn_initial_scan(app.handle());
            create_tray(app)?;
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
        .build(tauri::generate_context!())
        .expect("无法启动 AllSessions")
        .run(|app, event| match event {
            // 事件循环完全启动后再恢复应用图标，避开启动阶段的主线程时序。
            tauri::RunEvent::Ready => {
                let icon = app.state::<BackendState>().app_icon();
                if icon != app_icon::ICON_DEFAULT {
                    app_icon::apply(app, &icon);
                }
                // 自启动注册可能与偏好漂移（重装、外部清理），按偏好自愈。
                sync_autostart(app, app.state::<BackendState>().launch_at_login());
            }
            // macOS：应用驻留托盘时点击程序坞图标（或 Finder 里再次打开）
            // 会触发 Reopen；没有可见窗口时重新显示主窗口，否则用户会
            // 以为应用“打不开”。该事件仅在 macOS 存在；Windows / Linux
            // 隐藏窗口后本就只有托盘入口，由平台无关的托盘单击处理覆盖。
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen {
                has_visible_windows: false,
                ..
            } => show_main_window(app),
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::{
        TRAY_MENU_TITLE_WIDTH, compact_menu_text, transparent_tray_icon,
        transparentize_tray_background, tray_session_label,
    };
    use serde_json::json;

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
    fn 托盘菜单文本折叠空白并按显示宽度截断() {
        assert_eq!(
            compact_menu_text("  第一行\n第二行\t缩进  ", 20),
            "第一行 第二行 缩进"
        );
        assert_eq!(compact_menu_text("短标题", 20), "短标题");
        let long = "很长的会话标题".repeat(8);
        let label = compact_menu_text(&long, TRAY_MENU_TITLE_WIDTH);
        assert!(label.ends_with('…'));
        // 全角按 2 列计：36 列宽度只能容纳 18 个 CJK 字符再加省略号。
        assert_eq!(label.chars().count(), 19);
        let ascii = "a".repeat(60);
        assert_eq!(
            compact_menu_text(&ascii, TRAY_MENU_TITLE_WIDTH),
            format!("{}…", "a".repeat(TRAY_MENU_TITLE_WIDTH))
        );
    }

    #[test]
    fn 托盘会话标签回退到目录与编号并附来源() {
        let label = tray_session_label(&json!({
            "cwd": "/tmp/projects/demo",
            "display_source": "Claude Code",
        }));
        assert_eq!(label, "demo · Claude Code");

        let label = tray_session_label(&json!({
            "id": "sess-9",
            "source_kind": "codex",
        }));
        assert_eq!(label, "sess-9 · codex");

        assert_eq!(tray_session_label(&json!({})), "未命名会话");
    }

    #[test]
    fn 托盘会话标签带时间前缀() {
        use chrono::TimeZone;
        // 固定过去日期一律显示 MM-DD，与运行机器时区无关。
        let label = tray_session_label(&json!({
            "title": "排查构建失败",
            "last_timestamp": "2001-06-15T12:00:00Z",
        }));
        let (time, title) = label.split_once(' ').expect("应包含时间前缀");
        assert_eq!(time.len(), 5);
        assert!(time.contains('-'));
        assert_eq!(title, "排查构建失败");

        // 当天会话显示本地 HH:MM；取本地正午构造时间戳避免跨日界抖动。
        let noon = chrono::Local
            .from_local_datetime(
                &chrono::Local::now()
                    .date_naive()
                    .and_hms_opt(12, 0, 0)
                    .expect("正午时间有效"),
            )
            .single()
            .expect("本地正午可解析")
            .to_rfc3339();
        let label = tray_session_label(&json!({
            "title": "今天的会话",
            "last_timestamp": noon,
        }));
        let (time, title) = label.split_once(' ').expect("应包含时间前缀");
        assert_eq!(time, "12:00");
        assert_eq!(title, "今天的会话");
    }

    #[test]
    fn 托盘图标使用透明画布() {
        let icon = transparent_tray_icon().expect("托盘图标必须可被解码");
        let width = icon.width() as usize;
        let height = icon.height() as usize;
        let rgba = icon.rgba();

        assert!(rgba.as_chunks::<4>().0.iter().any(|pixel| pixel[3] > 0));
        assert!(
            rgba[..width * 4]
                .as_chunks::<4>()
                .0
                .iter()
                .all(|pixel| pixel[3] == 0)
        );
        assert!(
            rgba[(height - 1) * width * 4..]
                .as_chunks::<4>()
                .0
                .iter()
                .all(|pixel| pixel[3] == 0)
        );
    }
}
