//! Grok Build 展示日志的只读回放；只保存事件位置，不缓存完整会话正文。

use std::{
    collections::HashMap,
    fs::File,
    io::{BufRead, BufReader, Seek, SeekFrom},
    path::{Path, PathBuf},
};

use serde_json::{json, Value};
use walkdir::WalkDir;

use super::{
    append_limited, attach_message_key, compact_title, error_text, message_value,
    summary_search_text, truncate_message, HeadTail, ParseState, Source, DETAIL_EVENT_LIMIT,
    DETAIL_MESSAGE_LIMIT,
};

pub(super) fn sessions_root(root: &Path) -> PathBuf {
    if root.file_name().and_then(|s| s.to_str()) == Some("sessions") {
        root.into()
    } else {
        root.join("sessions")
    }
}

pub(super) fn matches_path(root: &Path, path: &Path) -> bool {
    path.strip_prefix(sessions_root(root))
        .is_ok_and(|relative| {
            relative.components().count() == 3
                && relative.file_name().and_then(|s| s.to_str()) == Some("updates.jsonl")
        })
}

pub(super) fn discover_files(source: &Source) -> Vec<PathBuf> {
    let mut files = WalkDir::new(sessions_root(&source.root))
        .max_depth(3)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file() && matches_path(&source.root, entry.path()))
        .map(|entry| entry.into_path())
        .collect::<Vec<_>>();
    files.sort();
    files
}

fn validate_path(path: &Path, source: &Source) -> Result<(), String> {
    let root = sessions_root(&source.root);
    let relative = path.strip_prefix(&root).map_err(error_text)?;
    if !matches_path(&source.root, path) {
        return Err("Grok 会话路径无效".into());
    }
    let mut current = root;
    for component in relative.components() {
        if !matches!(component, std::path::Component::Normal(_)) {
            return Err("Grok 会话路径无效".into());
        }
        current.push(component);
        if std::fs::symlink_metadata(&current)
            .map_err(error_text)?
            .file_type()
            .is_symlink()
        {
            return Err("Grok 会话路径不能包含符号链接".into());
        }
    }
    Ok(())
}

fn metadata(path: &Path) -> Result<Value, String> {
    let meta_path = path
        .parent()
        .ok_or("Grok 会话路径无效")?
        .join("summary.json");
    match std::fs::symlink_metadata(&meta_path) {
        Ok(meta) if meta.file_type().is_symlink() => return Err("Grok 元数据不能是符号链接".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Value::Null),
        Err(error) => return Err(error_text(error)),
        _ => {}
    }
    serde_json::from_reader(File::open(meta_path).map_err(error_text)?).map_err(error_text)
}

fn params(record: &Value) -> &Value {
    record.get("params").unwrap_or(record)
}

fn timestamp(record: &Value) -> String {
    params(record)["_meta"]["agentTimestampMs"]
        .as_i64()
        .and_then(super::timestamp_from_millis)
        .or_else(|| {
            record["timestamp"]
                .as_i64()
                .and_then(|seconds| seconds.checked_mul(1000))
                .and_then(super::timestamp_from_millis)
        })
        .unwrap_or_default()
}

#[derive(Clone, Copy)]
struct RecordRef {
    offset: u64,
    line: usize,
}

#[derive(Default)]
struct UserRuns {
    seen_marker: bool,
    in_user: bool,
    index: Option<u64>,
}

impl UserRuns {
    fn user(&mut self, index: Option<u64>) -> bool {
        self.seen_marker |= index.is_some();
        let new_run = !self.in_user || self.seen_marker && index != self.index;
        self.in_user = true;
        self.index = index;
        new_run && (!self.seen_marker || index.is_some())
    }

    fn end(&mut self) {
        self.in_user = false;
        self.index = None;
    }
}

struct Entry {
    tag: String,
    records: Vec<RecordRef>,
    prompt_index: Option<u64>,
    host_turn: bool,
}

fn read_record(reader: &mut BufReader<File>, reference: RecordRef) -> Result<Value, String> {
    reader
        .seek(SeekFrom::Start(reference.offset))
        .map_err(error_text)?;
    let mut line = String::new();
    reader.read_line(&mut line).map_err(error_text)?;
    serde_json::from_str(&line)
        .map_err(|error| format!("Grok 展示日志第 {} 行：{error}", reference.line))
}

fn content_text(content: &Value) -> String {
    match content["type"].as_str().unwrap_or_default() {
        "text" => content["text"].as_str().unwrap_or_default().into(),
        "image" => "[image]".into(),
        "audio" => "[audio]".into(),
        "resource_link" => format!("[file] {}", content["uri"].as_str().unwrap_or_default()),
        "resource" => content["resource"]["text"]
            .as_str()
            .map(str::to_string)
            .unwrap_or_else(|| {
                format!(
                    "[file] {}",
                    content["resource"]["uri"].as_str().unwrap_or_default()
                )
            }),
        _ => String::new(),
    }
}

fn tool_text(tool: &Value) -> String {
    if let Some(output) = tool.get("rawOutput").filter(|value| !value.is_null()) {
        return value_text(output);
    }
    tool["content"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|block| match block["type"].as_str().unwrap_or_default() {
            "content" => content_text(&block["content"]),
            "diff" => format!(
                "[diff] {}\n{}",
                block["path"].as_str().unwrap_or_default(),
                block["newText"].as_str().unwrap_or_default()
            ),
            "terminal" => format!(
                "[terminal] {}",
                block["terminalId"].as_str().unwrap_or_default()
            ),
            _ => String::new(),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn value_text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

fn entry_messages(reader: &mut BufReader<File>, entry: &Entry) -> Result<Vec<Value>, String> {
    let mut text = String::new();
    let mut text_chars = 0;
    let mut time = String::new();
    let mut tool = json!({});
    for reference in &entry.records {
        let record = read_record(reader, *reference)?;
        if time.is_empty() {
            time = timestamp(&record);
        }
        let update = &params(&record)["update"];
        if entry.tag == "tool_call" {
            // ACP 更新中的字段是替换语义；未携带的字段继续保留。
            for key in [
                "toolCallId",
                "title",
                "kind",
                "status",
                "rawInput",
                "rawOutput",
                "content",
            ] {
                if let Some(value) = update.get(key) {
                    tool[key] = value.clone();
                }
            }
        } else {
            let part = content_text(&update["content"]);
            text_chars += part.chars().count();
            // 单条流式消息也可能很大；正文按搜索索引的同一上限收集。
            let remaining = super::SEARCH_TEXT_LIMIT.saturating_sub(text.len());
            let mut end = part.len().min(remaining);
            while !part.is_char_boundary(end) {
                end -= 1;
            }
            text.push_str(&part[..end]);
        }
    }
    if entry.tag == "tool_call" {
        let name = tool["title"].as_str().unwrap_or("tool");
        let id = tool["toolCallId"].as_str().unwrap_or_default();
        let mut call = message_value(
            "tool",
            &format!("[{name}] {}", value_text(&tool["rawInput"])),
            &time,
            "grok_acp",
            "tool_call",
            false,
        );
        call["tool_name"] = json!(name);
        call["tool_kind"] = json!("tool_call");
        call["tool_call_id"] = json!(id);
        call["status"] = tool["status"].clone();
        let mut messages = vec![call];
        if matches!(tool["status"].as_str(), Some("completed" | "failed")) {
            let mut result = message_value(
                "tool",
                &tool_text(&tool),
                &time,
                "grok_acp",
                "tool_result",
                false,
            );
            result["tool_name"] = json!(name);
            result["tool_kind"] = json!("tool_result");
            result["tool_call_id"] = json!(id);
            result["is_error"] = json!(tool["status"] == "failed");
            messages.push(result);
        }
        return Ok(messages);
    }
    let (role, subtype, synthetic) = match entry.tag.as_str() {
        "user_message_chunk" => ("user", "text", entry.host_turn),
        "agent_thought_chunk" => ("assistant", "thinking", true),
        _ => ("assistant", "text", false),
    };
    Ok((!text.trim().is_empty())
        .then(|| {
            let mut message = message_value(role, &text, &time, "grok_acp", subtype, synthetic);
            if text_chars > text.chars().count() {
                message["text_truncated"] = json!(true);
                message["original_text_chars"] = json!(text_chars);
            }
            message
        })
        .into_iter()
        .collect())
}

fn parse(
    path: &Path,
    source: &Source,
    visitor: &mut dyn FnMut(&Value),
    detail: bool,
) -> Result<Value, String> {
    // 增量监听和详情读取也遵守扫描时不跟随符号链接的边界。
    validate_path(path, source)?;
    let meta = metadata(path)?;
    let mut state = ParseState::new(path);
    state.id = meta["info"]["id"]
        .as_str()
        .or_else(|| path.parent()?.file_name()?.to_str())
        .unwrap_or("unknown")
        .into();
    state.cwd = meta["info"]["cwd"].as_str().unwrap_or_default().into();
    state.timestamp = meta["created_at"].as_str().unwrap_or_default().into();
    state.last_timestamp = meta["updated_at"].as_str().unwrap_or_default().into();
    state.parent_session_id = meta["parent_session_id"]
        .as_str()
        .unwrap_or_default()
        .into();
    state.hidden = meta["hidden"].as_bool().unwrap_or_else(|| {
        meta["session_kind"]
            .as_str()
            .is_some_and(|kind| kind.starts_with("subagent"))
    });
    let mut reader = BufReader::new(File::open(path).map_err(error_text)?);
    let mut live = Vec::new();
    let mut starts = Vec::new();
    let mut runs = UserRuns::default();
    let mut events = detail.then(|| HeadTail::new(DETAIL_EVENT_LIMIT));
    let mut offset = 0;
    let mut line_number = 0;
    let mut line = String::new();
    while {
        line.clear();
        reader.read_line(&mut line).map_err(error_text)? != 0
    } {
        line_number += 1;
        let reference = RecordRef {
            offset,
            line: line_number,
        };
        offset += line.len() as u64;
        if line.trim().is_empty() {
            continue;
        }
        let record: Value = serde_json::from_str(&line)
            .map_err(|error| format!("Grok 展示日志第 {line_number} 行：{error}"))?;
        state.event_count += 1;
        let time = timestamp(&record);
        if state.timestamp.is_empty() {
            state.timestamp = time.clone();
        }
        if time > state.last_timestamp {
            state.last_timestamp = time.clone();
        }
        let update = &params(&record)["update"];
        let tag = update["sessionUpdate"].as_str().unwrap_or("unknown");
        let xai = record["method"] == "_x.ai/session/update";
        if let Some(events) = events.as_mut() {
            events.push(json!({"line_number": line_number, "timestamp": time, "type": tag,
                "payload": if line.chars().count() > 10_000 { json!({"truncated":true,"original_chars":line.chars().count()}) } else { record.clone() }}));
        }
        if xai && tag == "rewind_marker" {
            if let Some(target) = update["target_prompt_index"].as_u64() {
                let target = target as usize;
                live.truncate(starts.get(target).copied().unwrap_or(live.len()));
                starts.truncate(target);
            }
            runs.end();
            continue;
        }
        if !xai && tag == "user_message_chunk" && update["_meta"]["hostTurn"] != true {
            if runs.user(update["_meta"]["promptIndex"].as_u64()) {
                starts.push(live.len());
            }
        } else {
            runs.end();
        }
        live.push(reference);
    }
    // 只归约有效事件的位置，工具更新归入首次调用，流式正文按逻辑消息合并。
    let mut entries: Vec<Entry> = Vec::new();
    let mut tools = HashMap::<String, usize>::new();
    let mut chunk: Option<usize> = None;
    for reference in live {
        let record = read_record(&mut reader, reference)?;
        let update = &params(&record)["update"];
        let tag = update["sessionUpdate"].as_str().unwrap_or_default();
        if record["method"] == "_x.ai/session/update" {
            if matches!(
                tag,
                "turn_completed" | "response_completed" | "compaction_checkpoint"
            ) {
                chunk = None;
            }
            continue;
        }
        let prompt_index = update["_meta"]["promptIndex"].as_u64();
        let host_turn = update["_meta"]["hostTurn"] == true;
        match tag {
            "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk" => {
                let index = chunk.filter(|index| {
                    entries[*index].tag == tag
                        && entries[*index].prompt_index == prompt_index
                        && entries[*index].host_turn == host_turn
                });
                if let Some(index) = index {
                    entries[index].records.push(reference);
                } else {
                    chunk = Some(entries.len());
                    entries.push(Entry {
                        tag: tag.into(),
                        records: vec![reference],
                        prompt_index,
                        host_turn,
                    });
                }
            }
            "tool_call" | "tool_call_update" => {
                chunk = None;
                let id = update["toolCallId"]
                    .as_str()
                    .ok_or("Grok 工具事件缺少 toolCallId")?;
                if let Some(index) = tools.get(id) {
                    entries[*index].records.push(reference);
                } else {
                    tools.insert(id.into(), entries.len());
                    entries.push(Entry {
                        tag: "tool_call".into(),
                        records: vec![reference],
                        prompt_index: None,
                        host_turn: false,
                    });
                }
            }
            _ => {}
        }
    }
    let mut messages = HeadTail::new(DETAIL_MESSAGE_LIMIT);
    let mut sequence = 0;
    for entry in &entries {
        for mut message in entry_messages(&mut reader, entry)? {
            state.accept_message(message.clone());
            if detail {
                attach_message_key(
                    &mut message,
                    json!({"kind":"grok_acp", "message_index":sequence}),
                );
                visitor(&message);
                let original_chars = message["original_text_chars"].clone();
                truncate_message(&mut message);
                if !original_chars.is_null() {
                    message["original_text_chars"] = original_chars;
                }
                messages.push(message);
            }
            sequence += 1;
        }
    }
    let mut summary = state.summary(path, source);
    if let Some(title) = meta["generated_title"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| {
            meta["session_summary"]
                .as_str()
                .filter(|s| !s.trim().is_empty())
        })
    {
        summary["title"] = json!(compact_title(title, 90));
    }
    summary["model"] = meta["current_model_id"].clone();
    summary["source_read_only"] = json!(true);
    if !detail {
        let mut search = summary_search_text(&summary);
        append_limited(&mut search, &[&state.search_text], super::SEARCH_TEXT_LIMIT);
        return Ok(json!({"summary":summary, "search_text":search}));
    }
    let (mut messages, omitted_messages, total_messages) = messages.finish(json!({"role":"system","text":"","timestamp":null,"source_type":"viewer","source_subtype":"truncation","is_truncation_marker":true}));
    if let Some(marker) = messages
        .iter_mut()
        .find(|m| m["is_truncation_marker"] == true)
    {
        marker["omitted_count"] = json!(omitted_messages);
    }
    let (mut events, omitted_events, total_events) = events
        .unwrap()
        .finish(json!({"type":"viewer_truncation", "payload":{}}));
    if let Some(marker) = events.iter_mut().find(|e| e["type"] == "viewer_truncation") {
        marker["payload"]["omitted_events"] = json!(omitted_events);
    }
    let truncated = omitted_messages + omitted_events > 0;
    if truncated {
        summary["detail_truncated"] = json!(true);
    }
    Ok(
        json!({"summary":summary,"conversation_messages":messages,"raw_events":events,
        "truncation":{"truncated":truncated,"messages":{"total":total_messages,"omitted":omitted_messages},"raw_events":{"total":total_events,"omitted":omitted_events}}}),
    )
}

pub(super) fn parse_summary(path: &Path, source: &Source) -> Result<(Value, String), String> {
    let result = parse(path, source, &mut |_| {}, false)?;
    Ok((
        result["summary"].clone(),
        result["search_text"].as_str().unwrap_or_default().into(),
    ))
}

pub(super) fn parse_detail(path: &Path, source: &Source) -> Result<Value, String> {
    visit_detail(path, source, &mut |_| {})
}

pub(super) fn visit_detail(
    path: &Path,
    source: &Source,
    visitor: &mut dyn FnMut(&Value),
) -> Result<Value, String> {
    parse(path, source, visitor, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn 直接读取也拒绝会话目录符号链接() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("sessions");
        let external = directory.path().join("external");
        std::fs::create_dir_all(root.join("project")).unwrap();
        std::fs::create_dir_all(&external).unwrap();
        std::fs::write(external.join("updates.jsonl"), "").unwrap();
        std::os::unix::fs::symlink(&external, root.join("project/session")).unwrap();
        let source = Source {
            kind: "grok",
            display_name: "Grok Build",
            root: root.clone(),
            format: super::super::SourceFormat::Grok,
            archived: false,
        };
        assert!(discover_files(&source).is_empty());
        assert!(
            parse_detail(&root.join("project/session/updates.jsonl"), &source)
                .unwrap_err()
                .contains("符号链接")
        );
    }

    #[test]
    fn 长会话窗口不限制搜索遍历并标记正文截断() {
        let directory = tempfile::tempdir().unwrap();
        let session = directory.path().join("sessions/project/session");
        std::fs::create_dir_all(&session).unwrap();
        let path = session.join("updates.jsonl");
        let mut wire = String::new();
        for index in 0..810 {
            for (tag, text) in [
                ("user_message_chunk", format!("问题{index}")),
                ("agent_message_chunk", format!("回复{index}")),
            ] {
                wire.push_str(&json!({"sessionId":"session","update":{"sessionUpdate":tag,"content":{"type":"text","text":text}}}).to_string());
                wire.push('\n');
            }
        }
        // 新提示打开独立消息；大正文只保留明确上限并记录原始长度。
        for (tag, text) in [
            ("user_message_chunk", "长正文".into()),
            ("agent_message_chunk", "x".repeat(70_000)),
        ] {
            wire.push_str(&json!({"sessionId":"session","update":{"sessionUpdate":tag,"content":{"type":"text","text":text}}}).to_string());
            wire.push('\n');
        }
        std::fs::write(&path, &wire).unwrap();
        let source = Source {
            kind: "grok",
            display_name: "Grok Build",
            root: directory.path().into(),
            format: super::super::SourceFormat::Grok,
            archived: false,
        };
        let mut visited = 0;
        let mut middle_found = false;
        let detail = visit_detail(&path, &source, &mut |message| {
            visited += 1;
            middle_found |= message["text"] == "回复405";
        })
        .unwrap();
        assert_eq!(visited, 1622);
        assert!(middle_found);
        assert_eq!(detail["summary"]["message_count"], 1622);
        assert!(
            detail["conversation_messages"].as_array().unwrap().len() <= DETAIL_MESSAGE_LIMIT + 1
        );
        assert!(detail["raw_events"].as_array().unwrap().len() <= DETAIL_EVENT_LIMIT + 1);
        assert_eq!(detail["truncation"]["truncated"], true);
        let last = detail["conversation_messages"]
            .as_array()
            .unwrap()
            .last()
            .unwrap();
        assert_eq!(
            last["text"].as_str().unwrap().len(),
            super::super::DETAIL_TEXT_LIMIT
        );
        assert_eq!(last["original_text_chars"], 70_000);
        assert_eq!(last["text_truncated"], true);
        assert_eq!(std::fs::read_to_string(path).unwrap(), wire);
    }
}
