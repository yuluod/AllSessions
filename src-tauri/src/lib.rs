mod updater;

use std::{sync::Mutex, thread, time::Duration};

use serde::Deserialize;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    Manager, RunEvent,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_shell::{process::CommandChild, process::CommandEvent, ShellExt};

const VIEWER_URL: &str = "http://127.0.0.1:3210";

struct ServerProcess(Mutex<Option<CommandChild>>);

#[derive(Deserialize)]
struct ViewerCapabilities {
    codex_maintenance: Option<CodexMaintenance>,
}

#[derive(Deserialize)]
struct CodexMaintenance {
    #[serde(rename = "enabled")]
    _enabled: bool,
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn viewer_available() -> bool {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(1))
        .build()
        .and_then(|client| {
            client
                .get(format!("{VIEWER_URL}/api/capabilities"))
                .send()?
                .error_for_status()?
                .json::<ViewerCapabilities>()
        })
        .is_ok_and(|capabilities| capabilities.codex_maintenance.is_some())
}

fn stop_server(app: &tauri::AppHandle) {
    if let Ok(mut process) = app.state::<ServerProcess>().0.lock() {
        if let Some(child) = process.take() {
            let _ = child.kill();
        }
    }
}

fn open_viewer(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if let Ok(url) = VIEWER_URL.parse() {
            let _ = window.navigate(url);
        }
    }
    show_main_window(app);
}

fn wait_for_viewer(app: tauri::AppHandle) {
    thread::spawn(move || {
        for _ in 0..120 {
            if viewer_available() {
                open_viewer(&app);
                return;
            }
            thread::sleep(Duration::from_millis(500));
        }
        app.dialog()
            .message("后台服务启动超时，请确认端口 3210 未被其他程序占用。")
            .title("AllSessions 启动失败")
            .kind(MessageDialogKind::Error)
            .blocking_show();
    });
}

fn start_server(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    if viewer_available() {
        open_viewer(app.handle());
        return Ok(());
    }

    let resource_dir = app.path().resource_dir()?;
    let command = app
        .shell()
        .sidecar("node")?
        .arg("server/index.js")
        .current_dir(resource_dir)
        .env("ALLSESSIONS_OPEN_BROWSER", "0");
    let (mut events, child) = command.spawn()?;
    *app.state::<ServerProcess>()
        .0
        .lock()
        .map_err(|_| "后台进程状态已损坏")? = Some(child);

    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(line) => println!("{}", String::from_utf8_lossy(&line)),
                CommandEvent::Stderr(line) => eprintln!("{}", String::from_utf8_lossy(&line)),
                _ => {}
            }
        }
    });
    wait_for_viewer(app.handle().clone());
    Ok(())
}

fn create_tray(app: &tauri::App) -> tauri::Result<()> {
    let open_item = MenuItem::with_id(app, "open", "打开 AllSessions", true, None::<&str>)?;
    let update_item = MenuItem::with_id(app, "update", "检查更新", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open_item, &update_item, &separator, &quit_item])?;

    TrayIconBuilder::new()
        .icon(app.default_window_icon().expect("应用图标必须存在").clone())
        .tooltip("AllSessions")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => open_viewer(app),
            "update" => updater::check_for_updates(app.clone()),
            "quit" => {
                stop_server(app);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } = event
            {
                open_viewer(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            show_main_window(app)
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(ServerProcess(Mutex::new(None)))
        .setup(|app| {
            create_tray(app)?;
            start_server(app).map_err(|error| error.to_string())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("无法启动 AllSessions");

    app.run(|app, event| {
        if matches!(event, RunEvent::Exit | RunEvent::ExitRequested { .. }) {
            stop_server(app);
        }
    });
}
