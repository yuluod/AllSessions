mod updater;

use std::{net::TcpListener, sync::Mutex, thread, time::Duration};

use serde::Deserialize;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    Manager, RunEvent,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_shell::{process::CommandChild, process::CommandEvent, ShellExt};
use uuid::Uuid;

struct ServerProcess(Mutex<Option<CommandChild>>);
struct ViewerInstance(Mutex<Option<ViewerEndpoint>>);

#[derive(Clone)]
struct ViewerEndpoint {
    url: String,
    token: String,
}

#[derive(Deserialize)]
struct ViewerCapabilities {
    service: ViewerService,
    codex_maintenance: Option<CodexMaintenance>,
}

#[derive(Deserialize)]
struct ViewerService {
    name: String,
    protocol_version: u8,
    desktop_instance_token: String,
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

fn capabilities_match(capabilities: &ViewerCapabilities, instance_token: &str) -> bool {
    capabilities.service.name == "AllSessions"
        && capabilities.service.protocol_version == 1
        && capabilities.service.desktop_instance_token == instance_token
        && capabilities.codex_maintenance.is_some()
}

fn viewer_available(endpoint: &ViewerEndpoint) -> bool {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(1))
        .build()
        .and_then(|client| {
            client
                .get(format!("{}/api/capabilities", endpoint.url))
                .send()?
                .error_for_status()?
                .json::<ViewerCapabilities>()
        })
        .is_ok_and(|capabilities| capabilities_match(&capabilities, &endpoint.token))
}

fn allocate_viewer_endpoint() -> std::io::Result<(ViewerEndpoint, u16)> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok((
        ViewerEndpoint {
            url: format!("http://127.0.0.1:{port}"),
            token: Uuid::new_v4().to_string(),
        },
        port,
    ))
}

fn stop_server(app: &tauri::AppHandle) {
    if let Ok(mut process) = app.state::<ServerProcess>().0.lock() {
        if let Some(child) = process.take() {
            let _ = child.kill();
        }
    }
}

fn open_viewer(app: &tauri::AppHandle) {
    let endpoint = app
        .state::<ViewerInstance>()
        .0
        .lock()
        .ok()
        .and_then(|endpoint| endpoint.clone());
    let Some(endpoint) = endpoint.filter(viewer_available) else {
        app.dialog()
            .message("本地服务身份校验失败，请重新启动 AllSessions。")
            .title("无法打开 AllSessions")
            .kind(MessageDialogKind::Error)
            .blocking_show();
        return;
    };
    if let Some(window) = app.get_webview_window("main") {
        if let Ok(url) = endpoint.url.parse() {
            let _ = window.navigate(url);
        }
    }
    show_main_window(app);
}

fn wait_for_viewer(app: tauri::AppHandle, endpoint: ViewerEndpoint) {
    thread::spawn(move || {
        for _ in 0..120 {
            if viewer_available(&endpoint) {
                open_viewer(&app);
                return;
            }
            thread::sleep(Duration::from_millis(500));
        }
        app.dialog()
            .message("后台服务启动超时，请重新启动 AllSessions。")
            .title("AllSessions 启动失败")
            .kind(MessageDialogKind::Error)
            .blocking_show();
    });
}

fn start_server(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let (endpoint, port) = allocate_viewer_endpoint()?;
    *app.state::<ViewerInstance>()
        .0
        .lock()
        .map_err(|_| "本地服务身份状态已损坏")? = Some(endpoint.clone());

    let resource_dir = app.path().resource_dir()?;
    let command = app
        .shell()
        .sidecar("node")?
        .arg("server/index.js")
        .current_dir(resource_dir)
        .env("ALLSESSIONS_OPEN_BROWSER", "0")
        .env("ALLSESSIONS_INSTANCE_TOKEN", &endpoint.token)
        .env("PORT", port.to_string());
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
    wait_for_viewer(app.handle().clone(), endpoint);
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(ServerProcess(Mutex::new(None)))
        .manage(ViewerInstance(Mutex::new(None)))
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

#[cfg(test)]
mod tests {
    use super::{
        allocate_viewer_endpoint, capabilities_match, CodexMaintenance, ViewerCapabilities,
        ViewerService,
    };

    fn capabilities(token: &str) -> ViewerCapabilities {
        ViewerCapabilities {
            service: ViewerService {
                name: "AllSessions".to_string(),
                protocol_version: 1,
                desktop_instance_token: token.to_string(),
            },
            codex_maintenance: Some(CodexMaintenance { _enabled: false }),
        }
    }

    #[test]
    fn 只接受当前桌面进程启动的服务() {
        assert!(capabilities_match(&capabilities("expected"), "expected"));
        assert!(!capabilities_match(&capabilities("other"), "expected"));
    }

    #[test]
    fn 拒绝名称或协议不匹配的服务() {
        let mut value = capabilities("expected");
        value.service.name = "Other".to_string();
        assert!(!capabilities_match(&value, "expected"));

        value.service.name = "AllSessions".to_string();
        value.service.protocol_version = 2;
        assert!(!capabilities_match(&value, "expected"));
    }

    #[test]
    fn 为桌面服务分配动态_loopback_地址() {
        let (endpoint, port) = allocate_viewer_endpoint().expect("应能分配本地端口");
        assert!(port > 0);
        assert_eq!(endpoint.url, format!("http://127.0.0.1:{port}"));
        assert!(!endpoint.token.is_empty());
    }
}
