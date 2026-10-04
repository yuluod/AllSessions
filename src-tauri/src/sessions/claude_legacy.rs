//! 旧版 Claude Code `sessions/*.json` 与 `history.jsonl` 的解析。
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

use chrono::{SecondsFormat, TimeZone, Utc};
use serde_json::{json, Value};

use super::helpers::{error_text, nullable_string, string_at};
use super::parse::ParseState;
use super::{
    attach_message_delete_ref, json_fingerprint, message_value, search_text_from_detail, Source,
};

pub(crate) fn parse_legacy_claude_summary(
    path: &Path,
    source: &Source,
) -> Result<(Value, String), String> {
    let value: Value =
        serde_json::from_reader(File::open(path).map_err(error_text)?).map_err(error_text)?;
    let detail = parse_legacy_claude_detail(path, source, value)
        .ok_or_else(|| "旧版 Claude 会话缺少 ID".to_string())?;
    Ok((detail["summary"].clone(), search_text_from_detail(&detail)))
}
pub(crate) fn parse_legacy_claude_detail(
    path: &Path,
    source: &Source,
    value: Value,
) -> Option<Value> {
    let id = string_at(&value, &["sessionId"]).or_else(|| string_at(&value, &["id"]))?;
    let timestamp = legacy_timestamp(&value, &["startedAt", "createdAt", "timestamp"]);
    let cwd = string_at(&value, &["projectPath"]).or_else(|| string_at(&value, &["cwd"]));
    let mut state = ParseState::new(path);
    state.id = id.clone();
    if let Some(value) = timestamp.as_ref() {
        state.timestamp = value.clone();
        state.last_timestamp = value.clone();
    }
    if let Some(value) = cwd {
        state.cwd = value;
    }

    let has_entries = value.get("entries").and_then(Value::as_array).is_some();
    let mut messages = Vec::new();
    for (entry_index, record) in value
        .get("entries")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
    {
        for (message_index, mut message) in state.accept(record).into_iter().enumerate() {
            attach_message_delete_ref(
                &mut message,
                json!({
                    "kind": "legacy_entry",
                    "entry_index": entry_index,
                    "message_index": message_index,
                    "record_fingerprint": json_fingerprint(record),
                }),
            );
            messages.push(message);
        }
    }
    let mut raw_events = vec![json!({
        "line_number": Value::Null,
        "timestamp": nullable_string(&state.timestamp),
        "type": "info",
        "payload": { "message": "Legacy Claude Code metadata; full project transcript is unavailable." }
    })];
    if !has_entries {
        if let Some(text) =
            string_at(&value, &["prompt"]).or_else(|| string_at(&value, &["message"]))
        {
            let timestamp = state.timestamp.clone();
            if let Some(mut message) = state.accept_message(message_value(
                "user", &text, &timestamp, "legacy", "prompt", false,
            )) {
                attach_message_delete_ref(
                    &mut message,
                    json!({
                        "kind": "legacy_prompt",
                        "record_fingerprint": json_fingerprint(&Value::String(text.clone())),
                    }),
                );
                messages.push(message);
            }
            raw_events.push(json!({
                "line_number": 1,
                "timestamp": nullable_string(&timestamp),
                "type": "user",
                "payload": { "message": text }
            }));
        }
    }

    let history_path = path
        .parent()
        .and_then(|parent| parent.parent())
        .map(|root| root.join("history.jsonl"));
    if let Some(history_path) = history_path {
        match File::open(&history_path) {
            Ok(file) => {
                for (index, line) in BufReader::new(file).lines().enumerate() {
                    let line = match line {
                        Ok(line) => line,
                        Err(error) => {
                            raw_events.push(json!({
                                "line_number": index + 1,
                                "timestamp": Value::Null,
                                "type": "parse_error",
                                "payload": { "message": error.to_string() }
                            }));
                            continue;
                        }
                    };
                    let record: Value = match serde_json::from_str(&line) {
                        Ok(record) => record,
                        Err(error) => {
                            raw_events.push(json!({
                                "line_number": index + 1,
                                "timestamp": Value::Null,
                                "type": "parse_error",
                                "payload": { "message": error.to_string(), "raw_line": line }
                            }));
                            continue;
                        }
                    };
                    if record
                        .get("sessionId")
                        .or_else(|| record.get("session_id"))
                        .and_then(Value::as_str)
                        != Some(id.as_str())
                    {
                        continue;
                    }
                    let record_timestamp =
                        legacy_timestamp(&record, &["timestamp"]).unwrap_or_default();
                    if !record_timestamp.is_empty() {
                        if state.timestamp.is_empty() {
                            state.timestamp = record_timestamp.clone();
                        }
                        state.last_timestamp = record_timestamp.clone();
                    }
                    raw_events.push(json!({
                        "line_number": index + 1,
                        "timestamp": nullable_string(&record_timestamp),
                        "type": "user_input",
                        "payload": {
                            "display": record.get("display").cloned().unwrap_or(Value::Null),
                            "project": record.get("project").cloned().unwrap_or(Value::Null),
                            "pasted_contents": record.get("pastedContents").cloned().unwrap_or_else(|| json!({}))
                        }
                    }));
                    if let Some(display) = record.get("display").and_then(Value::as_str) {
                        if let Some(mut message) = state.accept_message(message_value(
                            "user",
                            display,
                            &record_timestamp,
                            "user_input",
                            "display",
                            false,
                        )) {
                            attach_message_delete_ref(
                                &mut message,
                                json!({
                                    "kind": "legacy_history",
                                    "line_number": index + 1,
                                    "record_fingerprint": json_fingerprint(&record),
                                }),
                            );
                            messages.push(message);
                        }
                    }
                }
            }
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                eprintln!(
                    "无法读取旧版 Claude history（{}）：{error}",
                    history_path.display()
                );
            }
            Err(_) => {}
        }
    }

    state.event_count = raw_events.len();
    let mut summary = state.summary(path, source);
    summary["legacy_format"] = Value::Bool(true);
    Some(json!({
        "summary": summary,
        "conversation_messages": messages,
        "raw_events": raw_events
    }))
}

pub(crate) fn legacy_timestamp(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        let value = value.get(*key)?;
        if let Some(text) = value.as_str().filter(|text| !text.is_empty()) {
            if let Ok(milliseconds) = text.parse::<i64>() {
                return timestamp_from_millis(milliseconds).or_else(|| Some(text.to_owned()));
            }
            return Some(text.to_owned());
        }
        value.as_i64().and_then(timestamp_from_millis)
    })
}

pub(crate) fn timestamp_from_millis(milliseconds: i64) -> Option<String> {
    Utc.timestamp_millis_opt(milliseconds)
        .single()
        .map(|value| value.to_rfc3339_opts(SecondsFormat::Millis, true))
}
