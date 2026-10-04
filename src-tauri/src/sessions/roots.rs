//! 来源根目录解析(配置/环境变量/默认值三级回退)、路径发现与监听根计算。
use std::collections::BTreeSet;
use std::env;
use std::ffi::OsStr;
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde_json::{json, Value};
use walkdir::WalkDir;

use super::{copilot, cursor, devin, hermes, kimi, vscode_copilot, Source, SourceFormat};

pub(crate) struct RootLists {
    pub codex: Vec<PathBuf>,
    pub codex_archived: Vec<PathBuf>,
    pub claude: Vec<PathBuf>,
    pub gemini: Vec<PathBuf>,
    pub pi: Vec<PathBuf>,
    pub kimi: Vec<PathBuf>,
    pub opencode: Vec<PathBuf>,
    pub kilo: Vec<PathBuf>,
    pub zcode: Vec<PathBuf>,
    pub cursor: Vec<PathBuf>,
    pub devin: Vec<PathBuf>,
    pub copilot: Vec<PathBuf>,
    pub hermes: Vec<PathBuf>,
    pub vscode_copilot: Vec<PathBuf>,
}

pub(crate) fn resolve_kind(
    config_roots: Option<&Vec<String>>,
    env_keys: &[&str],
    fallback: Vec<PathBuf>,
) -> (Vec<PathBuf>, &'static str) {
    if let Some(roots) = config_roots {
        return (
            roots
                .iter()
                .map(|raw| expand_tilde(PathBuf::from(raw)))
                .filter(|path| !path.as_os_str().is_empty())
                .collect(),
            "config",
        );
    }
    for env_key in env_keys {
        if let Some(value) = env::var_os(env_key) {
            return (split_path_list(&value), "env");
        }
    }
    (fallback, "default")
}

pub(crate) fn root_lists(config: &crate::config::SourceRoots) -> (RootLists, Value) {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    let codex_home = env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .map(expand_tilde)
        .unwrap_or_else(|| home.join(".codex"));
    let (codex, codex_origin) = resolve_kind(
        config.get("codex"),
        &["CODEX_SESSIONS_DIR"],
        vec![codex_home.join("sessions")],
    );
    let (codex_archived, codex_archived_origin) = resolve_kind(
        config.get("codex_archived"),
        &["CODEX_ARCHIVED_SESSIONS_DIR"],
        vec![codex_home.join("archived_sessions")],
    );
    let (claude, claude_origin) = resolve_kind(
        config.get("claude"),
        &["CLAUDE_SESSIONS_DIR"],
        vec![home.join(".claude")],
    );
    let (gemini, gemini_origin) = resolve_kind(
        config.get("gemini"),
        &["GEMINI_SESSIONS_DIR"],
        vec![home.join(".gemini")],
    );
    let pi_agent_dir = env::var_os("PI_CODING_AGENT_DIR")
        .map(PathBuf::from)
        .map(expand_tilde);
    let pi_fallback = pi_agent_dir
        .as_ref()
        .map(|path| path.join("sessions"))
        .unwrap_or_else(|| home.join(".pi").join("agent").join("sessions"));
    let (pi, mut pi_origin) = resolve_kind(
        config.get("pi"),
        &["PI_SESSIONS_DIR", "PI_CODING_AGENT_SESSION_DIR"],
        vec![pi_fallback],
    );
    if pi_origin == "default" && pi_agent_dir.is_some() {
        pi_origin = "env";
    }
    let (kimi, kimi_origin) = resolve_kind(
        config.get("kimi"),
        &["KIMI_SESSIONS_DIR", "KIMI_SHARE_DIR"],
        vec![home.join(".kimi")],
    );
    let opencode_data = env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .map(expand_tilde)
        .unwrap_or_else(|| home.join(".local").join("share"))
        .join("opencode");
    let (opencode, opencode_origin) = if let Some(roots) = config.get("opencode") {
        (
            roots
                .iter()
                .map(|raw| expand_tilde(PathBuf::from(raw)))
                .filter(|path| !path.as_os_str().is_empty())
                .collect(),
            "config",
        )
    } else if let Some(value) = env::var_os("OPENCODE_DB") {
        let path = expand_tilde(PathBuf::from(value));
        (
            vec![if path.is_absolute() {
                path
            } else {
                opencode_data.join(path)
            }],
            "env",
        )
    } else {
        (vec![opencode_data.join("opencode.db")], "default")
    };
    let kilo_data = env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .map(expand_tilde)
        .unwrap_or_else(|| home.join(".local").join("share"))
        .join("kilo");
    let (kilo, kilo_origin) = if let Some(roots) = config.get("kilo") {
        (
            roots
                .iter()
                .map(|raw| expand_tilde(PathBuf::from(raw)))
                .filter(|path| !path.as_os_str().is_empty())
                .collect(),
            "config",
        )
    } else if let Some(value) = env::var_os("KILO_DB") {
        let path = expand_tilde(PathBuf::from(value));
        (
            vec![if path.is_absolute() {
                path
            } else {
                kilo_data.join(path)
            }],
            "env",
        )
    } else {
        (vec![kilo_data.join("kilo.db")], "default")
    };
    let zcode_cli_dir = home.join(".zcode").join("cli");
    let (zcode, zcode_origin) = if let Some(roots) = config.get("zcode") {
        (
            roots
                .iter()
                .map(|raw| expand_tilde(PathBuf::from(raw)))
                .filter(|path| !path.as_os_str().is_empty())
                .collect(),
            "config",
        )
    } else if let Some(value) = env::var_os("ZCODE_DB") {
        let path = expand_tilde(PathBuf::from(value));
        (
            vec![if path.is_absolute() {
                path
            } else {
                zcode_cli_dir.join(path)
            }],
            "env",
        )
    } else {
        (vec![zcode_cli_dir.join("db").join("db.sqlite")], "default")
    };
    let cursor = config
        .cursor
        .as_ref()
        .map(|roots| {
            roots
                .iter()
                .map(|root| expand_tilde(PathBuf::from(root)))
                .collect::<Vec<_>>()
        })
        .unwrap_or_else(|| {
            vec![
                dirs::config_dir()
                    .unwrap_or_else(|| home.clone())
                    .join("Cursor")
                    .join("User"),
                home.join(".cursor").join("projects"),
            ]
        });
    let (devin, devin_origin) = resolve_kind(
        config.get("devin"),
        &["DEVIN_SESSIONS_DIR"],
        vec![
            dirs::config_dir()
                .unwrap_or_else(|| home.clone())
                .join("Devin")
                .join("User"),
            devin_cli_root(&home),
        ],
    );
    let (copilot, copilot_origin) = resolve_kind(
        config.get("copilot"),
        &["COPILOT_SESSIONS_DIR"],
        vec![home.join(".copilot").join("session-state")],
    );
    let hermes_home = env::var_os("HERMES_HOME")
        .map(PathBuf::from)
        .map(expand_tilde)
        .unwrap_or_else(default_hermes_root);
    let (hermes, mut hermes_origin) = resolve_kind(
        config.get("hermes"),
        &["HERMES_SESSIONS_DIR"],
        vec![hermes_home],
    );
    if hermes_origin == "default" && env::var_os("HERMES_HOME").is_some() {
        hermes_origin = "env";
    }
    let vscode_user_dirs = ["Code", "Code - Insiders"]
        .iter()
        .map(|app| {
            dirs::config_dir()
                .unwrap_or_else(|| home.clone())
                .join(app)
                .join("User")
        })
        .collect();
    let (vscode_copilot, vscode_copilot_origin) = resolve_kind(
        config.get("vscode_copilot"),
        &["VSCODE_COPILOT_SESSIONS_DIR"],
        vscode_user_dirs,
    );
    let description = json!({
        "codex": { "roots": codex.iter().map(|path| path.to_string_lossy()).collect::<Vec<_>>(), "origin": codex_origin },
        "codex_archived": { "roots": codex_archived.iter().map(|path| path.to_string_lossy()).collect::<Vec<_>>(), "origin": codex_archived_origin },
        "claude": { "roots": claude.iter().map(|path| path.to_string_lossy()).collect::<Vec<_>>(), "origin": claude_origin },
        "gemini": { "roots": gemini.iter().map(|path| path.to_string_lossy()).collect::<Vec<_>>(), "origin": gemini_origin },
        "pi": { "roots": pi.iter().map(|path| path.to_string_lossy()).collect::<Vec<_>>(), "origin": pi_origin },
        "kimi": { "roots": kimi.iter().map(|path| path.to_string_lossy()).collect::<Vec<_>>(), "origin": kimi_origin },
        "opencode": { "roots": opencode.iter().map(|path| path.to_string_lossy()).collect::<Vec<_>>(), "origin": opencode_origin },
        "kilo": { "roots": kilo.iter().map(|path| path.to_string_lossy()).collect::<Vec<_>>(), "origin": kilo_origin },
        "zcode": { "roots": zcode.iter().map(|path| path.to_string_lossy()).collect::<Vec<_>>(), "origin": zcode_origin },
        "cursor": { "roots": cursor.iter().map(|path|path.to_string_lossy()).collect::<Vec<_>>(), "origin": if config.cursor.is_some() { "config" } else { "default" } },
        "devin": { "roots": devin.iter().map(|path| path.to_string_lossy()).collect::<Vec<_>>(), "origin": devin_origin },
        "copilot": { "roots": copilot.iter().map(|path| path.to_string_lossy()).collect::<Vec<_>>(), "origin": copilot_origin },
        "hermes": { "roots": hermes.iter().map(|path| path.to_string_lossy()).collect::<Vec<_>>(), "origin": hermes_origin },
        "vscode_copilot": { "roots": vscode_copilot.iter().map(|path| path.to_string_lossy()).collect::<Vec<_>>(), "origin": vscode_copilot_origin },
    });
    (
        RootLists {
            codex,
            codex_archived,
            claude,
            gemini,
            pi,
            kimi,
            opencode,
            kilo,
            zcode,
            cursor,
            devin,
            copilot,
            hermes,
            vscode_copilot,
        },
        description,
    )
}

/// Hermes Agent 数据根：Windows 为 `%LOCALAPPDATA%\hermes`，
/// 其余平台为 `~/.hermes`（HERMES_HOME 由调用方处理）。
pub(crate) fn default_hermes_root() -> PathBuf {
    if cfg!(windows) {
        return dirs::data_local_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("hermes");
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".hermes")
}

/// Devin CLI 数据根：Unix 为 `$XDG_DATA_HOME/devin/cli`（默认
/// `~/.local/share/devin/cli`），Windows 为 `%LOCALAPPDATA%/devin/cli`。
pub(crate) fn devin_cli_root(home: &Path) -> PathBuf {
    if cfg!(windows) {
        return dirs::data_local_dir()
            .unwrap_or_else(|| home.to_path_buf())
            .join("devin")
            .join("cli");
    }
    env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .map(expand_tilde)
        .unwrap_or_else(|| home.join(".local").join("share"))
        .join("devin")
        .join("cli")
}

pub(crate) fn describe_sources(config: &crate::config::SourceRoots) -> Value {
    root_lists(config).1
}

pub(crate) fn describe_inherited_sources() -> Value {
    root_lists(&crate::config::SourceRoots::default()).1
}

pub(crate) fn source_root_identity(path: PathBuf) -> String {
    let expanded = expand_tilde(path);
    let absolute = if expanded.is_absolute() {
        expanded
    } else {
        env::current_dir()
            .map(|current| current.join(&expanded))
            .unwrap_or(expanded)
    };
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() && !normalized.has_root() {
                    normalized.push(component.as_os_str());
                }
            }
            _ => normalized.push(component.as_os_str()),
        }
    }
    let identity = path_identity(&normalized);
    if cfg!(windows) {
        identity.to_lowercase()
    } else {
        identity
    }
}

pub(crate) fn describe_protected_source_roots(
    configured: &[String],
    inherited: &[PathBuf],
) -> Vec<String> {
    let inherited_identities = inherited
        .iter()
        .cloned()
        .map(source_root_identity)
        .collect::<BTreeSet<_>>();
    configured
        .iter()
        .filter(|root| {
            inherited_identities.contains(&source_root_identity(PathBuf::from(root.as_str())))
        })
        .cloned()
        .collect()
}

pub(crate) fn describe_protected_sources(config: &crate::config::SourceRoots) -> Value {
    let inherited = root_lists(&crate::config::SourceRoots::default()).0;
    json!({
        "codex": describe_protected_source_roots(config.codex.as_deref().unwrap_or_default(), &inherited.codex),
        "codex_archived": describe_protected_source_roots(config.codex_archived.as_deref().unwrap_or_default(), &inherited.codex_archived),
        "claude": describe_protected_source_roots(config.claude.as_deref().unwrap_or_default(), &inherited.claude),
        "gemini": describe_protected_source_roots(config.gemini.as_deref().unwrap_or_default(), &inherited.gemini),
        "pi": describe_protected_source_roots(config.pi.as_deref().unwrap_or_default(), &inherited.pi),
        "kimi": describe_protected_source_roots(config.kimi.as_deref().unwrap_or_default(), &inherited.kimi),
        "opencode": describe_protected_source_roots(config.opencode.as_deref().unwrap_or_default(), &inherited.opencode),
        "kilo": describe_protected_source_roots(config.kilo.as_deref().unwrap_or_default(), &inherited.kilo),
        "zcode": describe_protected_source_roots(config.zcode.as_deref().unwrap_or_default(), &inherited.zcode),
        "cursor": describe_protected_source_roots(config.cursor.as_deref().unwrap_or_default(), &inherited.cursor),
        "devin": describe_protected_source_roots(config.devin.as_deref().unwrap_or_default(), &inherited.devin),
        "copilot": describe_protected_source_roots(config.copilot.as_deref().unwrap_or_default(), &inherited.copilot),
        "hermes": describe_protected_source_roots(config.hermes.as_deref().unwrap_or_default(), &inherited.hermes),
        "vscode_copilot": describe_protected_source_roots(config.vscode_copilot.as_deref().unwrap_or_default(), &inherited.vscode_copilot),
    })
}

pub(crate) fn configured_sources(config: &crate::config::SourceRoots) -> Vec<Source> {
    let lists = root_lists(config).0;
    let mut sources = sources_from_paths(
        &lists.codex,
        &lists.codex_archived,
        &lists.claude,
        &lists.gemini,
    );
    sources.extend(lists.pi.iter().map(|root| Source {
        kind: "pi",
        display_name: "Pi",
        root: root.clone(),
        format: SourceFormat::Pi,
        archived: false,
    }));
    sources.extend(lists.kimi.iter().map(|root| Source {
        kind: "kimi",
        display_name: "Kimi Code CLI",
        root: root.clone(),
        format: SourceFormat::Kimi,
        archived: false,
    }));
    sources.extend(lists.opencode.iter().map(|root| Source {
        kind: "opencode",
        display_name: "OpenCode",
        root: root.clone(),
        format: SourceFormat::OpenCode,
        archived: false,
    }));
    sources.extend(lists.kilo.iter().map(|root| Source {
        kind: "kilo",
        display_name: "Kilo",
        root: root.clone(),
        format: SourceFormat::Kilo,
        archived: false,
    }));
    sources.extend(lists.zcode.iter().map(|root| Source {
        kind: "zcode",
        display_name: "ZCode",
        root: root.clone(),
        format: SourceFormat::ZCode,
        archived: false,
    }));
    sources.extend(lists.cursor.iter().map(|root| Source {
        kind: "cursor",
        display_name: "Cursor",
        root: root.clone(),
        format: SourceFormat::Cursor,
        archived: false,
    }));
    sources.extend(lists.devin.iter().map(|root| Source {
        kind: "devin",
        display_name: "Devin",
        root: root.clone(),
        format: SourceFormat::Devin,
        archived: false,
    }));
    sources.extend(lists.copilot.iter().map(|root| Source {
        kind: "copilot",
        display_name: "GitHub Copilot",
        root: root.clone(),
        format: SourceFormat::Copilot,
        archived: false,
    }));
    sources.extend(lists.hermes.iter().map(|root| Source {
        kind: "hermes",
        display_name: "Hermes Agent",
        root: root.clone(),
        format: SourceFormat::Hermes,
        archived: false,
    }));
    sources.extend(lists.vscode_copilot.iter().map(|root| Source {
        kind: "vscode_copilot",
        display_name: "VS Code Copilot Chat",
        root: root.clone(),
        format: SourceFormat::VsCodeCopilot,
        archived: false,
    }));
    sources
}
pub(crate) fn sources_from_paths(
    codex_roots: &[PathBuf],
    codex_archived_roots: &[PathBuf],
    claude_roots: &[PathBuf],
    gemini_roots: &[PathBuf],
) -> Vec<Source> {
    codex_roots
        .iter()
        .map(|root| Source {
            kind: "codex",
            display_name: "Codex",
            root: root.clone(),
            format: SourceFormat::Codex,
            archived: false,
        })
        .chain(codex_archived_roots.iter().map(|root| Source {
            kind: "codex_archived",
            display_name: "Codex Archived",
            root: root.clone(),
            format: SourceFormat::Codex,
            archived: true,
        }))
        .chain(claude_roots.iter().flat_map(|root| {
            [root.join("projects"), root.join("sessions")].map(|root| Source {
                kind: "claude_code",
                display_name: "Claude Code",
                root,
                format: SourceFormat::Claude,
                archived: false,
            })
        }))
        .chain(gemini_roots.iter().map(|root| Source {
            kind: "gemini",
            display_name: "Gemini CLI",
            root: root.clone(),
            format: SourceFormat::Gemini,
            archived: false,
        }))
        // 注意：这里不过滤不存在的目录。来源目录可能在应用启动后才被创建，
        // 保留它们才能在 refresh 时重新发现；不存在的目录由扫描和监听逻辑各自兜底。
        .collect()
}
pub(crate) fn split_path_list(value: &OsStr) -> Vec<PathBuf> {
    env::split_paths(value)
        .map(expand_tilde)
        .filter(|path| !path.as_os_str().is_empty())
        .collect()
}
pub(crate) fn expand_tilde(path: PathBuf) -> PathBuf {
    let Some(text) = path.to_str() else {
        return path;
    };
    if text == "~" {
        return dirs::home_dir().unwrap_or_default();
    }
    if let Some(rest) = text.strip_prefix("~/").or_else(|| {
        if cfg!(windows) {
            text.strip_prefix("~\\")
        } else {
            None
        }
    }) {
        return dirs::home_dir().unwrap_or_default().join(rest);
    }
    path
}

pub(crate) fn path_identity(path: &Path) -> String {
    fs::canonicalize(path)
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|_| path.to_string_lossy().into_owned())
}
pub(crate) fn existing_watch_root(path: &Path) -> Option<PathBuf> {
    let blocked: Vec<PathBuf> = [
        dirs::home_dir(),
        dirs::config_dir(),
        dirs::data_dir(),
        dirs::data_local_dir(),
    ]
    .into_iter()
    .flatten()
    .collect();
    existing_watch_root_within(path, &blocked)
}

pub(crate) fn existing_watch_root_within(path: &Path, blocked: &[PathBuf]) -> Option<PathBuf> {
    let mut current = path;
    loop {
        if current.is_dir() {
            // 目录不存在时向上回溯到最近的现有父目录（如 ~/.codex/sessions
            // 尚未创建时监听 ~/.codex），但绝不回溯到 blocked 中的目录
            // （主目录、系统配置/数据目录等，如 ~/Library/Application Support
            // 会连带递归监听 Cursor/Devin 的默认根）或文件系统根，
            // 递归监听这些目录的代价过高。
            if current.parent().is_none() || blocked.iter().any(|b| b == current) {
                return None;
            }
            return Some(current.into());
        }
        current = current.parent()?;
    }
}

pub(crate) fn watch_roots_for(config: &crate::config::SourceRoots) -> Vec<PathBuf> {
    configured_sources(config)
        .iter()
        .filter_map(|source| existing_watch_root(&source.root))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}
pub(crate) fn discover_files(source: &Source) -> Vec<PathBuf> {
    if matches!(
        source.format,
        SourceFormat::OpenCode
            | SourceFormat::Kilo
            | SourceFormat::ZCode
            | SourceFormat::Devin
            | SourceFormat::Hermes
    ) {
        return source
            .root
            .exists()
            .then(|| source.root.clone())
            .into_iter()
            .collect();
    }
    if matches!(source.format, SourceFormat::Kimi) {
        return kimi::discover_files(source);
    }
    if matches!(source.format, SourceFormat::Copilot) {
        return copilot::discover_files(source);
    }
    if matches!(source.format, SourceFormat::VsCodeCopilot) {
        return vscode_copilot::discover_files(source);
    }
    let extension =
        if matches!(source.format, SourceFormat::Claude) && source.root.ends_with("sessions") {
            "json"
        } else {
            "jsonl"
        };
    WalkDir::new(&source.root)
        .max_depth(16)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| {
            entry.file_type().is_file()
                && entry.path().extension().and_then(|value| value.to_str()) == Some(extension)
        })
        .map(|entry| entry.into_path())
        .collect()
}

pub(crate) fn source_matches_path(source: &Source, path: &Path) -> bool {
    if matches!(source.format, SourceFormat::Cursor) {
        return cursor::matches_path(&source.root, path);
    }
    if matches!(source.format, SourceFormat::Devin) {
        return devin::matches_path(&source.root, path);
    }
    if matches!(source.format, SourceFormat::Hermes) {
        return hermes::matches_path(&source.root, path);
    }
    if matches!(
        source.format,
        SourceFormat::OpenCode | SourceFormat::Kilo | SourceFormat::ZCode
    ) {
        return opencode_event_matches(&source.root, path);
    }
    if matches!(source.format, SourceFormat::Kimi) {
        return kimi::matches_path(path);
    }
    if matches!(source.format, SourceFormat::Copilot) {
        return copilot::matches_path(&source.root, path);
    }
    if matches!(source.format, SourceFormat::VsCodeCopilot) {
        return vscode_copilot::matches_path(&source.root, path);
    }
    let extension =
        if matches!(source.format, SourceFormat::Claude) && source.root.ends_with("sessions") {
            "json"
        } else {
            "jsonl"
        };
    path.extension().and_then(|value| value.to_str()) == Some(extension)
}

pub(crate) fn opencode_event_matches(database: &Path, path: &Path) -> bool {
    if path == database {
        return true;
    }
    let Some(database_name) = database.file_name().and_then(|value| value.to_str()) else {
        return false;
    };
    // 只读连接也可能更新共享内存，不能用 -shm 变化触发再次扫描。
    path.parent() == database.parent()
        && matches!(
            path.file_name().and_then(|value| value.to_str()),
            Some(name) if name == format!("{database_name}-wal")
        )
}
