use std::{
    collections::{BTreeSet, HashMap},
    fs::File,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
};

use serde_json::{json, Value};

use super::{
    append_limited, attach_message_key, compact_title, error_text, extract_text, message_value,
    summary_search_text, truncate_message, HeadTail, ParseState, Source, DETAIL_EVENT_LIMIT,
    DETAIL_MESSAGE_LIMIT, SEARCH_TEXT_LIMIT,
};

/// workspace.yaml 里的会话元数据。该文件是扁平的 key: value 清单
/// （id/cwd/git_root/repository/branch/name/summary/created_at/updated_at），
/// Copilot 不写嵌套结构，因此用最小解析器而不是引入 YAML 依赖。
#[derive(Default)]
struct WorkspaceMeta {
    id: String,
    cwd: String,
    git_root: String,
    repository: String,
    branch: String,
    name: String,
    summary: String,
    created_at: String,
    updated_at: String,
}

fn workspace_meta(events_path: &Path) -> WorkspaceMeta {
    let Some(text) = events_path
        .parent()
        .and_then(|dir| std::fs::read_to_string(dir.join("workspace.yaml")).ok())
    else {
        return WorkspaceMeta::default();
    };
    parse_workspace_yaml(&text)
}

fn parse_workspace_yaml(text: &str) -> WorkspaceMeta {
    let mut meta = WorkspaceMeta::default();
    let mut lines = text.lines().peekable();
    while let Some(line) = lines.next() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') || line.starts_with([' ', '\t']) {
            continue;
        }
        let Some((key, rest)) = line.split_once(':') else {
            continue;
        };
        let rest = rest.trim();
        let value = if matches!(rest, "|" | "|-" | "|+" | ">" | ">-" | ">+") {
            // 块标量：收集后续缩进行；`|` 保留换行，`>` 折叠为空格。
            let mut block = Vec::new();
            while let Some(next) = lines.peek() {
                let indented = next.starts_with([' ', '\t']);
                if !indented && !next.trim().is_empty() {
                    break;
                }
                block.push(next.trim());
                lines.next();
            }
            if rest.starts_with('>') {
                block.join(" ")
            } else {
                block.join("\n")
            }
        } else {
            unquote_yaml(rest)
        };
        match key.trim() {
            "id" => meta.id = value,
            "cwd" => meta.cwd = value,
            "git_root" => meta.git_root = value,
            "repository" => meta.repository = value,
            "branch" => meta.branch = value,
            "name" => meta.name = value,
            "summary" => meta.summary = value,
            "created_at" => meta.created_at = value,
            "updated_at" => meta.updated_at = value,
            _ => {}
        }
    }
    meta
}

fn unquote_yaml(value: &str) -> String {
    let value = value.trim();
    let bytes = value.as_bytes();
    if value.len() >= 2
        && ((bytes[0] == b'"' && bytes[value.len() - 1] == b'"')
            || (bytes[0] == b'\'' && bytes[value.len() - 1] == b'\''))
    {
        return value[1..value.len() - 1].to_string();
    }
    value.to_string()
}

pub(super) fn discover_files(source: &Source) -> Vec<PathBuf> {
    // 会话目录为 <root>/<session-id>/events.jsonl；也兼容把根直接
    // 配置成单个会话目录的情况。checkpoints/ 等会话内子目录不算。
    let mut paths = Vec::new();
    let direct = source.root.join("events.jsonl");
    if direct.is_file() {
        paths.push(direct);
    }
    if let Ok(entries) = std::fs::read_dir(&source.root) {
        for entry in entries.filter_map(Result::ok) {
            let candidate = entry.path().join("events.jsonl");
            if entry.path().is_dir() && candidate.is_file() {
                paths.push(candidate);
            }
        }
    }
    paths.sort();
    paths
}

pub(super) fn matches_path(root: &Path, path: &Path) -> bool {
    if path.file_name().and_then(|value| value.to_str()) != Some("events.jsonl") {
        return false;
    }
    let Some(parent) = path.parent() else {
        return false;
    };
    parent == root || parent.parent() == Some(root)
}

fn tool_call_message(name: &str, arguments: &Value, id: &str, timestamp: &str) -> Value {
    let arguments_text = match arguments {
        Value::String(text) => text.clone(),
        Value::Null => String::new(),
        other => serde_json::to_string(other).unwrap_or_default(),
    };
    let mut value = message_value(
        "tool",
        &format!("[{name}] {arguments_text}"),
        timestamp,
        "event",
        "tool_call",
        false,
    );
    value["tool_name"] = Value::String(name.to_string());
    value["tool_kind"] = Value::String("tool_call".into());
    if !id.is_empty() {
        value["tool_call_id"] = Value::String(id.to_string());
    }
    value
}

/// 把一条 events.jsonl 事件转成会话消息。
/// toolNames/seenCalls 用于把 tool.execution_start 与 assistant.message 的
/// toolRequests 去重（两者描述同一次调用），并把 toolCallId 映射回工具名，
/// 因为 tool.execution_complete 不携带工具名。
fn record_messages(
    record: &Value,
    tool_names: &mut HashMap<String, String>,
    seen_calls: &mut BTreeSet<String>,
) -> Vec<Value> {
    let timestamp = record["timestamp"].as_str().unwrap_or_default();
    let data = &record["data"];
    match record["type"].as_str().unwrap_or_default() {
        "user.message" => {
            let text = data["content"].as_str().unwrap_or_default();
            (!text.trim().is_empty())
                .then(|| message_value("user", text, timestamp, "event", "user.message", false))
                .into_iter()
                .collect()
        }
        "assistant.message" => {
            let mut messages = Vec::new();
            if let Some(text) = data["content"]
                .as_str()
                .filter(|value| !value.trim().is_empty())
            {
                messages.push(message_value(
                    "assistant",
                    text,
                    timestamp,
                    "event",
                    "assistant.message",
                    false,
                ));
            }
            if let Some(reasoning) = data["reasoningText"]
                .as_str()
                .filter(|value| !value.trim().is_empty())
            {
                messages.push(message_value(
                    "assistant",
                    reasoning,
                    timestamp,
                    "event",
                    "thinking",
                    true,
                ));
            }
            for request in data["toolRequests"].as_array().into_iter().flatten() {
                let id = request["toolCallId"].as_str().unwrap_or_default();
                let name = request["name"].as_str().unwrap_or("unknown_tool");
                if !id.is_empty() {
                    tool_names.insert(id.to_string(), name.to_string());
                    if !seen_calls.insert(id.to_string()) {
                        continue;
                    }
                }
                messages.push(tool_call_message(
                    name,
                    &request["arguments"],
                    id,
                    timestamp,
                ));
            }
            messages
        }
        "tool.execution_start" => {
            let id = data["toolCallId"].as_str().unwrap_or_default();
            let name = data["toolName"].as_str().unwrap_or("unknown_tool");
            if !id.is_empty() {
                tool_names.insert(id.to_string(), name.to_string());
                if !seen_calls.insert(id.to_string()) {
                    return Vec::new();
                }
            }
            vec![tool_call_message(name, &data["arguments"], id, timestamp)]
        }
        "tool.execution_complete" => {
            let id = data["toolCallId"].as_str().unwrap_or_default();
            let name = tool_names
                .get(id)
                .cloned()
                .or_else(|| data["toolName"].as_str().map(str::to_string))
                .unwrap_or_else(|| "tool_result".to_string());
            let text = extract_text(&data["result"])
                .or_else(|| extract_text(&data["error"]))
                .unwrap_or_else(|| match &data["result"] {
                    Value::Null => String::new(),
                    other => serde_json::to_string(other).unwrap_or_default(),
                });
            let mut value = message_value("tool", &text, timestamp, "event", "tool_result", false);
            value["tool_name"] = Value::String(name);
            value["tool_kind"] = Value::String("tool_result".into());
            if !id.is_empty() {
                value["tool_call_id"] = Value::String(id.to_string());
            }
            if data["success"].as_bool() == Some(false) {
                value["is_error"] = Value::Bool(true);
            }
            vec![value]
        }
        "session.task_complete" => {
            let text = data["summary"].as_str().unwrap_or_default();
            (!text.trim().is_empty())
                .then(|| {
                    message_value("assistant", text, timestamp, "event", "task_complete", true)
                })
                .into_iter()
                .collect()
        }
        _ => Vec::new(),
    }
}

fn build_state(path: &Path, meta: &WorkspaceMeta) -> Result<ParseState, String> {
    let mut state = ParseState::new(path);
    // 事件文件固定叫 events.jsonl，会话 id 依次取：session.start 的
    // sessionId → workspace.yaml 的 id → 所在目录名。
    if let Some(dir_id) = path
        .parent()
        .and_then(|parent| parent.file_name())
        .and_then(|value| value.to_str())
    {
        state.id = dir_id.to_string();
    }
    if !meta.id.is_empty() {
        state.id = meta.id.clone();
    }
    state.cwd = if meta.cwd.is_empty() {
        meta.git_root.clone()
    } else {
        meta.cwd.clone()
    };
    state.timestamp = meta.created_at.clone();
    state.last_timestamp = meta.updated_at.clone();
    let mut tool_names = HashMap::new();
    let mut seen_calls = BTreeSet::new();
    for line in BufReader::new(File::open(path).map_err(error_text)?).lines() {
        let line = line.map_err(error_text)?;
        if line.trim().is_empty() {
            continue;
        }
        let Ok(record) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        state.event_count += 1;
        if let Some(stamp) = record["timestamp"].as_str() {
            if state.timestamp.is_empty() {
                state.timestamp = stamp.to_string();
            }
            // workspace.yaml 的 updated_at 可能晚于最后一条事件，取较大者。
            if state.last_timestamp.is_empty() || stamp > state.last_timestamp.as_str() {
                state.last_timestamp = stamp.to_string();
            }
        }
        if record["type"].as_str() == Some("session.start") {
            let data = &record["data"];
            if let Some(id) = data["sessionId"].as_str().filter(|value| !value.is_empty()) {
                state.id = id.to_string();
            }
            if state.cwd.is_empty() {
                for key in ["cwd", "gitRoot", "git_root"] {
                    if let Some(value) = data["context"][key]
                        .as_str()
                        .or_else(|| data[key].as_str())
                        .filter(|value| !value.is_empty())
                    {
                        state.cwd = value.to_string();
                        break;
                    }
                }
            }
        }
        for message in record_messages(&record, &mut tool_names, &mut seen_calls) {
            state.accept_message(message);
        }
    }
    Ok(state)
}

fn apply_workspace_meta(summary: &mut Value, meta: &WorkspaceMeta) {
    // 标题优先用用户命名，其次 Copilot 生成的摘要，最后回退到首条用户消息。
    if let Some(title) = [&meta.name, &meta.summary]
        .into_iter()
        .find(|value| !value.trim().is_empty())
    {
        summary["title"] = Value::String(compact_title(title, 90));
    }
    summary["source_read_only"] = Value::Bool(true);
}

pub(super) fn parse_summary(path: &Path, source: &Source) -> Result<(Value, String), String> {
    let meta = workspace_meta(path);
    let state = build_state(path, &meta)?;
    let mut summary = state.summary(path, source);
    apply_workspace_meta(&mut summary, &meta);
    let mut search = summary_search_text(&summary);
    append_limited(
        &mut search,
        &[&meta.repository, &meta.branch],
        SEARCH_TEXT_LIMIT,
    );
    append_limited(&mut search, &[&state.search_text], SEARCH_TEXT_LIMIT);
    Ok((summary, search))
}

pub(super) fn parse_detail(path: &Path, source: &Source) -> Result<Value, String> {
    visit_detail(path, source, &mut |_| {})
}

pub(super) fn visit_detail(
    path: &Path,
    source: &Source,
    visitor: &mut dyn FnMut(&Value),
) -> Result<Value, String> {
    let meta = workspace_meta(path);
    let state = build_state(path, &meta)?;
    let mut messages = HeadTail::new(DETAIL_MESSAGE_LIMIT);
    let mut events = HeadTail::new(DETAIL_EVENT_LIMIT);
    let mut tool_names = HashMap::new();
    let mut seen_calls = BTreeSet::new();

    for (index, line) in BufReader::new(File::open(path).map_err(error_text)?)
        .lines()
        .enumerate()
    {
        let line = line.map_err(error_text)?;
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<Value>(&line) {
            Ok(record) => {
                for (message_index, mut message) in
                    record_messages(&record, &mut tool_names, &mut seen_calls)
                        .into_iter()
                        .enumerate()
                {
                    attach_message_key(
                        &mut message,
                        json!({
                            "kind": "copilot_event",
                            "event_type": record["type"],
                            "message_id": record["data"]["messageId"],
                            "line_number": index + 1,
                            "message_index": message_index,
                        }),
                    );
                    visitor(&message);
                    truncate_message(&mut message);
                    messages.push(message);
                }
                let payload = if line.chars().count() > 10_000 {
                    json!({ "truncated": true, "original_chars": line.chars().count() })
                } else {
                    record
                        .get("data")
                        .cloned()
                        .unwrap_or_else(|| record.clone())
                };
                events.push(json!({
                    "line_number": index + 1,
                    "timestamp": record.get("timestamp").cloned().unwrap_or(Value::Null),
                    "type": record["type"].as_str().unwrap_or("unknown"),
                    "payload": payload,
                }));
            }
            Err(error) => events.push(json!({
                "line_number": index + 1,
                "timestamp": Value::Null,
                "type": "parse_error",
                "payload": { "message": error.to_string() },
            })),
        }
    }

    let (mut message_values, omitted_messages, total_messages) = messages.finish(json!({
        "role": "system",
        "text": "",
        "timestamp": Value::Null,
        "source_type": "viewer",
        "source_subtype": "truncation",
        "is_truncation_marker": true,
    }));
    if omitted_messages > 0 {
        if let Some(marker) = message_values
            .iter_mut()
            .find(|value| value["is_truncation_marker"] == true)
        {
            marker["omitted_count"] = json!(omitted_messages);
        }
    }
    let (mut event_values, omitted_events, total_events) = events.finish(json!({
        "line_number": Value::Null,
        "timestamp": Value::Null,
        "type": "viewer_truncation",
        "payload": { "omitted_events": 0 },
    }));
    if omitted_events > 0 {
        if let Some(marker) = event_values
            .iter_mut()
            .find(|value| value["type"] == "viewer_truncation")
        {
            marker["payload"]["omitted_events"] = json!(omitted_events);
        }
    }
    let mut summary = state.summary(path, source);
    apply_workspace_meta(&mut summary, &meta);
    if omitted_messages + omitted_events > 0 {
        summary["detail_truncated"] = Value::Bool(true);
    }
    Ok(json!({
        "summary": summary,
        "conversation_messages": message_values,
        "raw_events": event_values,
        "truncation": {
            "truncated": omitted_messages + omitted_events > 0,
            "messages": { "total": total_messages, "omitted": omitted_messages },
            "raw_events": { "total": total_events, "omitted": omitted_events },
        },
    }))
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use tempfile::tempdir;

    use super::{discover_files, matches_path, parse_detail, parse_summary};
    use crate::sessions::{Source, SourceFormat};

    fn source(root: &Path) -> Source {
        Source {
            kind: "copilot",
            display_name: "GitHub Copilot",
            root: root.into(),
            format: SourceFormat::Copilot,
            archived: false,
        }
    }

    fn write_session(root: &Path, id: &str, events: &str, workspace: &str) -> PathBuf {
        let dir = root.join(id);
        std::fs::create_dir_all(&dir).unwrap();
        if !workspace.is_empty() {
            std::fs::write(dir.join("workspace.yaml"), workspace).unwrap();
        }
        let path = dir.join("events.jsonl");
        std::fs::write(&path, events).unwrap();
        path
    }

    #[test]
    fn 解析事件流并合并工作区元数据() {
        let directory = tempdir().unwrap();
        let path = write_session(
            directory.path(),
            "459987cf-cdb8-4ba0-9065-f470cbe762ce",
            concat!(
                "{\"type\":\"session.start\",\"timestamp\":\"2026-04-25T15:42:52.327Z\",\"data\":{\"sessionId\":\"459987cf-cdb8-4ba0-9065-f470cbe762ce\",\"context\":{\"cwd\":\"/work/ax\",\"repository\":\"acroos/ax\",\"branch\":\"main\"}}}\n",
                "{\"type\":\"user.message\",\"timestamp\":\"2026-04-25T15:43:00Z\",\"data\":{\"content\":\"修复登录缺陷\"}}\n",
                "{\"type\":\"assistant.message\",\"timestamp\":\"2026-04-25T15:43:05Z\",\"data\":{\"messageId\":\"m1\",\"content\":\"先看一下代码\",\"reasoningText\":\"需要定位入口\",\"toolRequests\":[{\"toolCallId\":\"call-1\",\"name\":\"bash\",\"arguments\":{\"command\":\"ls\"}}]}}\n",
                "{\"type\":\"tool.execution_start\",\"timestamp\":\"2026-04-25T15:43:06Z\",\"data\":{\"toolCallId\":\"call-1\",\"toolName\":\"bash\",\"arguments\":{\"command\":\"ls\"}}}\n",
                "{\"type\":\"tool.execution_complete\",\"timestamp\":\"2026-04-25T15:43:07Z\",\"data\":{\"toolCallId\":\"call-1\",\"success\":true,\"result\":{\"content\":\"src\\nREADME.md\"}}}\n",
                "{\"type\":\"session.task_complete\",\"timestamp\":\"2026-04-25T15:44:00Z\",\"data\":{\"summary\":\"已修复登录缺陷\"}}\n",
                "{\"type\":\"session.shutdown\",\"timestamp\":\"2026-04-25T15:44:01Z\",\"data\":{\"codeChanges\":{\"filesModified\":[\"a.rs\"]}}}\n"
            ),
            "id: 459987cf-cdb8-4ba0-9065-f470cbe762ce\ncwd: /work/ax\nrepository: acroos/ax\nbranch: main\nsummary: |\n  修复登录缺陷并补充测试\n",
        );

        let (summary, search) = parse_summary(&path, &source(directory.path())).unwrap();
        assert_eq!(summary["id"], "459987cf-cdb8-4ba0-9065-f470cbe762ce");
        assert_eq!(
            summary["_key"],
            "copilot:459987cf-cdb8-4ba0-9065-f470cbe762ce"
        );
        assert_eq!(summary["cwd"], "/work/ax");
        assert_eq!(summary["title"], "修复登录缺陷并补充测试");
        assert_eq!(summary["source_kind"], "copilot");
        assert_eq!(summary["source_read_only"], true);
        assert_eq!(summary["model_provider"], "github");
        assert_eq!(summary["originator"], "copilot_cli");
        // user + assistant 文本 + 工具调用 + 工具结果 = 4 条消息；
        // thinking 与 task_complete 计入上下文。
        assert_eq!(summary["message_count"], 4);
        assert_eq!(summary["context_count"], 2);
        assert_eq!(summary["tool_count"], 2);
        assert_eq!(summary["timestamp"], "2026-04-25T15:42:52.327Z");
        assert_eq!(summary["last_timestamp"], "2026-04-25T15:44:01Z");
        assert!(search.contains("修复登录缺陷"));
        assert!(search.contains("acroos/ax"));

        let detail = parse_detail(&path, &source(directory.path())).unwrap();
        let messages = detail["conversation_messages"].as_array().unwrap();
        assert_eq!(messages.len(), 6);
        // toolRequests 与 tool.execution_start 描述同一次调用，只保留一条。
        let tool_calls: Vec<_> = messages
            .iter()
            .filter(|message| message["tool_kind"] == "tool_call")
            .collect();
        assert_eq!(tool_calls.len(), 1);
        assert_eq!(tool_calls[0]["tool_name"], "bash");
        let result = messages
            .iter()
            .find(|message| message["tool_kind"] == "tool_result")
            .unwrap();
        assert_eq!(result["tool_name"], "bash");
        assert_eq!(result["tool_call_id"], "call-1");
        assert!(messages
            .iter()
            .all(|message| message["_message_key"].is_string()));
        assert!(messages
            .iter()
            .all(|message| message["_delete_ref"].is_null()));
        assert_eq!(detail["raw_events"].as_array().unwrap().len(), 7);
    }

    #[test]
    fn 缺少工作区文件时回退到目录名与首条消息() {
        let directory = tempdir().unwrap();
        let path = write_session(
            directory.path(),
            "dir-only-id",
            "{\"type\":\"user.message\",\"timestamp\":\"2026-04-25T15:43:00Z\",\"data\":{\"content\":\"没有元数据的会话\"}}\n",
            "",
        );
        let (summary, _) = parse_summary(&path, &source(directory.path())).unwrap();
        assert_eq!(summary["id"], "dir-only-id");
        assert_eq!(summary["title"], "没有元数据的会话");
        assert_eq!(summary["message_count"], 1);
    }

    #[test]
    fn 执行开始事件可独立产生工具调用() {
        let directory = tempdir().unwrap();
        let path = write_session(
            directory.path(),
            "tool-only",
            concat!(
                "{\"type\":\"tool.execution_start\",\"timestamp\":\"2026-04-25T15:43:06Z\",\"data\":{\"toolCallId\":\"call-9\",\"toolName\":\"edit\",\"arguments\":{\"path\":\"a.rs\",\"old_str\":\"x\",\"new_str\":\"y\"}}}\n",
                "{\"type\":\"tool.execution_complete\",\"timestamp\":\"2026-04-25T15:43:07Z\",\"data\":{\"toolCallId\":\"call-9\",\"success\":false,\"error\":{\"message\":\"冲突\"}}}\n"
            ),
            "",
        );
        let detail = parse_detail(&path, &source(directory.path())).unwrap();
        let messages = detail["conversation_messages"].as_array().unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["tool_kind"], "tool_call");
        assert_eq!(messages[0]["tool_name"], "edit");
        assert_eq!(messages[1]["tool_kind"], "tool_result");
        assert_eq!(messages[1]["tool_name"], "edit");
        assert_eq!(messages[1]["is_error"], true);
    }

    #[test]
    fn 损坏行不会阻断其他事件() {
        let directory = tempdir().unwrap();
        let path = write_session(
            directory.path(),
            "broken",
            "{broken\n{\"type\":\"user.message\",\"timestamp\":\"2026-04-25T15:43:00Z\",\"data\":{\"content\":\"仍可读取\"}}\n",
            "",
        );
        let (summary, _) = parse_summary(&path, &source(directory.path())).unwrap();
        assert_eq!(summary["message_count"], 1);
        let detail = parse_detail(&path, &source(directory.path())).unwrap();
        assert!(detail["raw_events"]
            .as_array()
            .unwrap()
            .iter()
            .any(|event| event["type"] == "parse_error"));
    }

    #[test]
    fn 只发现会话目录下的事件文件() {
        let directory = tempdir().unwrap();
        let root = directory.path();
        let events = write_session(root, "s1", "", "");
        std::fs::write(root.join("s1").join("workspace.yaml"), "id: s1\n").unwrap();
        std::fs::write(root.join("events.jsonl"), "{}\n").unwrap();
        std::fs::create_dir_all(root.join("s1").join("checkpoints")).unwrap();
        std::fs::write(
            root.join("s1").join("checkpoints").join("events.jsonl"),
            "{}\n",
        )
        .unwrap();

        let discovered = discover_files(&source(root));
        assert!(discovered.contains(&events));
        // 根目录散落的 events.jsonl 视为单会话目录；checkpoints 下的同名文件忽略。
        assert!(discovered.contains(&root.join("events.jsonl")));
        assert!(!discovered.contains(&root.join("s1").join("checkpoints").join("events.jsonl")));
        assert!(matches_path(root, &events));
        assert!(!matches_path(root, &root.join("s1").join("workspace.yaml")));
        assert!(!matches_path(
            root,
            &root.join("s1").join("checkpoints").join("events.jsonl")
        ));
    }
}
