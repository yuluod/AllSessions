use std::{
    collections::HashMap,
    fs::File,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
};

use chrono::{SecondsFormat, TimeZone, Utc};
use serde_json::{json, Value};
use walkdir::WalkDir;

use super::{
    append_limited, attach_message_key, compact, error_text, extract_text, message_value,
    summary_search_text, truncate_message, HeadTail, ParseState, Source, DETAIL_EVENT_LIMIT,
    DETAIL_MESSAGE_LIMIT, SEARCH_TEXT_LIMIT,
};

struct SessionLayout {
    id: String,
    cwd: String,
    parent_session_id: String,
    hidden: bool,
}

fn sessions_root(source: &Source) -> PathBuf {
    if source.root.file_name().and_then(|value| value.to_str()) == Some("sessions") {
        source.root.clone()
    } else {
        source.root.join("sessions")
    }
}

fn share_root(source: &Source) -> PathBuf {
    if source.root.file_name().and_then(|value| value.to_str()) == Some("sessions") {
        source
            .root
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| source.root.clone())
    } else {
        source.root.clone()
    }
}

fn work_dir_for_hash(source: &Source, hash: &str) -> String {
    let path = share_root(source).join("kimi.json");
    let Ok(file) = File::open(path) else {
        return String::new();
    };
    let Ok(value) = serde_json::from_reader::<_, Value>(file) else {
        return String::new();
    };
    value["work_dirs"]
        .as_array()
        .into_iter()
        .flatten()
        .find_map(|item| {
            let path = item["path"].as_str()?;
            let kaos = item["kaos"].as_str().unwrap_or("local");
            let digest = format!("{:x}", md5::compute(path.as_bytes()));
            let directory = if kaos == "local" {
                digest
            } else {
                format!("{kaos}_{digest}")
            };
            (directory == hash).then(|| path.to_string())
        })
        .unwrap_or_default()
}

fn session_layout(path: &Path, source: &Source) -> SessionLayout {
    let relative = path
        .strip_prefix(sessions_root(source))
        .or_else(|_| path.strip_prefix(&source.root))
        .unwrap_or(path);
    let parts = relative
        .components()
        .filter_map(|component| component.as_os_str().to_str().map(str::to_string))
        .collect::<Vec<_>>();
    let hash = parts.first().cloned().unwrap_or_default();
    let main_id = parts
        .get(1)
        .cloned()
        .or_else(|| path.parent()?.file_name()?.to_str().map(str::to_string))
        .unwrap_or_else(|| "unknown".into());
    let subagent_index = parts.iter().position(|part| part == "subagents");
    let hidden = subagent_index.is_some();
    let id = subagent_index
        .and_then(|index| parts.get(index + 1))
        .map(|agent| format!("{main_id}:subagent:{agent}"))
        .unwrap_or_else(|| main_id.clone());
    SessionLayout {
        id,
        cwd: work_dir_for_hash(source, &hash),
        parent_session_id: if hidden { main_id } else { String::new() },
        hidden,
    }
}

fn custom_title(path: &Path) -> Option<String> {
    let state_path = path.parent()?.join("state.json");
    let value: Value = serde_json::from_reader(File::open(state_path).ok()?).ok()?;
    value["custom_title"]
        .as_str()
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
}

pub(super) fn discover_files(source: &Source) -> Vec<PathBuf> {
    let mut paths = WalkDir::new(sessions_root(source))
        .max_depth(16)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file() && entry.file_name() == "wire.jsonl")
        .map(|entry| entry.into_path())
        .collect::<Vec<_>>();
    paths.sort();
    paths
}

pub(super) fn matches_path(path: &Path) -> bool {
    path.file_name().and_then(|value| value.to_str()) == Some("wire.jsonl")
}

fn wire_timestamp(value: &Value) -> String {
    let Some(seconds) = value.as_f64() else {
        return value.as_str().unwrap_or_default().to_string();
    };
    let whole = seconds.floor() as i64;
    let nanos = ((seconds - whole as f64) * 1_000_000_000.0)
        .round()
        .clamp(0.0, 999_999_999.0) as u32;
    Utc.timestamp_opt(whole, nanos)
        .single()
        .map(|value| value.to_rfc3339_opts(SecondsFormat::Millis, true))
        .unwrap_or_default()
}

fn readable_json(value: &Value) -> String {
    extract_text(value).unwrap_or_else(|| {
        if value.is_null() {
            String::new()
        } else {
            serde_json::to_string(value).unwrap_or_default()
        }
    })
}

fn input_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .map(|part| {
                if part["type"].as_str() == Some("image_url") {
                    "[image]".into()
                } else {
                    readable_json(part)
                }
            })
            .filter(|text| !text.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => readable_json(value),
    }
}

fn envelope_messages(record: &Value) -> Vec<Value> {
    let timestamp = wire_timestamp(&record["timestamp"]);
    let envelope = &record["message"];
    let kind = envelope["type"].as_str().unwrap_or("unknown");
    let payload = &envelope["payload"];
    match kind {
        "TurnBegin" | "SteerInput" => {
            let text = input_text(&payload["user_input"]);
            (!text.trim().is_empty())
                .then(|| message_value("user", &text, &timestamp, kind, "text", false))
                .into_iter()
                .collect()
        }
        "ContentPart" => match payload["type"].as_str() {
            Some("text") => payload["text"]
                .as_str()
                .filter(|text| !text.is_empty())
                .map(|text| message_value("assistant", text, &timestamp, kind, "text", false))
                .into_iter()
                .collect(),
            Some("think") => payload["think"]
                .as_str()
                .filter(|text| !text.is_empty())
                .map(|text| message_value("assistant", text, &timestamp, kind, "thinking", true))
                .into_iter()
                .collect(),
            Some("image_url") => vec![message_value(
                "assistant",
                "[image]",
                &timestamp,
                kind,
                "image",
                false,
            )],
            Some("audio_url") => vec![message_value(
                "assistant",
                "[audio]",
                &timestamp,
                kind,
                "audio",
                false,
            )],
            Some("video_url") => vec![message_value(
                "assistant",
                "[video]",
                &timestamp,
                kind,
                "video",
                false,
            )],
            _ => Vec::new(),
        },
        "ToolCall" => {
            let name = payload["function"]["name"]
                .as_str()
                .or_else(|| payload["name"].as_str())
                .unwrap_or("unknown_tool");
            let arguments = payload["function"]["arguments"]
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| readable_json(&payload["arguments"]));
            let mut value = message_value(
                "tool",
                &format!("[{name}] {arguments}"),
                &timestamp,
                kind,
                "tool_call",
                false,
            );
            value["tool_name"] = Value::String(name.to_string());
            value["tool_kind"] = Value::String("tool_call".into());
            if let Some(id) = payload["id"].as_str() {
                value["tool_call_id"] = Value::String(id.to_string());
            }
            vec![value]
        }
        "ToolCallPart" => {
            let nested = payload
                .get("tool_call")
                .or_else(|| payload.get("toolCall"))
                .unwrap_or(payload);
            envelope_messages(&json!({
                "timestamp": record["timestamp"],
                "message": { "type": "ToolCall", "payload": nested },
            }))
        }
        "ToolResult" => {
            let return_value = &payload["return_value"];
            let output = readable_json(&return_value["output"]);
            let text = if output.trim().is_empty() {
                return_value["message"].as_str().unwrap_or_default()
            } else {
                &output
            };
            let mut value = message_value("tool", text, &timestamp, kind, "tool_result", false);
            value["tool_name"] = Value::String("tool_result".into());
            value["tool_kind"] = Value::String("tool_result".into());
            if let Some(id) = payload["tool_call_id"].as_str() {
                value["tool_call_id"] = Value::String(id.to_string());
            }
            if return_value["is_error"].as_bool() == Some(true) {
                value["is_error"] = Value::Bool(true);
            }
            vec![value]
        }
        "BtwEnd" => payload["response"]
            .as_str()
            .filter(|value| !value.trim().is_empty())
            .map(|text| message_value("assistant", text, &timestamp, kind, "text", false))
            .into_iter()
            .collect(),
        _ => Vec::new(),
    }
}

struct MessageCollector {
    state: ParseState,
    messages: Option<HeadTail<Value>>,
    pending: Option<(Value, usize)>,
    sequence: usize,
}

impl MessageCollector {
    fn new(path: &Path, layout: &SessionLayout, collect_messages: bool) -> Self {
        let mut state = ParseState::new(path);
        state.id = layout.id.clone();
        state.cwd = layout.cwd.clone();
        state.hidden = layout.hidden;
        state.hidden_reason = if layout.hidden {
            "subagent".into()
        } else {
            String::new()
        };
        state.parent_session_id = layout.parent_session_id.clone();
        Self {
            state,
            messages: collect_messages.then(|| HeadTail::new(DETAIL_MESSAGE_LIMIT)),
            pending: None,
            sequence: 0,
        }
    }

    fn push(&mut self, message: Value, line_number: usize) {
        let mergeable = message["role"].as_str() == Some("assistant")
            && matches!(
                message["source_subtype"].as_str(),
                Some("text" | "thinking")
            );
        if mergeable {
            if let Some((pending, _)) = self.pending.as_mut() {
                if pending["role"] == message["role"]
                    && pending["source_subtype"] == message["source_subtype"]
                {
                    let mut text = pending["text"].as_str().unwrap_or_default().to_string();
                    let incoming = message["text"].as_str().unwrap_or_default();
                    if text.chars().count() < SEARCH_TEXT_LIMIT {
                        text.extend(
                            incoming
                                .chars()
                                .take(SEARCH_TEXT_LIMIT - text.chars().count()),
                        );
                    }
                    pending["text"] = Value::String(text);
                    return;
                }
            }
        }
        self.flush();
        self.pending = Some((message, line_number));
        if !mergeable {
            self.flush();
        }
    }

    fn flush(&mut self) {
        let Some((message, line_number)) = self.pending.take() else {
            return;
        };
        self.state.accept_message(message.clone());
        if let Some(messages) = self.messages.as_mut() {
            let mut visible = message;
            attach_message_key(
                &mut visible,
                json!({
                    "kind": "kimi_wire_message",
                    "line_number": line_number,
                    "message_index": self.sequence,
                }),
            );
            truncate_message(&mut visible);
            messages.push(visible);
        }
        self.sequence += 1;
    }
}

type ParsedWire = (ParseState, Option<HeadTail<Value>>, Option<HeadTail<Value>>);

fn parse_wire(path: &Path, source: &Source, collect_detail: bool) -> Result<ParsedWire, String> {
    let layout = session_layout(path, source);
    let mut collector = MessageCollector::new(path, &layout, collect_detail);
    let mut events = collect_detail.then(|| HeadTail::new(DETAIL_EVENT_LIMIT));
    let mut tool_names = HashMap::<String, String>::new();

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
                if record["type"].as_str() == Some("metadata") {
                    if let Some(events) = events.as_mut() {
                        events.push(json!({
                            "line_number": index + 1,
                            "timestamp": Value::Null,
                            "type": "metadata",
                            "payload": record,
                        }));
                    }
                    continue;
                }
                collector.state.event_count += 1;
                let timestamp = wire_timestamp(&record["timestamp"]);
                if collector.state.timestamp.is_empty() && !timestamp.is_empty() {
                    collector.state.timestamp = timestamp.clone();
                }
                if !timestamp.is_empty() {
                    collector.state.last_timestamp = timestamp.clone();
                }
                for mut message in envelope_messages(&record) {
                    if let Some(id) = message["tool_call_id"].as_str().map(str::to_string) {
                        if message["tool_kind"].as_str() == Some("tool_call") {
                            if let Some(name) = message["tool_name"].as_str() {
                                tool_names.insert(id, name.to_string());
                            }
                        } else if let Some(name) = tool_names.get(&id) {
                            message["tool_name"] = Value::String(name.clone());
                        }
                    }
                    collector.push(message, index + 1);
                }
                if let Some(events) = events.as_mut() {
                    events.push(json!({
                        "line_number": index + 1,
                        "timestamp": if timestamp.is_empty() { Value::Null } else { Value::String(timestamp) },
                        "type": record["message"]["type"].as_str().unwrap_or("unknown"),
                        "payload": record["message"]["payload"].clone(),
                    }));
                }
            }
            Err(error) => {
                if let Some(events) = events.as_mut() {
                    events.push(json!({
                        "line_number": index + 1,
                        "timestamp": Value::Null,
                        "type": "parse_error",
                        "payload": { "message": error.to_string() },
                    }));
                }
            }
        }
    }
    collector.flush();
    Ok((collector.state, collector.messages, events))
}

fn build_summary(path: &Path, source: &Source, state: &ParseState) -> Value {
    let mut summary = state.summary(path, source);
    if let Some(title) = custom_title(path) {
        summary["title"] = Value::String(compact(&title, 90));
    }
    summary["source_read_only"] = Value::Bool(true);
    summary
}

pub(super) fn parse_summary(path: &Path, source: &Source) -> Result<(Value, String), String> {
    let (state, _, _) = parse_wire(path, source, false)?;
    let summary = build_summary(path, source, &state);
    let mut search = summary_search_text(&summary);
    append_limited(&mut search, &[&state.search_text], SEARCH_TEXT_LIMIT);
    Ok((summary, search))
}

pub(super) fn parse_detail(path: &Path, source: &Source) -> Result<Value, String> {
    let (state, messages, events) = parse_wire(path, source, true)?;
    let (mut message_values, omitted_messages, total_messages) =
        messages.expect("详情解析必须收集消息").finish(json!({
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
    let (mut event_values, omitted_events, total_events) =
        events.expect("详情解析必须收集原始事件").finish(json!({
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
    let mut summary = build_summary(path, source, &state);
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

    use serde_json::json;
    use tempfile::tempdir;

    use super::{parse_detail, parse_summary};
    use crate::sessions::{Source, SourceFormat};

    fn source(root: &Path) -> Source {
        Source {
            kind: "kimi",
            display_name: "Kimi Code CLI",
            root: root.into(),
            format: SourceFormat::Kimi,
            archived: false,
        }
    }

    #[test]
    fn 解析会话元数据并合并流式文本() {
        let directory = tempdir().unwrap();
        let cwd = "/work/kimi-project";
        let hash = format!("{:x}", md5::compute(cwd.as_bytes()));
        let session_dir = directory.path().join("sessions").join(&hash).join("kimi-1");
        std::fs::create_dir_all(&session_dir).unwrap();
        std::fs::write(
            directory.path().join("kimi.json"),
            json!({ "work_dirs": [{ "path": cwd, "kaos": "local" }] }).to_string(),
        )
        .unwrap();
        std::fs::write(
            session_dir.join("state.json"),
            json!({ "custom_title": "Kimi 命名会话" }).to_string(),
        )
        .unwrap();
        std::fs::write(
            session_dir.join("wire.jsonl"),
            concat!(
                "{\"type\":\"metadata\",\"protocol_version\":\"2\"}\n",
                "{\"timestamp\":1787184000.0,\"message\":{\"type\":\"TurnBegin\",\"payload\":{\"user_input\":\"请检查项目\"}}}\n",
                "{\"timestamp\":1787184000.5,\"message\":{\"type\":\"ContentPart\",\"payload\":{\"type\":\"think\",\"think\":\"先检查状态\"}}}\n",
                "{\"timestamp\":1787184001.0,\"message\":{\"type\":\"ContentPart\",\"payload\":{\"type\":\"text\",\"text\":\"已经\"}}}\n",
                "{\"timestamp\":1787184001.1,\"message\":{\"type\":\"ContentPart\",\"payload\":{\"type\":\"text\",\"text\":\"完成\"}}}\n",
                "{\"timestamp\":1787184001.2,\"message\":{\"type\":\"ContentPart\",\"payload\":{\"type\":\"image_url\",\"image_url\":{\"url\":\"https://example.com/result.png\",\"id\":null}}}}\n",
                "{\"timestamp\":1787184002.0,\"message\":{\"type\":\"ToolCall\",\"payload\":{\"id\":\"call-1\",\"function\":{\"name\":\"Shell\",\"arguments\":\"{\\\"command\\\":\\\"pwd\\\"}\"}}}}\n",
                "{\"timestamp\":1787184003.0,\"message\":{\"type\":\"ToolResult\",\"payload\":{\"tool_call_id\":\"call-1\",\"return_value\":{\"is_error\":true,\"output\":\"\",\"message\":\"命令执行失败\",\"display\":[]}}}}\n"
            ),
        )
        .unwrap();

        let path = session_dir.join("wire.jsonl");
        let (summary, search) = parse_summary(&path, &source(directory.path())).unwrap();
        assert_eq!(summary["id"], "kimi-1");
        assert_eq!(summary["cwd"], cwd);
        assert_eq!(summary["title"], "Kimi 命名会话");
        assert_eq!(summary["message_count"], 5);
        assert_eq!(summary["context_count"], 1);
        assert_eq!(summary["tool_count"], 2);
        assert!(search.contains("已经完成"));

        let detail = parse_detail(&path, &source(directory.path())).unwrap();
        let messages = detail["conversation_messages"].as_array().unwrap();
        assert_eq!(messages.len(), 6);
        assert_eq!(messages[1]["text"], "先检查状态");
        assert_eq!(messages[2]["text"], "已经完成");
        assert_eq!(messages[3]["text"], "[image]");
        assert_eq!(messages[5]["text"], "命令执行失败");
        assert_eq!(messages[5]["tool_name"], "Shell");
        assert_eq!(messages[5]["is_error"], true);
        assert!(messages
            .iter()
            .all(|message| message["_delete_ref"].is_null()));
        assert!(messages
            .iter()
            .all(|message| message["_message_key"].is_string()));
    }

    #[test]
    fn 子代理使用独立标识并默认隐藏() {
        let directory = tempdir().unwrap();
        let session_dir = directory
            .path()
            .join("sessions")
            .join("hash")
            .join("main")
            .join("subagents")
            .join("agent-1");
        std::fs::create_dir_all(&session_dir).unwrap();
        let path = session_dir.join("wire.jsonl");
        std::fs::write(
            &path,
            "{\"timestamp\":1787184000.0,\"message\":{\"type\":\"TurnBegin\",\"payload\":{\"user_input\":\"子任务\"}}}\n",
        )
        .unwrap();
        let (summary, _) = parse_summary(&path, &source(directory.path())).unwrap();
        assert_eq!(summary["id"], "main:subagent:agent-1");
        assert_eq!(summary["parent_session_id"], "main");
        assert_eq!(summary["hidden"], true);
        assert_eq!(summary["hidden_reason"], "subagent");
    }
}
