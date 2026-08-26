use std::{
    collections::{BTreeSet, HashMap},
    fs::File,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
};

use serde_json::{json, Value};

use super::{
    append_limited, attach_message_key, compact, error_text, extract_text, message_value,
    summary_search_text, truncate_message, HeadTail, ParseState, Source, DETAIL_EVENT_LIMIT,
    DETAIL_MESSAGE_LIMIT, SEARCH_TEXT_LIMIT,
};

#[derive(Default)]
struct SessionMetadata {
    id: String,
    cwd: String,
    timestamp: String,
    parent_session_id: String,
    tree: bool,
    active_ids: BTreeSet<String>,
    event_count: usize,
}

fn read_session_id(path: &Path, parent: &str) -> Option<String> {
    let parent = PathBuf::from(parent);
    let parent = if parent.is_absolute() {
        parent
    } else {
        path.parent()?.join(parent)
    };
    for line in BufReader::new(File::open(parent).ok()?).lines() {
        let Ok(line) = line else {
            continue;
        };
        let Ok(record) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if record["type"].as_str() == Some("session") {
            return record["id"].as_str().map(str::to_string);
        }
    }
    None
}

fn metadata(path: &Path) -> Result<SessionMetadata, String> {
    let mut result = SessionMetadata::default();
    let mut parents = HashMap::<String, Option<String>>::new();
    let mut leaf = None;
    for line in BufReader::new(File::open(path).map_err(error_text)?).lines() {
        let line = line.map_err(error_text)?;
        if line.trim().is_empty() {
            continue;
        }
        let Ok(record) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        result.event_count += 1;
        if record["type"].as_str() == Some("session") {
            result.id = record["id"].as_str().unwrap_or_default().to_string();
            result.cwd = record["cwd"].as_str().unwrap_or_default().to_string();
            result.timestamp = record["timestamp"].as_str().unwrap_or_default().to_string();
            result.tree = record["version"].as_u64().unwrap_or(1) >= 2;
            result.parent_session_id = record["parentSession"]
                .as_str()
                .and_then(|value| read_session_id(path, value))
                .unwrap_or_default()
                .to_string();
            continue;
        }
        if record.get("parentId").is_some() {
            result.tree = true;
        }
        let Some(id) = record["id"].as_str() else {
            continue;
        };
        let parent = record["parentId"].as_str().map(str::to_string);
        parents.insert(id.to_string(), parent);
        leaf = Some(id.to_string());
    }
    let mut current = leaf;
    while let Some(id) = current {
        if !result.active_ids.insert(id.clone()) {
            break;
        }
        current = parents.get(&id).cloned().flatten();
    }
    Ok(result)
}

fn content_text(value: &Value) -> String {
    extract_text(value).unwrap_or_else(|| match value {
        Value::Object(_) | Value::Array(_) => serde_json::to_string(value).unwrap_or_default(),
        _ => String::new(),
    })
}

fn assistant_messages(message: &Value, timestamp: &str) -> Vec<Value> {
    let blocks = message["content"]
        .as_array()
        .cloned()
        .unwrap_or_else(|| vec![message["content"].clone()]);
    let mut messages = Vec::new();
    for block in blocks {
        if let Some(text) = block.as_str().filter(|value| !value.trim().is_empty()) {
            messages.push(message_value(
                "assistant",
                text,
                timestamp,
                "message",
                "text",
                false,
            ));
            continue;
        }
        let kind = block["type"].as_str().unwrap_or("unknown");
        match kind {
            "toolCall" | "tool_call" | "tool_use" => {
                let name = block["name"]
                    .as_str()
                    .or_else(|| block["function"]["name"].as_str())
                    .unwrap_or("unknown_tool");
                let arguments = block
                    .get("arguments")
                    .or_else(|| block["function"].get("arguments"))
                    .cloned()
                    .unwrap_or(Value::Null);
                let arguments = if let Some(value) = arguments.as_str() {
                    value.to_string()
                } else {
                    serde_json::to_string(&arguments).unwrap_or_default()
                };
                let mut value = message_value(
                    "tool",
                    &format!("[{name}] {arguments}"),
                    timestamp,
                    "message",
                    kind,
                    false,
                );
                value["tool_name"] = Value::String(name.to_string());
                value["tool_kind"] = Value::String("tool_call".into());
                if let Some(id) = block["id"].as_str() {
                    value["tool_call_id"] = Value::String(id.to_string());
                }
                messages.push(value);
            }
            "thinking" => {
                let text = block["thinking"]
                    .as_str()
                    .or_else(|| block["text"].as_str())
                    .unwrap_or_default();
                if !text.trim().is_empty() {
                    messages.push(message_value(
                        "assistant",
                        text,
                        timestamp,
                        "message",
                        "thinking",
                        true,
                    ));
                }
            }
            "image" => messages.push(message_value(
                "assistant",
                "[image]",
                timestamp,
                "message",
                "image",
                false,
            )),
            _ => {
                let text = content_text(&block);
                if !text.trim().is_empty() {
                    messages.push(message_value(
                        "assistant",
                        &text,
                        timestamp,
                        "message",
                        kind,
                        false,
                    ));
                }
            }
        }
    }
    messages
}

fn record_messages(record: &Value) -> Vec<Value> {
    let timestamp = record["timestamp"].as_str().unwrap_or_default();
    match record["type"].as_str().unwrap_or_default() {
        "message" => {
            let message = &record["message"];
            match message["role"].as_str().unwrap_or_default() {
                "assistant" => assistant_messages(message, timestamp),
                "user" => {
                    let text = content_text(&message["content"]);
                    (!text.trim().is_empty())
                        .then(|| message_value("user", &text, timestamp, "message", "text", false))
                        .into_iter()
                        .collect()
                }
                "toolResult" | "tool_result" => {
                    let text = content_text(&message["content"]);
                    let name = message["toolName"]
                        .as_str()
                        .or_else(|| message["tool_name"].as_str())
                        .unwrap_or("tool_result");
                    let mut value =
                        message_value("tool", &text, timestamp, "message", "tool_result", false);
                    value["tool_name"] = Value::String(name.to_string());
                    value["tool_kind"] = Value::String("tool_result".into());
                    if let Some(id) = message["toolCallId"]
                        .as_str()
                        .or_else(|| message["tool_call_id"].as_str())
                    {
                        value["tool_call_id"] = Value::String(id.to_string());
                    }
                    if message["isError"].as_bool() == Some(true) {
                        value["is_error"] = Value::Bool(true);
                    }
                    vec![value]
                }
                "bashExecution" | "bash_execution" => {
                    let command = message["command"].as_str().unwrap_or_default();
                    let output = message["output"].as_str().unwrap_or_default();
                    let text = format!("$ {command}\n{output}");
                    let mut value = message_value(
                        "tool",
                        text.trim(),
                        timestamp,
                        "message",
                        "bash_execution",
                        false,
                    );
                    value["tool_name"] = Value::String("bash".into());
                    value["tool_kind"] = Value::String("tool_result".into());
                    vec![value]
                }
                "branchSummary" | "branch_summary" | "compactionSummary" | "compaction_summary" => {
                    let text = message["summary"].as_str().unwrap_or_default();
                    (!text.trim().is_empty())
                        .then(|| {
                            message_value("assistant", text, timestamp, "message", "summary", true)
                        })
                        .into_iter()
                        .collect()
                }
                "custom" => {
                    let text = content_text(&message["content"]);
                    (!text.trim().is_empty())
                        .then(|| {
                            message_value(
                                "system",
                                &text,
                                timestamp,
                                "message",
                                message["customType"].as_str().unwrap_or("custom"),
                                true,
                            )
                        })
                        .into_iter()
                        .collect()
                }
                _ => Vec::new(),
            }
        }
        "compaction" | "branch_summary" => {
            let text = record["summary"].as_str().unwrap_or_default();
            (!text.trim().is_empty())
                .then(|| {
                    message_value(
                        "assistant",
                        text,
                        timestamp,
                        record["type"].as_str().unwrap_or("summary"),
                        "summary",
                        true,
                    )
                })
                .into_iter()
                .collect()
        }
        "custom_message" => {
            let text = content_text(&record["content"]);
            (!text.trim().is_empty())
                .then(|| {
                    message_value(
                        "system",
                        &text,
                        timestamp,
                        "custom_message",
                        record["customType"].as_str().unwrap_or("custom"),
                        true,
                    )
                })
                .into_iter()
                .collect()
        }
        _ => Vec::new(),
    }
}

fn build_state(
    path: &Path,
    metadata: &SessionMetadata,
) -> Result<(ParseState, Option<String>), String> {
    let mut state = ParseState::new(path);
    if !metadata.id.is_empty() {
        state.id = metadata.id.clone();
    }
    state.cwd = metadata.cwd.clone();
    state.timestamp = metadata.timestamp.clone();
    state.last_timestamp = metadata.timestamp.clone();
    state.parent_session_id = metadata.parent_session_id.clone();
    state.event_count = metadata.event_count;
    let mut title = None;

    for line in BufReader::new(File::open(path).map_err(error_text)?).lines() {
        let line = line.map_err(error_text)?;
        let Ok(record) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let active = !metadata.tree
            || record["id"]
                .as_str()
                .is_some_and(|id| metadata.active_ids.contains(id));
        if !active {
            continue;
        }
        if let Some(timestamp) = record["timestamp"].as_str() {
            if state.timestamp.is_empty() {
                state.timestamp = timestamp.to_string();
            }
            state.last_timestamp = timestamp.to_string();
        }
        if record["type"].as_str() == Some("session_info") {
            title = record["name"].as_str().map(str::to_string);
        }
        if record["type"].as_str() == Some("message")
            && record["message"]["role"].as_str() == Some("assistant")
        {
            if let Some(provider) = record["message"]["provider"].as_str() {
                state.provider = provider.to_string();
            }
        }
        for message in record_messages(&record) {
            state.accept_message(message);
        }
    }
    Ok((state, title))
}

pub(super) fn parse_summary(path: &Path, source: &Source) -> Result<(Value, String), String> {
    let metadata = metadata(path)?;
    let (state, title) = build_state(path, &metadata)?;
    let mut summary = state.summary(path, source);
    if let Some(title) = title.filter(|value| !value.trim().is_empty()) {
        summary["title"] = Value::String(compact(&title, 90));
    }
    summary["source_read_only"] = Value::Bool(true);
    let mut search = summary_search_text(&summary);
    append_limited(&mut search, &[&state.search_text], SEARCH_TEXT_LIMIT);
    Ok((summary, search))
}

pub(super) fn parse_detail(path: &Path, source: &Source) -> Result<Value, String> {
    let metadata = metadata(path)?;
    let (state, title) = build_state(path, &metadata)?;
    let mut messages = HeadTail::new(DETAIL_MESSAGE_LIMIT);
    let mut events = HeadTail::new(DETAIL_EVENT_LIMIT);

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
                let active = !metadata.tree
                    || record["type"].as_str() == Some("session")
                    || record["id"]
                        .as_str()
                        .is_some_and(|id| metadata.active_ids.contains(id));
                if active {
                    for (message_index, mut message) in
                        record_messages(&record).into_iter().enumerate()
                    {
                        attach_message_key(
                            &mut message,
                            json!({
                                "kind": "pi_entry",
                                "entry_id": record["id"],
                                "legacy_entry_sequence": record["id"].as_str().is_none().then_some(index + 1),
                                "message_index": message_index,
                            }),
                        );
                        truncate_message(&mut message);
                        messages.push(message);
                    }
                }
                events.push(json!({
                    "line_number": index + 1,
                    "timestamp": record.get("timestamp").cloned().unwrap_or(Value::Null),
                    "type": record["type"].as_str().unwrap_or("unknown"),
                    "payload": record,
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
    if let Some(title) = title.filter(|value| !value.trim().is_empty()) {
        summary["title"] = Value::String(compact(&title, 90));
    }
    summary["source_read_only"] = Value::Bool(true);
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
    use std::path::Path;

    use tempfile::tempdir;

    use super::{parse_detail, parse_summary};
    use crate::sessions::{Source, SourceFormat};

    fn source(root: &Path) -> Source {
        Source {
            kind: "pi",
            display_name: "Pi",
            root: root.into(),
            format: SourceFormat::Pi,
            archived: false,
        }
    }

    #[test]
    fn 只展示当前活动分支并保留工具调用() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("session.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"type\":\"session\",\"version\":3,\"id\":\"pi-1\",\"timestamp\":\"2026-08-20T00:00:00Z\",\"cwd\":\"/work/repo\"}\n",
                "{\"type\":\"message\",\"id\":\"u1\",\"parentId\":null,\"timestamp\":\"2026-08-20T00:00:01Z\",\"message\":{\"role\":\"user\",\"content\":\"当前问题\"}}\n",
                "{\"type\":\"message\",\"id\":\"old\",\"parentId\":\"u1\",\"timestamp\":\"2026-08-20T00:00:02Z\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"废弃分支\"}],\"provider\":\"anthropic\"}}\n",
                "{\"type\":\"message\",\"id\":\"new\",\"parentId\":\"u1\",\"timestamp\":\"2026-08-20T00:00:03Z\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"toolCall\",\"id\":\"call-1\",\"name\":\"bash\",\"arguments\":{\"command\":\"pwd\"}},{\"type\":\"text\",\"text\":\"当前回答\"}],\"provider\":\"openai\"}}\n",
                "{\"type\":\"message\",\"id\":\"custom\",\"parentId\":\"new\",\"timestamp\":\"2026-08-20T00:00:03Z\",\"message\":{\"role\":\"custom\",\"customType\":\"extension-note\",\"content\":\"扩展上下文\",\"display\":true}}\n",
                "{\"type\":\"session_info\",\"id\":\"name\",\"parentId\":\"custom\",\"timestamp\":\"2026-08-20T00:00:04Z\",\"name\":\"命名会话\"}\n"
            ),
        )
        .unwrap();

        let (summary, search) = parse_summary(&path, &source(directory.path())).unwrap();
        assert_eq!(summary["id"], "pi-1");
        assert_eq!(summary["title"], "命名会话");
        assert_eq!(summary["cwd"], "/work/repo");
        assert_eq!(summary["message_count"], 3);
        assert_eq!(summary["context_count"], 1);
        assert_eq!(summary["tool_count"], 1);
        assert!(search.contains("当前回答"));
        assert!(!search.contains("废弃分支"));

        let detail = parse_detail(&path, &source(directory.path())).unwrap();
        let messages = detail["conversation_messages"].as_array().unwrap();
        assert_eq!(messages.len(), 4);
        assert!(messages
            .iter()
            .all(|message| message["_delete_ref"].is_null()));
        assert!(messages
            .iter()
            .all(|message| message["_message_key"].is_string()));
    }

    #[test]
    fn 损坏行不会阻断其他记录() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("session.jsonl");
        std::fs::write(
            &path,
            "{\"type\":\"session\",\"id\":\"pi-2\",\"cwd\":\"/repo\"}\n{broken\n{\"type\":\"message\",\"id\":\"u1\",\"parentId\":null,\"timestamp\":\"2026-08-20T00:00:01Z\",\"message\":{\"role\":\"user\",\"content\":\"仍可读取\"}}\n",
        )
        .unwrap();
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
    fn 第一版线性记录无需父链也能读取() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("session-v1.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"type\":\"session\",\"version\":1,\"id\":\"pi-v1\",\"timestamp\":\"2026-08-20T00:00:00Z\",\"cwd\":\"/work/legacy\"}\n",
                "{\"type\":\"message\",\"timestamp\":\"2026-08-20T00:00:01Z\",\"message\":{\"role\":\"user\",\"content\":\"旧版问题\"}}\n",
                "{\"type\":\"message\",\"timestamp\":\"2026-08-20T00:00:02Z\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"旧版回答\"}]}}\n"
            ),
        )
        .unwrap();

        let (summary, search) = parse_summary(&path, &source(directory.path())).unwrap();
        assert_eq!(summary["message_count"], 2);
        assert!(search.contains("旧版问题"));
        assert!(search.contains("旧版回答"));

        let detail = parse_detail(&path, &source(directory.path())).unwrap();
        let messages = detail["conversation_messages"].as_array().unwrap();
        assert_eq!(messages.len(), 2);
        assert_ne!(messages[0]["_message_key"], messages[1]["_message_key"]);
    }

    #[test]
    fn 父会话标识读取自父文件头() {
        let directory = tempdir().unwrap();
        let parent = directory
            .path()
            .join("2026-08-20T00-00-00-000Z_parent-file-name.jsonl");
        std::fs::write(
            &parent,
            "{\"type\":\"session\",\"version\":3,\"id\":\"parent-session-id\",\"timestamp\":\"2026-08-20T00:00:00Z\",\"cwd\":\"/work/repo\"}\n",
        )
        .unwrap();
        let child = directory.path().join("child.jsonl");
        std::fs::write(
            &child,
            format!(
                "{{\"type\":\"session\",\"version\":3,\"id\":\"child-session-id\",\"timestamp\":\"2026-08-20T00:01:00Z\",\"cwd\":\"/work/repo\",\"parentSession\":{}}}\n",
                serde_json::to_string(&parent.to_string_lossy()).unwrap()
            ),
        )
        .unwrap();

        let (summary, _) = parse_summary(&child, &source(directory.path())).unwrap();
        assert_eq!(summary["parent_session_id"], "parent-session-id");
    }
}
