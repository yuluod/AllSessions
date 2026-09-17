//! 平台差异的进程辅助。

use std::process::Command;

/// Windows 下 GUI 子系统进程派生控制台程序（where、tasklist、cmd 等）
/// 会为子进程分配新控制台，表现为终端窗口一闪而过；
/// 静默运行的子进程统一加 CREATE_NO_WINDOW，其他平台为空操作。
pub fn hide_console(command: &mut Command) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = command;
    }
}
