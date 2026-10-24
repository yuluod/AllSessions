//! 运行时应用图标：设置里切换，立即应用到程序坞 / 任务栏并随配置持久化。
//!
//! 图标 PNG 在编译期内嵌（`src-tauri/icons/runtime/`），不落盘、不依赖
//! 资源路径解析。macOS 上修改的是 `NSApplication` 的程序坞图标——应用包
//! 本体（icns）不变，退出后恢复系统默认；Windows / Linux 上更新窗口图标。
use tauri::AppHandle;

pub const ICON_DEFAULT: &str = "default";
pub const ICON_AMBER: &str = "amber";
pub const ICON_IDS: [&str; 2] = [ICON_DEFAULT, ICON_AMBER];

fn icon_bytes(id: &str) -> &'static [u8] {
    match id {
        ICON_AMBER => include_bytes!("../icons/runtime/amber.png"),
        ICON_DEFAULT => include_bytes!("../icons/runtime/default.png"),
        // 配置解析已限定合法取值，未知值按经典图标处理。
        _ => include_bytes!("../icons/runtime/default.png"),
    }
}

/// 应用图标；失败只记录日志，不影响设置保存等其他流程。
pub fn apply(app: &AppHandle, id: &str) {
    #[cfg(target_os = "macos")]
    {
        let id = id.to_string();
        if let Err(error) = app.run_on_main_thread(move || set_dock_icon(&id)) {
            eprintln!("应用图标切换失败：{error}");
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        use tauri::Manager;
        let image = match tauri::image::Image::from_bytes(icon_bytes(id)) {
            Ok(image) => image,
            Err(error) => {
                eprintln!("解析内嵌图标失败：{error}");
                return;
            }
        };
        for (label, window) in app.webview_windows() {
            if let Err(error) = window.set_icon(image.clone()) {
                eprintln!("更新窗口 {label} 图标失败：{error}");
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn set_dock_icon(id: &str) {
    use objc2::AnyThread as _;
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::MainThreadMarker;

    let Some(marker) = MainThreadMarker::new() else {
        eprintln!("应用图标切换失败：不在主线程");
        return;
    };
    let application = NSApplication::sharedApplication(marker);
    if id == ICON_DEFAULT {
        // 恢复应用包自带图标。
        unsafe { application.setApplicationIconImage(None) };
        return;
    }
    let data = objc2_foundation::NSData::with_bytes(icon_bytes(id));
    let Some(image) = NSImage::initWithData(NSImage::alloc(), &data) else {
        eprintln!("应用图标切换失败：内嵌图标无法解码为 NSImage");
        return;
    };
    unsafe { application.setApplicationIconImage(Some(&image)) };
}
