//! 在系统终端中恢复 Agent 会话。
//!
//! 前端只传 sessionKey，恢复命令由后端按 source_kind 白名单构造，
//! 不接受前端传入的任意命令字符串。

use serde_json::{json, Value};
use std::process::Command;

use crate::error::ApiError;

/// 与前端 `resumeCommandForKind` 保持一致的恢复命令模板。
fn resume_command(kind: &str, id: &str) -> Option<String> {
    let template = match kind {
        "claude_code" => "claude --resume",
        "codex" | "codex_archived" => "codex resume",
        "gemini" => "gemini --resume",
        "pi" => "pi --resume",
        "kimi" => "kimi --resume",
        "opencode" => "opencode resume",
        "zcode" => "zcode --resume",
        _ => return None,
    };
    Some(format!("{template} {id}"))
}

/// POSIX shell 单引号转义：' → '\''。
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// Windows `cmd /k` 双引号转义。
#[cfg(target_os = "windows")]
fn cmd_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

/// 会话 ID 只允许安全字符，避免它在各平台终端里被二次解释。
fn is_safe_session_id(id: &str) -> bool {
    !id.is_empty()
        && id.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':' | '/'))
}

/// 当前平台可选的终端应用，供设置界面渲染选项。
/// "auto" 表示按内置顺序自动探测；每项带 installed 标记，
/// 前端只展示已安装的预设（auto/custom 始终可用）。
pub fn terminal_options() -> Vec<Value> {
    terminal_option_values()
        .iter()
        .map(|(value, label)| {
            json!({
                "value": value,
                "label": label,
                "installed": option_installed(value),
            })
        })
        .collect()
}

#[cfg(target_os = "macos")]
fn option_installed(value: &str) -> bool {
    match value {
        "iterm" => iterm_installed(),
        // Terminal.app 是系统自带；auto/custom 不依赖具体应用。
        _ => true,
    }
}

#[cfg(target_os = "windows")]
fn option_installed(value: &str) -> bool {
    match value {
        "wt" => command_exists("wt"),
        _ => true,
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn option_installed(value: &str) -> bool {
    match value {
        "auto" | "custom" => true,
        name => command_exists(name),
    }
}

#[cfg(target_os = "macos")]
fn terminal_option_values() -> &'static [(&'static str, &'static str)] {
    &[
        ("auto", "Auto"),
        ("terminal", "Terminal.app"),
        ("iterm", "iTerm2"),
        ("custom", "Custom"),
    ]
}

#[cfg(target_os = "windows")]
fn terminal_option_values() -> &'static [(&'static str, &'static str)] {
    &[
        ("auto", "Auto"),
        ("cmd", "Command Prompt"),
        ("wt", "Windows Terminal"),
        ("custom", "Custom"),
    ]
}

#[cfg(all(unix, not(target_os = "macos")))]
fn terminal_option_values() -> &'static [(&'static str, &'static str)] {
    &[
        ("auto", "Auto"),
        ("kgx", "GNOME Console"),
        ("gnome-terminal", "GNOME Terminal"),
        ("ptyxis", "Ptyxis"),
        ("konsole", "Konsole"),
        ("alacritty", "Alacritty"),
        ("kitty", "kitty"),
        ("wezterm", "WezTerm"),
        ("xterm", "XTerm"),
        ("custom", "Custom"),
    ]
}

/// 打开一个新终端窗口，在会话原 cwd 下执行恢复命令。
/// `terminal` 来自常规设置；"auto" 或未知值按平台默认顺序探测，
/// "custom" 使用 `custom` 指定的应用名称或可执行文件路径。
/// 返回实际下发的命令文本，供前端展示。
pub fn resume_session(
    summary: &Value,
    terminal: &str,
    custom: &str,
) -> Result<Value, ApiError> {
    let kind = summary["source_kind"].as_str().unwrap_or_default();
    let id = summary["id"].as_str().unwrap_or_default();
    let cwd = summary["cwd"].as_str().unwrap_or_default();

    if !is_safe_session_id(id) {
        return Err(ApiError::invalid("会话 ID 包含无法安全传递的字符"));
    }
    let command = resume_command(kind, id)
        .ok_or_else(|| ApiError::invalid("该来源不支持恢复会话"))?;

    if terminal == "custom" && custom.trim().is_empty() {
        return Err(ApiError::invalid("请先在设置中填写自定义终端"));
    }
    spawn_in_terminal(&command, cwd, terminal, custom.trim())?;
    Ok(json!({ "ok": true, "command": command }))
}

#[cfg(target_os = "macos")]
fn spawn_in_terminal(
    command: &str,
    cwd: &str,
    terminal: &str,
    custom: &str,
) -> Result<(), ApiError> {
    let line = if cwd.is_empty() {
        command.to_string()
    } else {
        format!("cd {} && {}", shell_quote(cwd), command)
    };
    if terminal == "custom" {
        return spawn_custom_macos(&line, custom);
    }
    // AppleScript 字符串字面量：转义反斜杠与双引号。
    let script_line = line.replace('\\', "\\\\").replace('"', "\\\"");
    let use_iterm = match terminal {
        "iterm" => {
            if !iterm_installed() {
                return Err(ApiError::invalid("iTerm2 未安装"));
            }
            true
        }
        "terminal" => false,
        _ => iterm_installed(),
    };
    let script = if use_iterm {
        format!(
            "tell application \"iTerm\"\n\
             activate\n\
             create window with default profile command \"{script_line}\"\n\
             end tell"
        )
    } else {
        format!("tell application \"Terminal\" to do script \"{script_line}\"")
    };
    let status = Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .status()
        .map_err(|error| ApiError::from(format!("无法启动终端：{error}")))?;
    if status.success() {
        Ok(())
    } else {
        Err(ApiError::from("终端拒绝了恢复命令"))
    }
}

#[cfg(target_os = "macos")]
fn iterm_installed() -> bool {
    std::path::Path::new("/Applications/iTerm.app").is_dir()
        || dirs::home_dir()
            .map(|home| home.join("Applications/iTerm.app").is_dir())
            .unwrap_or(false)
}

/// 自定义终端（Ghostty、Warp 等）：优先 `open -na <App> --args -e bash -c <line>`
/// （覆盖支持 -e 的终端），失败时回退到 .command 文件 + `open -a`。
#[cfg(target_os = "macos")]
fn spawn_custom_macos(line: &str, app: &str) -> Result<(), ApiError> {
    let via_args = Command::new("open")
        .args(["-na", app, "--args", "-e", "bash", "-c", line])
        .status();
    if matches!(via_args, Ok(status) if status.success()) {
        return Ok(());
    }
    spawn_via_command_file(line, app)
}

/// 写入临时 .command 脚本并用指定应用打开；Terminal.app/iTerm 及注册了
/// .command 的终端都能处理。脚本执行后自删。
#[cfg(target_os = "macos")]
fn spawn_via_command_file(line: &str, app: &str) -> Result<(), ApiError> {
    use std::os::unix::fs::PermissionsExt;
    let path = std::env::temp_dir().join(format!(
        "allsessions-resume-{}.command",
        std::process::id()
    ));
    let script = format!("#!/bin/sh\n{}\nrm -f {}\n", line, shell_quote(&path.to_string_lossy()));
    std::fs::write(&path, script)
        .map_err(|error| ApiError::from(format!("无法创建恢复脚本：{error}")))?;
    let mut permissions = std::fs::metadata(&path)
        .map_err(|error| ApiError::from(format!("无法读取恢复脚本：{error}")))?
        .permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&path, permissions)
        .map_err(|error| ApiError::from(format!("无法设置恢复脚本权限：{error}")))?;
    let status = Command::new("open")
        .args(["-a", app])
        .arg(&path)
        .status()
        .map_err(|error| ApiError::from(format!("无法启动终端：{error}")))?;
    if status.success() {
        Ok(())
    } else {
        let _ = std::fs::remove_file(&path);
        Err(ApiError::from(format!("无法通过 {app} 打开恢复脚本")))
    }
}

#[cfg(target_os = "windows")]
fn spawn_in_terminal(
    command: &str,
    cwd: &str,
    terminal: &str,
    custom: &str,
) -> Result<(), ApiError> {
    if terminal == "custom" {
        // 约定：<可执行文件> cmd /k <命令>，与 wt 的参数形式一致。
        let mut cmd = Command::new(custom);
        cmd.args(["cmd", "/k", command]);
        if !cwd.is_empty() {
            cmd.current_dir(cwd);
        }
        return cmd
            .spawn()
            .map(|_| ())
            .map_err(|error| ApiError::from(format!("无法启动终端：{error}")));
    }
    // Windows Terminal：wt -d <目录> cmd /k <命令>；目录作为独立 argv 无需转义。
    let spawn_wt = || -> Result<(), std::io::Error> {
        let mut args: Vec<String> = Vec::new();
        if !cwd.is_empty() {
            args.push("-d".to_string());
            args.push(cwd.to_string());
        }
        args.push("cmd".to_string());
        args.push("/k".to_string());
        args.push(command.to_string());
        Command::new("wt").args(&args).spawn().map(|_| ())
    };
    // start "标题" /d "目录" cmd /k <命令>
    let spawn_cmd = || -> Result<(), std::io::Error> {
        let mut args = vec![
            "/c".to_string(),
            "start".to_string(),
            "\"AllSessions\"".to_string(),
        ];
        if !cwd.is_empty() {
            args.push("/d".to_string());
            args.push(cmd_quote(cwd));
        }
        args.push("cmd".to_string());
        args.push("/k".to_string());
        args.push(command.to_string());
        Command::new("cmd").args(&args).spawn().map(|_| ())
    };
    let result = match terminal {
        "wt" => spawn_wt(),
        "cmd" => spawn_cmd(),
        _ => spawn_wt().or_else(|_| spawn_cmd()),
    };
    result.map_err(|error| ApiError::from(format!("无法启动终端：{error}")))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn spawn_in_terminal(
    command: &str,
    cwd: &str,
    terminal: &str,
    custom: &str,
) -> Result<(), ApiError> {
    let mut line = String::new();
    if !cwd.is_empty() {
        line.push_str(&format!("cd {} && ", shell_quote(cwd)));
    }
    line.push_str(command);
    // 命令结束后保留窗口，便于查看错误输出。
    line.push_str("; exec ${SHELL:-sh}");

    // (可执行名, 执行参数前缀)。bash -c 是各终端通用的执行方式。
    const TERMINALS: &[(&str, &[&str])] = &[
        ("kgx", &["--"]),
        ("gnome-terminal", &["--"]),
        ("ptyxis", &["--"]),
        ("konsole", &["-e"]),
        ("alacritty", &["-e"]),
        ("kitty", &[]),
        ("wezterm", &["start", "--"]),
        ("xterm", &["-e"]),
    ];
    if terminal == "custom" {
        // 约定：<可执行文件> bash -c <line>，覆盖 Alacritty/kitty 风格；
        // 需要 -e 的终端请改用预设选项。
        return Command::new(custom)
            .args(["bash", "-c", &line])
            .spawn()
            .map(|_| ())
            .map_err(|error| ApiError::from(format!("无法启动终端：{error}")));
    }
    let candidates: Vec<(&str, &[&str])> = match terminal {
        "auto" | "" => TERMINALS.to_vec(),
        explicit => match TERMINALS.iter().find(|(name, _)| *name == explicit) {
            Some(entry) => vec![*entry],
            None => return Err(ApiError::invalid("未知的终端应用")),
        },
    };
    for (name, prefix) in candidates {
        if !command_exists(name) {
            continue;
        }
        let result = Command::new(name)
            .args(prefix.iter())
            .args(["bash", "-c", &line])
            .spawn();
        match result {
            Ok(_) => return Ok(()),
            Err(_) => continue,
        }
    }
    Err(ApiError::from("未找到可用的终端模拟器"))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn command_exists(name: &str) -> bool {
    Command::new("which")
        .arg(name)
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

#[cfg(target_os = "windows")]
fn command_exists(name: &str) -> bool {
    Command::new("where")
        .arg(name)
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 各来源的恢复命令与前端一致() {
        assert_eq!(
            resume_command("claude_code", "abc"),
            Some("claude --resume abc".to_string())
        );
        assert_eq!(
            resume_command("codex", "abc"),
            Some("codex resume abc".to_string())
        );
        assert_eq!(
            resume_command("codex_archived", "abc"),
            Some("codex resume abc".to_string())
        );
        assert_eq!(
            resume_command("zcode", "abc"),
            Some("zcode --resume abc".to_string())
        );
        assert_eq!(resume_command("unknown", "abc"), None);
    }

    #[test]
    fn shell_引号转义单引号() {
        assert_eq!(shell_quote("/a/b c"), "'/a/b c'");
        assert_eq!(shell_quote("a'b"), "'a'\\''b'");
    }

    #[test]
    fn 会话_id_校验拒绝危险字符() {
        assert!(is_safe_session_id("0190abcd-1234-7def-8000-aaaaaaaaaaaa"));
        assert!(is_safe_session_id("session_2026.01:01"));
        assert!(!is_safe_session_id(""));
        assert!(!is_safe_session_id("id; rm -rf /"));
        assert!(!is_safe_session_id("$(whoami)"));
        assert!(!is_safe_session_id("a b"));
    }
}
