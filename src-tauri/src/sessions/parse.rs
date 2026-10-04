//! 通用会话解析:摘要/详情分发、ParseState 归约、消息构造与长会话截断。
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::claude_legacy::{parse_legacy_claude_detail, parse_legacy_claude_summary};
use super::helpers::{
    compact, compact_title, error_text, is_synthetic_context, nullable_string, string_at,
};
use super::{
    copilot, kimi, pi, vscode_copilot, Source, SourceFormat, DETAIL_EVENT_LIMIT,
    DETAIL_MESSAGE_LIMIT, DETAIL_TEXT_LIMIT, SEARCH_TEXT_LIMIT,
};

pub(crate) struct ParseState {
    pub(crate) id: String,
    pub(crate) timestamp: String,
    pub(crate) last_timestamp: String,
    pub(crate) cwd: String,
    pub(crate) provider: String,
    pub(crate) originator: String,
    pub(crate) hidden: bool,
    pub(crate) hidden_reason: String,
    pub(crate) force_sidechain: bool,
    pub(crate) saw_sidechain: bool,
    pub(crate) saw_primary: bool,
    pub(crate) fallback_id: String,
    pub(crate) parent_session_id: String,
    pub(crate) agent_id: String,
    pub(crate) event_count: usize,
    pub(crate) message_count: u64,
    pub(crate) context_count: u64,
    pub(crate) roles: BTreeMap<String, u64>,
    pub(crate) first_user: String,
    pub(crate) first_assistant: String,
    pub(crate) first_message: String,
    pub(crate) search_text: String,
    pub(crate) tool_names: HashMap<String, String>,
    pub(crate) previous_message: Option<(String, String, String)>,
}

impl ParseState {
    pub(crate) fn new(path: &Path) -> Self {
        let fallback_id = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("unknown")
            .to_string();
        let force_sidechain = path
            .components()
            .any(|component| component.as_os_str() == "subagents");
        Self {
            id: fallback_id.clone(),
            timestamp: String::new(),
            last_timestamp: String::new(),
            cwd: String::new(),
            provider: "unknown".into(),
            originator: String::new(),
            hidden: false,
            hidden_reason: String::new(),
            force_sidechain,
            saw_sidechain: force_sidechain,
            saw_primary: false,
            fallback_id,
            parent_session_id: String::new(),
            agent_id: String::new(),
            event_count: 0,
            message_count: 0,
            context_count: 0,
            roles: BTreeMap::new(),
            first_user: String::new(),
            first_assistant: String::new(),
            first_message: String::new(),
            search_text: String::new(),
            tool_names: HashMap::new(),
            previous_message: None,
        }
    }
    pub(crate) fn accept(&mut self, record: &Value) -> Vec<Value> {
        self.event_count += 1;
        let stamp = string_at(record, &["timestamp"]).unwrap_or_default();
        if self.timestamp.is_empty() && !stamp.is_empty() {
            self.timestamp = stamp.clone();
        }
        if !stamp.is_empty() {
            self.last_timestamp = stamp.clone();
        }
        if record.get("type").and_then(Value::as_str) == Some("session_meta") {
            let payload = &record["payload"];
            if let Some(value) = string_at(payload, &["id"]) {
                self.id = value;
            }
            if let Some(value) = string_at(payload, &["cwd"]) {
                self.cwd = value;
            }
            if let Some(value) = string_at(payload, &["model_provider"]) {
                self.provider = value;
            }
            if let Some(value) = string_at(payload, &["originator"]) {
                self.originator = value;
            }
            if payload
                .get("source")
                .and_then(|value| value.get("subagent"))
                .is_some()
            {
                self.hidden = true;
                self.hidden_reason = "subagent".into();
            }
        }
        if let Some(value) = string_at(record, &["cwd"]) {
            self.cwd = value;
        }
        for key in [
            "workingDirectory",
            "working_directory",
            "workspace",
            "workspaceDir",
            "projectRoot",
            "project_root",
        ] {
            if self.cwd.is_empty() {
                if let Some(value) = string_at(record, &[key]) {
                    self.cwd = value;
                }
            }
        }
        if let Some(value) = string_at(record, &["sessionId"]) {
            if self.force_sidechain {
                self.parent_session_id = value;
            } else {
                self.id = value;
            }
        }
        if let Some(value) =
            string_at(record, &["agentId"]).or_else(|| string_at(record, &["agent_id"]))
        {
            self.agent_id = value;
        }
        if self.force_sidechain {
            self.id = format!(
                "{}:subagent:{}",
                if self.parent_session_id.is_empty() {
                    "unknown"
                } else {
                    &self.parent_session_id
                },
                if self.agent_id.is_empty() {
                    &self.fallback_id
                } else {
                    &self.agent_id
                }
            );
        }
        if let Some(value) = string_at(record, &["modelProvider"])
            .or_else(|| string_at(record, &["model_provider"]))
            .or_else(|| string_at(record, &["provider"]))
            .or_else(|| string_at(record, &["message", "provider"]))
        {
            self.provider = value;
        }
        if record.get("isSidechain").and_then(Value::as_bool) == Some(true) {
            self.saw_sidechain = true;
        } else if matches!(
            record.get("type").and_then(Value::as_str),
            Some("user" | "assistant")
        ) {
            self.saw_primary = true;
        }
        let mut accepted = Vec::new();
        for message in conversation_messages(record, &stamp, &mut self.tool_names) {
            if let Some(message) = self.accept_message(message) {
                accepted.push(message);
            }
        }
        accepted
    }
    pub(crate) fn accept_message(&mut self, message: Value) -> Option<Value> {
        let role = message["role"].as_str().unwrap_or("unknown");
        let text = message["text"].as_str().unwrap_or_default();
        let source_type = message["source_type"].as_str().unwrap_or_default();
        if let Some((previous_role, previous_text, previous_type)) = &self.previous_message {
            if previous_role == role
                && previous_text == text
                && ((previous_type == "event_msg" && source_type == "response_item")
                    || (previous_type == "response_item" && source_type == "event_msg"))
            {
                return None;
            }
        }
        self.previous_message = Some((role.into(), text.into(), source_type.into()));
        if message["synthetic_context"].as_bool() == Some(true) {
            self.context_count += 1;
            return Some(message);
        }
        self.message_count += 1;
        *self.roles.entry(role.into()).or_default() += 1;
        if self.first_message.is_empty() {
            self.first_message = compact(text, 160);
        }
        if role == "user" && self.first_user.is_empty() {
            self.first_user = compact_title(text, 90);
        }
        if role == "assistant" && self.first_assistant.is_empty() {
            self.first_assistant = compact(text, 160);
        }
        append_limited(&mut self.search_text, &[role, text], SEARCH_TEXT_LIMIT);
        Some(message)
    }
    pub(crate) fn summary(&self, path: &Path, source: &Source) -> Value {
        let hidden =
            self.hidden || self.force_sidechain || (self.saw_sidechain && !self.saw_primary);
        let hidden_reason = if hidden && self.hidden_reason.is_empty() {
            "subagent"
        } else {
            &self.hidden_reason
        };
        let title = if !self.first_user.is_empty() {
            self.first_user.clone()
        } else {
            Path::new(&self.cwd)
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or(&self.id)
                .into()
        };
        let preview = if !self.first_assistant.is_empty() {
            self.first_assistant.clone()
        } else {
            self.first_message.clone()
        };
        let provider = if self.provider == "unknown" {
            match source.format {
                SourceFormat::Claude => "anthropic",
                SourceFormat::Gemini => "google",
                SourceFormat::Codex => "unknown",
                SourceFormat::Pi => "unknown",
                // Kimi Code CLI 可配置不同模型 Provider；wire.jsonl 未记录时不做推断。
                SourceFormat::Kimi => "unknown",
                SourceFormat::OpenCode => "unknown",
                SourceFormat::Kilo => "unknown",
                SourceFormat::ZCode => "unknown",
                SourceFormat::Cursor => "unknown",
                // Devin 的模型（如 swe-2-high、claude-opus-5-*）记录在消息库
                // configOptions 里，未记录时不做推断。
                SourceFormat::Devin => "unknown",
                // GitHub Copilot 由 GitHub 代理模型，事件里只有模型名没有 provider。
                SourceFormat::Copilot => "github",
                // Hermes 的模型引用形如 anthropic/claude-*，adapter 已拆出 provider；
                // 未记录时不做推断。
                SourceFormat::Hermes => "unknown",
                // VS Code Copilot Chat 同样由 GitHub 代理模型。
                SourceFormat::VsCodeCopilot => "github",
            }
        } else {
            &self.provider
        };
        let originator = if self.originator.is_empty() {
            match source.format {
                SourceFormat::Claude => "claude_code",
                SourceFormat::Gemini => "google_gemini",
                SourceFormat::Codex => "",
                SourceFormat::Pi => "pi",
                SourceFormat::Kimi => "kimi_code_cli",
                SourceFormat::OpenCode => "opencode",
                SourceFormat::Kilo => "kilo",
                SourceFormat::ZCode => "zcode",
                SourceFormat::Cursor => "cursor",
                SourceFormat::Devin => "devin",
                SourceFormat::Copilot => "copilot_cli",
                SourceFormat::Hermes => "hermes_agent",
                SourceFormat::VsCodeCopilot => "vscode_copilot_chat",
            }
        } else {
            &self.originator
        };
        json!({ "id": self.id, "_key": format!("{}:{}", source.kind, self.id), "source_kind": source.kind, "display_source": source.display_name, "timestamp": nullable_string(&self.timestamp), "last_timestamp": nullable_string(&self.last_timestamp), "model_provider": provider, "cwd": self.cwd, "source": if hidden { "subagent" } else { "cli" }, "originator": originator, "file_path": path.to_string_lossy(), "event_count": self.event_count, "message_count": self.message_count, "context_count": self.context_count, "role_counts": self.roles, "tool_count": self.roles.get("tool").copied().unwrap_or_default(), "title": title, "preview_text": preview, "archived": source.archived, "archive_source": if source.archived { "codex" } else { "" }, "hidden": hidden, "hidden_reason": hidden_reason, "parent_session_id": if self.parent_session_id.is_empty() { Value::Null } else { Value::String(self.parent_session_id.clone()) } })
    }
}
pub(crate) fn parse_summary(path: &Path, source: &Source) -> Result<(Value, String), String> {
    match source.format {
        SourceFormat::Pi => return pi::parse_summary(path, source),
        SourceFormat::Kimi => return kimi::parse_summary(path, source),
        SourceFormat::Copilot => return copilot::parse_summary(path, source),
        SourceFormat::VsCodeCopilot => return vscode_copilot::parse_summary(path, source),
        SourceFormat::OpenCode | SourceFormat::Kilo => {
            return Err("SQLite 数据库必须通过聚合来源解析".into())
        }
        SourceFormat::ZCode => return Err("ZCode 数据库必须通过聚合来源解析".into()),
        SourceFormat::Devin => return Err("Devin 消息库必须通过聚合来源解析".into()),
        SourceFormat::Hermes => return Err("Hermes 状态库必须通过聚合来源解析".into()),
        _ => {}
    }
    if path.extension().and_then(|value| value.to_str()) == Some("json") {
        return parse_legacy_claude_summary(path, source);
    }
    let mut state = ParseState::new(path);
    for line in BufReader::new(File::open(path).map_err(error_text)?).lines() {
        let line = line.map_err(error_text)?;
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(record) = serde_json::from_str::<Value>(&line) {
            state.accept(&record);
        }
    }
    let summary = state.summary(path, source);
    let mut search = summary_search_text(&summary);
    append_limited(&mut search, &[&state.search_text], SEARCH_TEXT_LIMIT);
    Ok((summary, search))
}

pub(crate) fn parse_detail(path: &Path, source: &Source) -> Result<Value, String> {
    match source.format {
        SourceFormat::Pi => return pi::parse_detail(path, source),
        SourceFormat::Kimi => return kimi::parse_detail(path, source),
        SourceFormat::Copilot => return copilot::parse_detail(path, source),
        SourceFormat::VsCodeCopilot => return vscode_copilot::parse_detail(path, source),
        _ => {}
    }
    visit_detail(path, source, &mut |_| {})
}

pub(crate) fn visit_detail(
    path: &Path,
    source: &Source,
    visitor: &mut dyn FnMut(&Value),
) -> Result<Value, String> {
    match source.format {
        SourceFormat::Pi => return pi::visit_detail(path, source, visitor),
        SourceFormat::Kimi => return kimi::visit_detail(path, source, visitor),
        SourceFormat::Copilot => return copilot::visit_detail(path, source, visitor),
        SourceFormat::VsCodeCopilot => return vscode_copilot::visit_detail(path, source, visitor),
        SourceFormat::OpenCode | SourceFormat::Kilo => {
            return Err("SQLite 数据库必须通过详情定位器解析".into())
        }
        SourceFormat::ZCode => return Err("ZCode 数据库必须通过详情定位器解析".into()),
        SourceFormat::Devin => return Err("Devin 消息库必须通过详情定位器解析".into()),
        _ => {}
    }
    if path.extension().and_then(|value| value.to_str()) == Some("json") {
        let value: Value =
            serde_json::from_reader(File::open(path).map_err(error_text)?).map_err(error_text)?;
        let detail = parse_legacy_claude_detail(path, source, value)
            .ok_or_else(|| "旧版 Claude 会话缺少 ID".to_string())?;
        for message in detail["conversation_messages"]
            .as_array()
            .into_iter()
            .flatten()
        {
            visitor(message);
        }
        return Ok(detail);
    }
    let mut state = ParseState::new(path);
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
                for (message_index, mut message) in state.accept(&record).into_iter().enumerate() {
                    attach_message_delete_ref(
                        &mut message,
                        json!({
                            "kind": "jsonl_record",
                            "line_number": index + 1,
                            "message_index": message_index,
                            "record_fingerprint": json_fingerprint(&record),
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
                        .get("payload")
                        .cloned()
                        .unwrap_or_else(|| record.clone())
                };
                events.push(json!({ "line_number": index + 1, "timestamp": record.get("timestamp").cloned().unwrap_or(Value::Null), "type": record.get("type").and_then(Value::as_str).unwrap_or("unknown"), "payload": payload }));
            }
            Err(error) => {
                state.event_count += 1;
                events.push(json!({ "line_number": index + 1, "timestamp": Value::Null, "type": "parse_error", "payload": { "message": error.to_string() } }));
            }
        }
    }
    let (mut message_values, omitted_messages, total_messages) = messages.finish(json!({ "role": "system", "text": "", "timestamp": Value::Null, "source_type": "viewer", "source_subtype": "truncation", "is_truncation_marker": true }));
    if omitted_messages > 0 {
        if let Some(marker) = message_values
            .iter_mut()
            .find(|value| value["is_truncation_marker"] == true)
        {
            marker["omitted_count"] = json!(omitted_messages);
        }
    }
    let (event_values, omitted_events, total_events) = events.finish(json!({ "line_number": Value::Null, "timestamp": Value::Null, "type": "viewer_truncation", "payload": { "omitted_events": 0 } }));
    let mut summary = state.summary(path, source);
    if omitted_messages + omitted_events > 0 {
        summary["detail_truncated"] = Value::Bool(true);
    }
    Ok(
        json!({ "summary": summary, "conversation_messages": message_values, "raw_events": event_values, "truncation": { "truncated": omitted_messages + omitted_events > 0, "messages": { "total": total_messages, "omitted": omitted_messages }, "raw_events": { "total": total_events, "omitted": omitted_events } } }),
    )
}

pub(crate) struct HeadTail<T> {
    limit: usize,
    values: VecDeque<T>,
    total: usize,
}
impl<T> HeadTail<T> {
    pub(crate) fn new(limit: usize) -> Self {
        Self {
            limit,
            values: VecDeque::new(),
            total: 0,
        }
    }
    pub(crate) fn push(&mut self, value: T) {
        self.total += 1;
        if self.values.len() < self.limit {
            self.values.push_back(value);
        } else {
            let head = self.limit.div_ceil(2);
            self.values.remove(head);
            self.values.push_back(value);
        }
    }
    pub(crate) fn finish(self, marker: T) -> (Vec<T>, usize, usize) {
        let omitted = self.total.saturating_sub(self.values.len());
        let mut values = self.values.into_iter().collect::<Vec<_>>();
        if omitted > 0 {
            values.insert(self.limit.div_ceil(2), marker);
        }
        (values, omitted, self.total)
    }
}

pub(crate) struct DetailCache {
    max_bytes: usize,
    bytes: usize,
    order: VecDeque<String>,
    values: HashMap<String, (Value, usize)>,
}
impl DetailCache {
    pub(crate) fn new(max_bytes: usize) -> Self {
        Self {
            max_bytes,
            bytes: 0,
            order: VecDeque::new(),
            values: HashMap::new(),
        }
    }
    pub(crate) fn get(&mut self, key: &str) -> Option<Value> {
        let value = self.values.get(key)?.0.clone();
        self.order.retain(|item| item != key);
        self.order.push_back(key.into());
        Some(value)
    }
    pub(crate) fn insert(&mut self, key: String, value: Value, size: usize) {
        if size > self.max_bytes {
            return;
        }
        if let Some((_, old)) = self.values.remove(&key) {
            self.bytes -= old;
        }
        self.order.retain(|item| item != &key);
        self.bytes += size;
        self.order.push_back(key.clone());
        self.values.insert(key, (value, size));
        while self.bytes > self.max_bytes {
            if let Some(old) = self.order.pop_front() {
                if let Some((_, size)) = self.values.remove(&old) {
                    self.bytes -= size;
                }
            }
        }
    }
    pub(crate) fn clear(&mut self) {
        self.bytes = 0;
        self.order.clear();
        self.values.clear();
    }
}
pub(crate) fn conversation_messages(
    record: &Value,
    timestamp: &str,
    tool_names: &mut HashMap<String, String>,
) -> Vec<Value> {
    let record_type = record
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let message = record.get("message");
    if matches!(record_type, "user" | "assistant") && message.is_some_and(Value::is_object) {
        let message = message.unwrap_or(&Value::Null);
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or(record_type);
        let synthetic = record.get("isMeta").and_then(Value::as_bool) == Some(true)
            || record.get("isSidechain").and_then(Value::as_bool) == Some(true);
        let blocks = message
            .get("content")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_else(|| vec![message.get("content").cloned().unwrap_or(Value::Null)]);
        let mut messages = Vec::new();
        for block in blocks {
            if let Some(text) = block.as_str().filter(|text| !text.trim().is_empty()) {
                messages.push(message_value(
                    role,
                    text,
                    timestamp,
                    record_type,
                    "text",
                    synthetic,
                ));
                continue;
            }
            let Some(kind) = block.get("type").and_then(Value::as_str) else {
                continue;
            };
            match kind {
                "tool_use" => {
                    let name = block
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown_tool");
                    let id = block.get("id").and_then(Value::as_str).unwrap_or_default();
                    if !id.is_empty() {
                        tool_names.insert(id.into(), name.into());
                    }
                    let input = serde_json::to_string(block.get("input").unwrap_or(&Value::Null))
                        .unwrap_or_default();
                    let mut value = message_value(
                        "tool",
                        &format!("[{name}] {input}"),
                        timestamp,
                        record_type,
                        kind,
                        synthetic,
                    );
                    value["tool_name"] = Value::String(name.into());
                    value["tool_kind"] = Value::String("tool_call".into());
                    if !id.is_empty() {
                        value["tool_call_id"] = Value::String(id.into());
                    }
                    messages.push(value);
                }
                "tool_result" => {
                    let id = block
                        .get("tool_use_id")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let name = tool_names
                        .get(id)
                        .map(String::as_str)
                        .unwrap_or(if id.is_empty() { "tool_result" } else { id });
                    let text = extract_text(block.get("content").unwrap_or(&Value::Null))
                        .unwrap_or_else(|| {
                            serde_json::to_string(block.get("content").unwrap_or(&Value::Null))
                                .unwrap_or_default()
                        });
                    let mut value =
                        message_value("tool", &text, timestamp, record_type, kind, synthetic);
                    value["tool_name"] = Value::String(name.into());
                    value["tool_kind"] = Value::String("tool_result".into());
                    if !id.is_empty() {
                        value["tool_call_id"] = Value::String(id.into());
                    }
                    if block.get("is_error").and_then(Value::as_bool) == Some(true) {
                        value["is_error"] = Value::Bool(true);
                    }
                    messages.push(value);
                }
                "thinking" => {
                    if let Some(text) = extract_text(&block).filter(|text| !text.trim().is_empty())
                    {
                        messages.push(message_value(
                            "assistant",
                            &text,
                            timestamp,
                            record_type,
                            kind,
                            true,
                        ));
                    }
                }
                _ => {
                    if let Some(text) = extract_text(&block).filter(|text| !text.trim().is_empty())
                    {
                        messages.push(message_value(
                            role,
                            &text,
                            timestamp,
                            record_type,
                            kind,
                            synthetic,
                        ));
                    }
                }
            }
        }
        return messages;
    }
    generic_conversation_message(record, timestamp, tool_names)
        .into_iter()
        .collect()
}

pub(crate) fn message_value(
    role: &str,
    text: &str,
    timestamp: &str,
    source_type: &str,
    subtype: &str,
    synthetic: bool,
) -> Value {
    json!({ "role": role, "text": text.trim(), "timestamp": nullable_string(timestamp), "source_type": source_type, "source_subtype": subtype, "synthetic_context": synthetic || role == "developer" || (role == "user" && is_synthetic_context(text)) })
}

pub(crate) fn attach_message_key(message: &mut Value, mut identity_ref: Value) {
    if let Some(tool_call_id) = message["tool_call_id"].as_str() {
        identity_ref["tool_call_id"] = Value::String(tool_call_id.to_string());
    }
    if let Some(object) = identity_ref.as_object_mut() {
        for field in ["line_number", "record_index", "entry_index"] {
            object.remove(field);
        }
    }
    let mut hasher = Sha256::new();
    hasher.update(serde_json::to_vec(&identity_ref).unwrap_or_default());
    for field in ["role", "text", "timestamp", "source_type", "source_subtype"] {
        hasher.update([0]);
        hasher.update(message[field].to_string().as_bytes());
    }
    let key = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    message["_message_key"] = Value::String(key);
}

pub(crate) fn attach_message_delete_ref(message: &mut Value, mut delete_ref: Value) {
    if let Some(tool_call_id) = message["tool_call_id"].as_str() {
        delete_ref["tool_call_id"] = Value::String(tool_call_id.to_string());
    }
    attach_message_key(message, delete_ref.clone());
    message["_delete_ref"] = delete_ref;
}
pub(crate) fn json_fingerprint(value: &Value) -> String {
    let mut hasher = Sha256::new();
    hasher.update(serde_json::to_vec(value).unwrap_or_default());
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
pub(crate) fn generic_conversation_message(
    record: &Value,
    timestamp: &str,
    tool_names: &mut HashMap<String, String>,
) -> Option<Value> {
    let record_type = record
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let payload = record.get("payload").unwrap_or(record);
    let message = record
        .get("message")
        .unwrap_or(payload.get("message").unwrap_or(payload));
    let subtype = if matches!(record_type, "result" | "system") {
        record
            .get("subtype")
            .and_then(Value::as_str)
            .unwrap_or(record_type)
    } else {
        payload
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or(record_type)
    };
    let role = message
        .get("role")
        .and_then(Value::as_str)
        .or_else(|| record.get("role").and_then(Value::as_str))
        .unwrap_or(if matches!(record_type, "result" | "system") {
            "system"
        } else {
            match subtype {
                "user" | "user_message" => "user",
                "assistant" | "agent_message" | "model" => "assistant",
                "tool_use"
                | "tool_result"
                | "tool_call"
                | "function_call"
                | "function_call_output" => "tool",
                "error" | "result" => "system",
                _ => "unknown",
            }
        });
    let call_id = string_at(payload, &["call_id"])
        .or_else(|| string_at(payload, &["tool_use_id"]))
        .or_else(|| string_at(payload, &["id"]));
    let tool_name = string_at(payload, &["name"])
        .or_else(|| string_at(payload, &["tool_name"]))
        .or_else(|| call_id.as_ref().and_then(|id| tool_names.get(id).cloned()));
    if matches!(subtype, "function_call" | "tool_call" | "tool_use") {
        if let (Some(id), Some(name)) = (&call_id, &tool_name) {
            tool_names.insert(id.clone(), name.clone());
        }
    }
    let text = extract_text(message.get("content").unwrap_or(message))
        .or_else(|| extract_text(payload.get("content").unwrap_or(payload)))
        .or_else(|| string_at(payload, &["message"]))
        .or_else(|| string_at(payload, &["output"]))
        .or_else(|| string_at(payload, &["arguments"]))
        .or_else(|| extract_text(record.get("result").unwrap_or(&Value::Null)))
        .or_else(|| extract_text(record.get("error").unwrap_or(&Value::Null)))?;
    if text.trim().is_empty() {
        return None;
    }
    let synthetic = role == "developer" || (role == "user" && is_synthetic_context(&text));
    let mut value = json!({ "role": role, "text": text.trim(), "timestamp": nullable_string(timestamp), "source_type": record_type, "source_subtype": subtype, "synthetic_context": synthetic });
    if let Some(name) = tool_name {
        value["tool_name"] = Value::String(name);
    }
    if let Some(id) = call_id {
        value["tool_call_id"] = Value::String(id);
    }
    if role == "tool" {
        value["tool_kind"] = Value::String(subtype.into());
    }
    if subtype == "error"
        || record.get("is_error").and_then(Value::as_bool) == Some(true)
        || record_type == "result" && subtype.starts_with("error")
        || record_type == "system" && subtype.contains("error")
    {
        value["is_error"] = Value::Bool(true);
    }
    Some(value)
}
pub(crate) fn extract_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Array(items) => {
            let text = items
                .iter()
                .filter_map(extract_text)
                .collect::<Vec<_>>()
                .join("\n\n");
            (!text.is_empty()).then_some(text)
        }
        Value::Object(object) => object
            .get("text")
            .and_then(extract_text)
            .or_else(|| object.get("thinking").and_then(extract_text))
            .or_else(|| object.get("content").and_then(extract_text))
            .or_else(|| object.get("summary").and_then(extract_text)),
        _ => None,
    }
}
pub(crate) fn truncate_message(message: &mut Value) {
    let Some(text) = message["text"].as_str() else {
        return;
    };
    if text.chars().count() <= DETAIL_TEXT_LIMIT {
        return;
    }
    let original = text.chars().count();
    message["text"] = Value::String(text.chars().take(DETAIL_TEXT_LIMIT).collect());
    message["text_truncated"] = Value::Bool(true);
    message["original_text_chars"] = json!(original);
}
pub(crate) fn append_limited(target: &mut String, values: &[&str], limit: usize) {
    for value in values {
        if target.len() >= limit {
            return;
        }
        let remaining = limit - target.len();
        let chunk = if value.len() <= remaining {
            *value
        } else {
            let mut end = remaining;
            while end > 0 && !value.is_char_boundary(end) {
                end -= 1;
            }
            &value[..end]
        };
        target.push_str(chunk);
        target.push('\n');
    }
}
pub(crate) fn summary_search_text(summary: &Value) -> String {
    [
        "id",
        "_key",
        "title",
        "preview_text",
        "cwd",
        "file_path",
        "source_kind",
        "display_source",
        "model_provider",
        "source",
        "originator",
    ]
    .iter()
    .filter_map(|key| summary[*key].as_str())
    .collect::<Vec<_>>()
    .join("\n")
}
pub(crate) fn search_text_from_detail(detail: &Value) -> String {
    let mut text = summary_search_text(&detail["summary"]);
    for message in detail["conversation_messages"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|message| message["synthetic_context"] != true)
    {
        append_limited(
            &mut text,
            &[
                message["role"].as_str().unwrap_or_default(),
                message["text"].as_str().unwrap_or_default(),
            ],
            SEARCH_TEXT_LIMIT,
        );
    }
    text
}
