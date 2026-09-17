//! 平台差异的进程辅助。

/// Windows 下 GUI 子系统进程派生控制台程序（where、tasklist、cmd 等）
/// 会为子进程分配新控制台，表现为终端窗口一闪而过；静默运行的子进程
/// 统一加 CREATE_NO_WINDOW。仅 Windows 存在，其他平台没有对应概念，
/// 调用点也全部位于 Windows 分支。
#[cfg(target_os = "windows")]
pub fn hide_console(command: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}
