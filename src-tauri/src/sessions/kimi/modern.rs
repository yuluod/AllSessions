//! 新版 Kimi Wire：先归约消息位置，再读取有效正文，避免缓存整段会话。

use std::collections::HashSet;
use std::io::{Seek, SeekFrom};

use super::*;

#[derive(Clone, Copy)]
struct RecordRef {
    offset: u64,
    line: usize,
}

#[derive(Default)]
struct Entry {
    records: Vec<RecordRef>,
    anchor: bool,
    origin: String,
    id: String,
    owner: String,
}

impl Entry {
    fn message(record: &Value, reference: RecordRef) -> Self {
        let message = &record["message"];
        let origin = message["origin"]["kind"]
            .as_str()
            .or_else(|| message["origin"].as_str())
            .unwrap_or_default();
        let anchor = message["role"] == "user"
            && message["origin"]["inTurn"] != true
            && (matches!(origin, "" | "user")
                || matches!(origin, "skill_activation" | "plugin_command")
                    && message["origin"]["trigger"] == "user-slash");
        Self {
            records: vec![reference],
            anchor,
            origin: origin.into(),
            id: message["id"].as_str().unwrap_or_default().into(),
            owner: message["origin"]["ownerPromptId"]
                .as_str()
                .unwrap_or_default()
                .into(),
        }
    }
}

#[derive(Default)]
struct Transcript {
    entries: Vec<Entry>,
    open: Option<(usize, String)>,
    pending_tools: HashSet<String>,
    deferred: Vec<Entry>,
    clear_floor: usize,
}

impl Transcript {
    fn flush_deferred(&mut self) {
        if self.pending_tools.is_empty() {
            self.entries.append(&mut self.deferred);
        }
    }

    fn settle(&mut self) {
        if let Some((index, _)) = self.open.take() {
            if self.entries[index].records.is_empty() {
                self.entries.remove(index);
            }
        }
        self.pending_tools.clear();
        self.flush_deferred();
    }

    fn reset_open(&mut self) {
        self.open = None;
        self.pending_tools.clear();
        self.deferred.clear();
    }

    fn add(&mut self, record: &Value, reference: RecordRef) {
        match record["type"].as_str().unwrap_or_default() {
            "context.append_message" => {
                let entry = Entry::message(record, reference);
                if self.pending_tools.is_empty() {
                    self.entries.push(entry);
                } else {
                    self.deferred.push(entry);
                }
            }
            "context.append_loop_event" => {
                let event = &record["event"];
                match event["type"].as_str().unwrap_or_default() {
                    "step.begin" => {
                        self.settle();
                        self.open = Some((
                            self.entries.len(),
                            event["uuid"].as_str().unwrap_or_default().into(),
                        ));
                        self.entries.push(Entry::default());
                    }
                    "content.part" | "tool.call" => {
                        if let Some((index, uuid)) = &self.open {
                            if event["stepUuid"].as_str() == Some(uuid.as_str()) {
                                self.entries[*index].records.push(reference);
                                if event["type"] == "tool.call" {
                                    if let Some(id) = event["toolCallId"].as_str() {
                                        self.pending_tools.insert(id.into());
                                    }
                                }
                            }
                        }
                    }
                    "tool.result" => {
                        if event["toolCallId"]
                            .as_str()
                            .is_some_and(|id| self.pending_tools.remove(id))
                        {
                            self.entries.push(Entry {
                                records: vec![reference],
                                ..Entry::default()
                            });
                            self.flush_deferred();
                        }
                    }
                    "step.end"
                        if !matches!(
                            event["finishReason"].as_str(),
                            Some("interrupted" | "error")
                        ) =>
                    {
                        self.settle()
                    }
                    _ => {}
                }
            }
            "context.apply_compaction" => {
                if record["keptUserMessageCount"].is_number() {
                    self.settle();
                } else {
                    self.reset_open();
                }
                // 与官方转录一致：压缩不抹去历史，摘要同时是撤回边界。
                self.entries.push(Entry {
                    records: vec![reference],
                    origin: "compaction_summary".into(),
                    ..Entry::default()
                });
            }
            "context.clear" => {
                self.clear_floor = self.entries.len();
                self.reset_open();
            }
            "context.undo" => {
                let mut count = record["count"].as_u64().unwrap_or_default();
                let mut index = self.entries.len();
                while count > 0 && index > self.clear_floor {
                    index -= 1;
                    let entry = &self.entries[index];
                    if entry.origin == "compaction_summary" {
                        break;
                    }
                    if entry.origin == "injection" {
                        continue;
                    }
                    let entry = self.entries.remove(index);
                    if entry.anchor {
                        count -= 1;
                        while index > self.clear_floor
                            && !entry.id.is_empty()
                            && self.entries[index - 1].origin == "injection"
                            && self.entries[index - 1].owner == entry.id
                        {
                            index -= 1;
                            self.entries.remove(index);
                        }
                    }
                }
                self.reset_open();
            }
            _ => {}
        }
    }
}

fn timestamp(record: &Value) -> String {
    record["time"]
        .as_i64()
        .and_then(super::super::timestamp_from_millis)
        .unwrap_or_default()
}

fn tool_result(payload: &Value, timestamp: &str) -> Value {
    let text = input_text(&payload["output"]);
    let mut message = message_value("tool", &text, timestamp, "kimi_wire", "tool_result", false);
    message["tool_name"] = json!("tool_result");
    message["tool_kind"] = json!("tool_result");
    message["tool_call_id"] = payload["toolCallId"].clone();
    message["is_error"] = json!(payload["isError"] == true);
    message
}

fn content_parts(parts: &Value, timestamp: &str) -> Vec<Value> {
    parts.as_array().into_iter().flatten().flat_map(|part| {
        envelope_messages(&json!({"timestamp": timestamp, "message": {"type": "ContentPart", "payload": part}}))
    }).collect()
}

fn tool_call(call: &Value, timestamp: &str) -> Vec<Value> {
    envelope_messages(
        &json!({"timestamp": timestamp, "message": {"type": "ToolCall", "payload": call}}),
    )
}

fn messages(record: &Value) -> Vec<Value> {
    let time = timestamp(record);
    match record["type"].as_str().unwrap_or_default() {
        "context.append_message" => {
            let message = &record["message"];
            let role = message["role"].as_str().unwrap_or("unknown");
            match role {
                "assistant" => {
                    let mut result = content_parts(&message["content"], &time);
                    for call in message["toolCalls"].as_array().into_iter().flatten() {
                        result.extend(tool_call(call, &time));
                    }
                    result
                }
                "tool" => vec![tool_result(
                    &json!({"output": message["content"], "toolCallId": message["toolCallId"], "isError": message["isError"]}),
                    &time,
                )],
                "user" | "system" => {
                    let text = input_text(&message["content"]);
                    let synthetic = role == "system"
                        || matches!(
                            message["origin"]["kind"].as_str(),
                            Some("injection" | "compaction_summary")
                        );
                    if text.is_empty() {
                        Vec::new()
                    } else {
                        vec![message_value(
                            role,
                            &text,
                            &time,
                            "kimi_wire",
                            "text",
                            synthetic,
                        )]
                    }
                }
                _ => Vec::new(),
            }
        }
        "context.append_loop_event" => {
            let event = &record["event"];
            match event["type"].as_str().unwrap_or_default() {
                "content.part" => content_parts(&json!([event["part"]]), &time),
                "tool.call" => tool_call(
                    &json!({"id": event["toolCallId"], "name": event["name"], "arguments": event["args"]}),
                    &time,
                ),
                "tool.result" => vec![tool_result(
                    &json!({"output": event["result"]["output"], "toolCallId": event["toolCallId"], "isError": event["result"]["isError"]}),
                    &time,
                )],
                _ => Vec::new(),
            }
        }
        "context.apply_compaction" => {
            let text = record["summary"]
                .as_str()
                .or_else(|| record["contextSummary"].as_str())
                .map(str::to_string)
                .unwrap_or_else(|| input_text(&record["summary"]["content"]));
            vec![message_value(
                "system",
                &text,
                &time,
                "kimi_wire",
                "compaction_summary",
                true,
            )]
        }
        _ => Vec::new(),
    }
}

pub(super) fn parse_wire(
    path: &Path,
    source: &Source,
    collect_detail: bool,
    visitor: &mut dyn FnMut(&Value),
) -> Result<ParsedWire, String> {
    let layout = session_layout(path, source)?;
    let mut collector = MessageCollector::new(path, &layout, collect_detail, visitor);
    let mut events = collect_detail.then(|| HeadTail::new(DETAIL_EVENT_LIMIT));
    let mut transcript = Transcript::default();
    let mut reader = BufReader::new(File::open(path).map_err(error_text)?);
    let mut line = String::new();
    let mut offset = 0;
    let mut line_number = 0;
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
            .map_err(|error| format!("Kimi Wire 第 {line_number} 行：{error}"))?;
        if record["type"] == "metadata" {
            let version = record["protocol_version"].as_str().unwrap_or_default();
            if !matches!(version, "1.0" | "1.1" | "1.2" | "1.3" | "1.4" | "1.5") {
                return Err(format!("尚不支持 Kimi Wire 协议版本 {version}"));
            }
        } else {
            collector.state.event_count += 1;
        }
        let time = timestamp(&record);
        if collector.state.timestamp.is_empty() {
            collector.state.timestamp = time.clone();
        }
        if !time.is_empty() {
            collector.state.last_timestamp = time.clone();
        }
        if record["type"] == "llm.request" {
            if let Some(provider) = record["provider"].as_str() {
                collector.state.provider = provider.into();
            }
        }
        transcript.add(&record, reference);
        if let Some(events) = events.as_mut() {
            let payload = if line.chars().count() > 10_000 {
                json!({"truncated": true, "original_chars": line.chars().count()})
            } else {
                record.clone()
            };
            events.push(json!({"line_number": line_number, "timestamp": time, "type": record["type"], "payload": payload}));
        }
    }
    let mut tool_names = HashMap::<String, String>::new();
    for entry in transcript.entries {
        collector.flush();
        for reference in entry.records {
            reader
                .seek(SeekFrom::Start(reference.offset))
                .map_err(error_text)?;
            line.clear();
            reader.read_line(&mut line).map_err(error_text)?;
            let record: Value = serde_json::from_str(&line).map_err(error_text)?;
            for mut message in messages(&record) {
                if let Some(id) = message["tool_call_id"].as_str().map(str::to_string) {
                    if message["tool_kind"] == "tool_call" {
                        tool_names
                            .insert(id, message["tool_name"].as_str().unwrap_or_default().into());
                    } else if let Some(name) = tool_names.get(&id) {
                        message["tool_name"] = json!(name);
                    }
                }
                collector.push(message, reference.line);
            }
        }
    }
    collector.flush();
    Ok((collector.state, collector.messages, events))
}
