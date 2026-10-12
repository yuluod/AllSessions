//! Cowork 本地任务只读适配，正文复用 Claude 转录解析。
use std::path::{Component, Path, PathBuf};

use serde_json::{json, Value};
use walkdir::WalkDir;

use super::{error_text, parse, summary_search_text, Source, SourceFormat};

pub(super) fn default_roots() -> Vec<PathBuf> {
    let base = dirs::data_dir().unwrap_or_default();
    let mut roots = vec![
        base.join("Claude/local-agent-mode-sessions"),
        base.join("Claude-3p/local-agent-mode-sessions"),
    ];
    if cfg!(windows) {
        if let Some(local) = dirs::data_local_dir() {
            roots.push(local.join(
                "Packages/Claude_pzs8sxrjxfjjc/LocalCache/Roaming/Claude/local-agent-mode-sessions",
            ));
        }
    }
    roots
}

pub(super) fn sessions_root(root: &Path) -> PathBuf {
    if root.ends_with("local-agent-mode-sessions") {
        root.into()
    } else {
        root.join("local-agent-mode-sessions")
    }
}

pub(super) fn matches_path(root: &Path, path: &Path) -> bool {
    let root = sessions_root(root);
    let Ok(relative) = path.strip_prefix(&root) else {
        return false;
    };
    let parts = relative.components().collect::<Vec<_>>();
    parts.len() == 7
        && parts.iter().all(|p| matches!(p, Component::Normal(_)))
        && parts[3].as_os_str() == ".claude"
        && parts[4].as_os_str() == "projects"
        && path
            .extension()
            .is_some_and(|extension| extension == "jsonl")
}

pub(super) fn discover_files(source: &Source) -> Vec<PathBuf> {
    let mut files = WalkDir::new(sessions_root(&source.root))
        .follow_links(false)
        .max_depth(7)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file() && matches_path(&source.root, entry.path()))
        .map(|entry| entry.into_path())
        .collect::<Vec<_>>();
    files.sort();
    files
}

pub(super) fn event_matches(root: &Path, path: &Path) -> bool {
    if matches_path(root, path) {
        return true;
    }
    let root = sessions_root(root);
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    let depth = relative.components().count();
    depth <= 3
        && (path.is_dir()
            || !path.exists() && path.extension().is_none()
            || depth == 3
                && path
                    .file_name()
                    .and_then(|s| s.to_str())
                    .is_some_and(|s| s.starts_with("local_") && s.ends_with(".json")))
}

fn metadata(path: &Path, source: &Source) -> Result<Value, String> {
    if !matches_path(&source.root, path) {
        return Err("Cowork 转录路径无效".into());
    }
    let root = sessions_root(&source.root);
    let mut current = root.clone();
    for part in path.strip_prefix(&root).map_err(error_text)?.components() {
        current.push(part);
        if std::fs::symlink_metadata(&current)
            .map_err(error_text)?
            .file_type()
            .is_symlink()
        {
            return Err("Cowork 转录路径不能包含符号链接".into());
        }
    }
    let task = path.ancestors().nth(4).ok_or("Cowork 任务路径无效")?;
    let parent = task.parent().ok_or("Cowork 任务路径无效")?;
    let id = path
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or("Cowork 转录编号无效")?;
    for entry in std::fs::read_dir(parent).map_err(error_text)? {
        let entry = entry.map_err(error_text)?;
        let candidate = entry.path();
        if !candidate
            .file_name()
            .and_then(|s| s.to_str())
            .is_some_and(|s| s.starts_with("local_") && s.ends_with(".json"))
        {
            continue;
        }
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(error) => {
                eprintln!(
                    "无法读取 Claude Cowork 元数据（{}）：{error}",
                    candidate.display()
                );
                continue;
            }
        };
        if !file_type.is_file() {
            continue;
        }
        let file = match std::fs::File::open(&candidate) {
            Ok(file) => file,
            Err(error) => {
                eprintln!(
                    "无法读取 Claude Cowork 元数据（{}）：{error}",
                    candidate.display()
                );
                continue;
            }
        };
        let value: Value = match serde_json::from_reader(file) {
            Ok(value) => value,
            Err(error) => {
                eprintln!(
                    "无法解析 Claude Cowork 元数据（{}）：{error}",
                    candidate.display()
                );
                continue;
            }
        };
        if value["cliSessionId"] == id {
            return Ok(value);
        }
    }
    Ok(Value::Null)
}

fn decorate(summary: &mut Value, meta: &Value) {
    summary["source_read_only"] = json!(true);
    summary["originator"] = json!("claude_cowork");
    summary["source"] = json!("desktop");
    if let Some(title) = meta["title"].as_str().filter(|s| !s.trim().is_empty()) {
        summary["title"] = json!(super::compact_title(title, 90));
    }
    summary["desktop_session_id"] = meta["sessionId"].clone();
    summary["desktop_archived"] = meta["isArchived"].clone();
    summary["model"] = meta["model"].clone();
    summary["host_directories"] = meta["userSelectedFolders"].clone();
    // 沙箱 cwd 无法直接交给主机终端；只有单一所选目录时才作为主目录。
    summary["sandbox_cwd"] = summary["cwd"].clone();
    summary["cwd"] = meta["userSelectedFolders"]
        .as_array()
        .filter(|folders| folders.len() == 1)
        .and_then(|folders| folders[0].as_str())
        .map_or(Value::Null, |cwd| json!(cwd));
    for (field, target) in [
        ("createdAt", "timestamp"),
        ("lastActivityAt", "last_timestamp"),
    ] {
        if let Some(time) = meta[field].as_i64().and_then(super::timestamp_from_millis) {
            summary[target] = json!(time);
        }
    }
}

fn proxy(source: &Source) -> Source {
    Source {
        format: SourceFormat::Claude,
        ..source.clone()
    }
}

pub(super) fn parse_summary(path: &Path, source: &Source) -> Result<(Value, String), String> {
    let meta = metadata(path, source)?;
    let (mut summary, text) = parse::parse_summary(path, &proxy(source))?;
    decorate(&mut summary, &meta);
    let mut search = summary_search_text(&summary);
    super::append_limited(&mut search, &[&text], super::SEARCH_TEXT_LIMIT);
    Ok((summary, search))
}

pub(super) fn visit_detail(
    path: &Path,
    source: &Source,
    visitor: &mut dyn FnMut(&Value),
) -> Result<Value, String> {
    let meta = metadata(path, source)?;
    let mut detail = parse::visit_detail(path, &proxy(source), &mut |message| {
        let mut message = message.clone();
        message.as_object_mut().unwrap().remove("_delete_ref");
        visitor(&message);
    })?;
    decorate(&mut detail["summary"], &meta);
    if let Some(messages) = detail["conversation_messages"].as_array_mut() {
        for message in messages {
            message.as_object_mut().unwrap().remove("_delete_ref");
        }
    }
    Ok(detail)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 损坏候选元数据不阻断正常转录() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("local-agent-mode-sessions");
        let parent = root.join("account/org");
        let project = parent.join("task/.claude/projects/session");
        std::fs::create_dir_all(&project).unwrap();
        let path = project.join("cli-id.jsonl");
        let wire = json!({"type":"user","sessionId":"cli-id","message":{"role":"user","content":"有效正文"}}).to_string();
        std::fs::write(&path, &wire).unwrap();
        let broken = parent.join("local_other.json");
        std::fs::write(&broken, "{").unwrap();
        let source = Source {
            kind: "claude_cowork",
            display_name: "Claude Cowork",
            root,
            format: SourceFormat::ClaudeCowork,
            archived: false,
        };
        let (summary, _) = parse_summary(&path, &source).unwrap();
        assert_eq!(summary["id"], "cli-id");
        assert_eq!(summary["message_count"], 1);
        std::fs::write(
            parent.join("local_valid.json"),
            json!({"cliSessionId":"cli-id","title":"匹配标题"}).to_string(),
        )
        .unwrap();
        let (summary, _) = parse_summary(&path, &source).unwrap();
        assert_eq!(summary["title"], "匹配标题");
        assert_eq!(
            visit_detail(&path, &source, &mut |_| {}).unwrap()["conversation_messages"][0]["text"],
            "有效正文"
        );
        assert_eq!(std::fs::read_to_string(path).unwrap(), wire);
        assert_eq!(std::fs::read_to_string(broken).unwrap(), "{");
    }

    #[test]
    fn cowork关联元数据并复用消息工具思考解析() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("local-agent-mode-sessions");
        let parent = root.join("account/org");
        let project = parent.join("task/.claude/projects/session");
        std::fs::create_dir_all(&project).unwrap();
        let path = project.join("cli-id.jsonl");
        let wire = [
            json!({"type":"user","sessionId":"cli-id","cwd":"/sandbox","message":{"role":"user","content":"虚构问题"}}),
            json!({"type":"assistant","sessionId":"cli-id","message":{"id":"response","role":"assistant","content":[{"type":"thinking","thinking":"虚构思考"},{"type":"tool_use","id":"call","name":"Read","input":{"path":"example.txt"}}]}}),
            json!({"type":"user","sessionId":"cli-id","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call","content":"虚构结果"}]}}),
        ].iter().map(Value::to_string).collect::<Vec<_>>().join("\n");
        std::fs::write(&path, &wire).unwrap();
        let metadata = parent.join("local_desktop-id.json");
        std::fs::write(&metadata, json!({"sessionId":"local_desktop-id","cliSessionId":"cli-id","title":"虚构标题","userSelectedFolders":["/host/project"],"createdAt":1791768000000_i64,"lastActivityAt":1791769000000_i64}).to_string()).unwrap();
        std::fs::write(parent.join("task/audit.jsonl"), "不是正文来源").unwrap();
        let source = Source {
            kind: "claude_cowork",
            display_name: "Claude Cowork",
            root,
            format: SourceFormat::ClaudeCowork,
            archived: false,
        };
        assert_eq!(discover_files(&source), vec![path.clone()]);
        let (summary, search) = parse_summary(&path, &source).unwrap();
        assert_eq!(summary["title"], "虚构标题");
        assert_eq!(summary["cwd"], "/host/project");
        assert_eq!(summary["sandbox_cwd"], "/sandbox");
        assert_eq!(summary["source_read_only"], true);
        assert!(search.contains("虚构结果"));
        let mut visited = 0;
        let detail = visit_detail(&path, &source, &mut |message| {
            visited += 1;
            assert!(message.get("_delete_ref").is_none());
        })
        .unwrap();
        assert_eq!(visited, 4);
        let description = super::super::root_lists(&crate::config::SourceRoots::default()).1;
        let disabled = description
            .as_object()
            .unwrap()
            .keys()
            .map(|kind| (kind.clone(), json!([])))
            .collect::<serde_json::Map<_, _>>();
        let mut config: crate::config::SourceRoots =
            serde_json::from_value(Value::Object(disabled)).unwrap();
        config.claude_cowork = Some(vec![source.root.to_string_lossy().into_owned()]);
        let mut store = super::super::SessionStore {
            summaries: Vec::new(),
            records: std::collections::HashMap::new(),
            sources: Vec::new(),
            sources_config: config,
            index_cache: crate::cache::IndexCache::disabled(),
            detail_cache: super::super::DetailCache::new(super::super::DETAIL_CACHE_BYTES),
            scan_diagnostics: super::super::ScanDiagnostics::default(),
        };
        store.refresh().unwrap();
        assert_eq!(
            store.detail("claude_cowork:cli-id").unwrap()["summary"]["title"],
            "虚构标题"
        );
        assert!(store.delete_session("claude_cowork:cli-id").is_err());
        let hits = store
            .search(
                &std::collections::HashMap::from([("q".into(), "虚构结果".into())]),
                &crate::workspace::WorkspaceSnapshot::default(),
            )
            .unwrap();
        assert_eq!(hits["sessions"].as_array().unwrap().len(), 1);
        assert!(detail["conversation_messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|message| message["source_subtype"] == "thinking"));
        std::fs::write(&metadata, json!({"cliSessionId":"cli-id","title":"更新标题","userSelectedFolders":["/one","/two"]}).to_string()).unwrap();
        let (summary, _) = parse_summary(&path, &source).unwrap();
        assert_eq!(summary["title"], "更新标题");
        assert!(summary["cwd"].is_null());
        store
            .refresh_paths(&std::collections::BTreeSet::from([metadata]))
            .unwrap();
        assert_eq!(
            store.detail("claude_cowork:cli-id").unwrap()["summary"]["title"],
            "更新标题"
        );
        assert!(!event_matches(
            &source.root,
            &parent.join("task/audit.jsonl")
        ));
        assert_eq!(std::fs::read_to_string(path).unwrap(), wire);
    }

    #[test]
    #[ignore = "本机 Cowork 只读验证，仅输出统计"]
    fn 本机只读验证() {
        let root =
            std::env::var_os("ALLSESSIONS_CLAUDE_COWORK_TEST_ROOT").expect("需指定样本根目录");
        let source = Source {
            kind: "claude_cowork",
            display_name: "Claude Cowork",
            root: root.into(),
            format: SourceFormat::ClaudeCowork,
            archived: false,
        };
        let files = discover_files(&source);
        assert!(!files.is_empty());
        for path in files {
            let before = std::fs::metadata(&path).unwrap().modified().unwrap();
            let mut messages = 0;
            let detail = visit_detail(&path, &source, &mut |_| messages += 1).unwrap();
            assert_eq!(detail["summary"]["source_read_only"], true);
            assert_eq!(before, std::fs::metadata(path).unwrap().modified().unwrap());
            println!("Cowork 逻辑消息数：{messages}");
        }
    }
}
