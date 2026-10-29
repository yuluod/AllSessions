//! 运行时应用图标：设置里切换，立即应用到程序坞 / 任务栏并随配置持久化。
//!
//! 图标 PNG 在编译期内嵌，不落盘、不依赖
//! 资源路径解析。macOS 上修改的是 `NSApplication` 的程序坞图标——应用包
//! 本体（icns）不变，退出后恢复系统默认；Windows 上同步更新窗口与托盘
//! 图标，Linux 上更新窗口图标。
use tauri::AppHandle;

pub const ICON_DEFAULT: &str = "default";
pub const ICON_AMBER: &str = "amber";
pub const ICON_IDS: [&str; 2] = [ICON_DEFAULT, ICON_AMBER];
pub const TRAY_ID: &str = "main-tray";

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
        #[cfg(target_os = "windows")]
        if let Err(error) = apply_tray_icon(app, id) {
            eprintln!("更新托盘图标失败：{error}");
        }
    }
}

#[cfg(any(target_os = "windows", test))]
fn tray_icon(id: &str) -> tauri::Result<tauri::image::Image<'static>> {
    if id == ICON_AMBER {
        // 复用 256px 预览资产，避免把 1024px 程序坞图标交给 Windows 托盘。
        tauri::image::Image::from_bytes(include_bytes!(
            "../../public/assets/allsessions-icon-amber.png"
        ))
    } else {
        // 切回经典时恢复原有透明托盘图标，而非程序坞大图。
        crate::transparent_tray_icon()
    }
}

#[cfg(target_os = "windows")]
fn apply_tray_icon(app: &AppHandle, id: &str) -> Result<(), String> {
    let tray = app.tray_by_id(TRAY_ID).ok_or("主托盘图标不存在")?;
    let image = tray_icon(id).map_err(|error| error.to_string())?;
    tray.set_icon(Some(image))
        .map_err(|error| error.to_string())
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

#[cfg(test)]
mod tests {
    use super::{ICON_AMBER, ICON_DEFAULT, tray_icon};

    #[test]
    fn 托盘图标变体可解码且尺寸适合_windows() {
        for id in [ICON_DEFAULT, ICON_AMBER] {
            let icon = tray_icon(id).expect("托盘图标必须可解码");
            assert!(icon.width() > 0 && icon.width() <= 256);
            assert!(icon.height() > 0 && icon.height() <= 256);
            assert_eq!(
                icon.rgba().len(),
                (icon.width() * icon.height() * 4) as usize
            );
            assert!(
                icon.rgba()
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .any(|pixel| pixel[3] > 0)
            );
            assert_eq!(icon.rgba()[3], 0);
        }
    }

    #[test]
    fn 托盘图标切换变体并可恢复原始经典图标() {
        let original = crate::transparent_tray_icon().unwrap();
        let amber = tray_icon(ICON_AMBER).unwrap();
        let restored = tray_icon(ICON_DEFAULT).unwrap();
        assert_ne!(amber.rgba(), original.rgba());
        assert_eq!(restored.width(), original.width());
        assert_eq!(restored.height(), original.height());
        assert_eq!(restored.rgba(), original.rgba());
    }
}
