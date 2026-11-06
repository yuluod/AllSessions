//! JetBrains Air（IDE 内 ACP 线程）事件日志的只读回放；只保存事件位置，
//! 不缓存完整会话正文。线程目录为
//! `<JetBrains>/<产品>/acp/projects/<项目哈希>/threads/<URL 编码线程 id>/`，
//! 其中 `events.jsonl` 是追加式事件流，`summary.json` 保存展示元数据，
//! `attachments/` 存放提示词图片附件副本。

use std::{
    collections::{BTreeSet, HashMap},
    fs::File,
    io::{BufRead, BufReader, Seek, SeekFrom},
    path::{Path, PathBuf},
};

use serde_json::{Value, json};
use walkdir::WalkDir;

use super::usage::TokenUsage;
use super::{
    DETAIL_EVENT_LIMIT, DETAIL_MESSAGE_LIMIT, HeadTail, ParseState, Source, append_limited,
    attach_message_key, compact_title, error_text, json_fingerprint, message_value, mixed_stamp,
    summary_search_text, timestamp_from_millis, truncate_message,
};

/// 事件文件与相邻元数据的复合指纹：展示标题存于 `summary.json`，
/// cwd 回退存于项目级 `store.json`，一并纳入指纹，元数据变化后
/// 不会命中旧摘要。
pub(super) fn cache_stamp(path: &Path) -> (i64, i64) {
    let mut paths = vec![path.to_path_buf()];
    if let Some(directory) = path.parent() {
        paths.push(directory.join("summary.json"));
    }
    if let Some(project) = path
        .parent()
        .and_then(|thread| thread.parent())
        .and_then(|threads| threads.parent())
    {
        paths.push(project.join("store.json"));
    }
    mixed_stamp(&paths)
}

/// `acp` 根（或已指向 `projects` 的根）下存放项目子目录的层。
pub(super) fn projects_root(root: &Path) -> PathBuf {
    if root.file_name().and_then(|s| s.to_str()) == Some("projects") {
        root.into()
    } else {
        root.join("projects")
    }
}

/// `<projects>/<项目哈希>/threads/<编码线程 id>/events.jsonl`。
pub(super) fn matches_path(root: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(projects_root(root)) else {
        return false;
    };
    let parts: Vec<_> = relative.components().collect();
    parts.len() == 4
        && parts
            .iter()
            .all(|part| matches!(part, std::path::Component::Normal(_)))
        && parts[1].as_os_str() == "threads"
        && parts[3].as_os_str() == "events.jsonl"
}

pub(super) fn discover_files(source: &Source) -> Vec<PathBuf> {
    let mut files = WalkDir::new(projects_root(&source.root))
        .max_depth(4)
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
    let root = projects_root(&source.root);
    let relative = path.strip_prefix(&root).map_err(error_text)?;
    if !matches_path(&source.root, path) {
        return Err("JetBrains Air 会话路径无效".into());
    }
    let mut current = root;
    for component in relative.components() {
        if !matches!(component, std::path::Component::Normal(_)) {
            return Err("JetBrains Air 会话路径无效".into());
        }
        current.push(component);
        if std::fs::symlink_metadata(&current)
            .map_err(error_text)?
            .file_type()
            .is_symlink()
        {
            return Err("JetBrains Air 会话路径不能包含符号链接".into());
        }
    }
    Ok(())
}

/// 线程相邻的 `summary.json`：schemaVersion 10 元数据（标题、agent 绑定）。
fn metadata(path: &Path) -> Result<Value, String> {
    let meta_path = path
        .parent()
        .ok_or("JetBrains Air 会话路径无效")?
        .join("summary.json");
    match std::fs::symlink_metadata(&meta_path) {
        Ok(meta) if meta.file_type().is_symlink() => {
            return Err("JetBrains Air 元数据不能是符号链接".into());
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Value::Null),
        Err(error) => return Err(error_text(error)),
        _ => {}
    }
    serde_json::from_reader(File::open(meta_path).map_err(error_text)?).map_err(error_text)
}

/// 项目级 `store.json`（`{"projectDirectory": ...}`），cwd 缺失时的回退。
/// 与 summary.json 一致拒绝符号链接，避免越出声明目录读取；本回退是
/// 尽力而为，任何读取失败都返回空串。
fn store_project_dir(path: &Path) -> String {
    let Some(store_path) = path
        .parent()
        .and_then(|thread| thread.parent())
        .and_then(|threads| threads.parent())
        .map(|project| project.join("store.json"))
    else {
        return String::new();
    };
    match std::fs::symlink_metadata(&store_path) {
        Ok(meta) if !meta.file_type().is_symlink() => {}
        _ => return String::new(),
    }
    let Ok(file) = File::open(store_path) else {
        return String::new();
    };
    serde_json::from_reader::<_, Value>(file)
        .ok()
        .and_then(|store| store["projectDirectory"].as_str().map(str::to_string))
        .unwrap_or_default()
}

/// 两个 ASCII 十六进制字符解码为一个字节；非 ASCII 直接失败，
/// 全部走字节运算，不做字符边界敏感的 str 切片。
fn hex_byte(pair: &[u8]) -> Option<u8> {
    u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok()
}

/// 线程目录名是 URL 编码的线程 id（`acp%3Ae841b4e3` → `acp:e841b4e3`）。
fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%'
            && index + 2 < bytes.len()
            && let Some(value) = hex_byte(&bytes[index + 1..index + 3])
        {
            decoded.push(value);
            index += 3;
            continue;
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

/// `acp.dynamic.<hex>` / `acp.v1.<hex>` 的 hex 段解码出 registry id
/// （如 `acp.registry.devin`）；解码失败时保留原串。
fn decode_agent_id(agent_id: &str) -> String {
    let Some(hex) = agent_id
        .strip_prefix("acp.dynamic.")
        .or_else(|| agent_id.strip_prefix("acp.v1."))
    else {
        return agent_id.to_string();
    };
    let (pairs, _) = hex.as_bytes().as_chunks::<2>();
    let bytes: Option<Vec<u8>> = pairs.iter().map(|pair| hex_byte(pair)).collect();
    bytes
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| agent_id.to_string())
}

/// 工具统计名归一：`exec-<uuid>`、`call_<32 位 hex>` 这类无冒号
/// toolCallId 逐段剥掉尾部的长十六进制随机段，得到稳定的工具名；
/// `exec:3` 的冒号前缀与 `get_output` 这类含非十六进制词的分隔名
/// 保持原样。至少保留一段，全十六进制的短词 id 不受影响。
fn stable_tool_prefix(segment: &str) -> &str {
    let mut current = segment;
    while let Some((head, tail)) = current.rsplit_once(['-', '_']) {
        let is_hash =
            (4..=32).contains(&tail.len()) && tail.bytes().all(|byte| byte.is_ascii_hexdigit());
        if !is_hash {
            break;
        }
        current = head;
    }
    current
}

fn timestamp(record: &Value) -> String {
    record["timestamp"]
        .as_i64()
        .and_then(timestamp_from_millis)
        .unwrap_or_default()
}

#[derive(Clone, Copy)]
struct RecordRef {
    offset: u64,
    line: usize,
}

fn read_record(reader: &mut BufReader<File>, reference: RecordRef) -> Result<Value, String> {
    reader
        .seek(SeekFrom::Start(reference.offset))
        .map_err(error_text)?;
    let mut line = String::new();
    reader.read_line(&mut line).map_err(error_text)?;
    serde_json::from_str(&line)
        .map_err(|error| format!("JetBrains Air 事件日志第 {} 行：{error}", reference.line))
}

struct Entry {
    tag: &'static str,
    /// chunk 条目按 payload.role 区分正文/思考。
    chunk_role: String,
    /// 同一轮次内的流式片段按 turnId 归并。
    turn_id: String,
    /// 用户消息/重试请求按 messageId 归并与去重。
    message_id: String,
    records: Vec<RecordRef>,
}

impl Entry {
    fn new(tag: &'static str, record: &Value, reference: RecordRef) -> Self {
        let payload = &record["payload"];
        Self {
            tag,
            chunk_role: payload["role"].as_str().unwrap_or_default().into(),
            turn_id: record["turnId"].as_str().unwrap_or_default().into(),
            message_id: payload["messageId"]
                .as_str()
                .or_else(|| payload["request"]["messageId"].as_str())
                .unwrap_or_default()
                .into(),
            records: vec![reference],
        }
    }
}

/// 不产生会话内容的元信息事件；它们不断开正在合并的流式正文。
const NOISE_TYPES: [&str; 8] = [
    "TelemetryIdAssigned",
    "RuntimeSessionBound",
    "ThreadWaiting",
    "ThreadPublished",
    "TurnEnded",
    "ConfigOptionUpdated",
    "AvailableCommandsUpdated",
    "UsageUpdated",
];

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
        return match output {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        };
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

/// contextItems / explicitContextItems 中的图片项定位到记录内路径。
/// 只认复制到线程 `attachments/` 下的副本（`storagePath`），原路径不外读。
fn context_attachments(
    record: &Value,
    reference: RecordRef,
    items: Option<&Vec<Value>>,
    base: &[&str],
) -> (Vec<Value>, Vec<String>) {
    let mut attachments = Vec::new();
    let mut notes = Vec::new();
    let Some(items) = items else {
        return (attachments, notes);
    };
    let fingerprint = json_fingerprint(record);
    for (index, item) in items.iter().enumerate() {
        let payload = &item["payload"];
        let mime = payload["mimeType"].as_str().unwrap_or_default();
        let is_image = payload["type"].as_str() == Some("screenshot")
            || (!mime.is_empty() && mime.starts_with("image/"));
        if is_image {
            let mut path: Vec<Value> = base.iter().map(|key| json!(key)).collect();
            path.push(json!(index));
            path.push(json!("payload"));
            attachments.push(json!({
                "kind": "image",
                "locator": {
                    "path": path,
                    "line_number": reference.line,
                    "record_fingerprint": fingerprint,
                },
            }));
            continue;
        }
        // 非图片上下文（IDE 选区、文件列表等）以原文附加，进入正文与搜索。
        let body = item["body"].as_str().unwrap_or_default();
        if !body.trim().is_empty() {
            let title = item["title"].as_str().unwrap_or_default();
            notes.push(if title.is_empty() {
                body.to_string()
            } else {
                format!("{title}\n{body}")
            });
        }
    }
    (attachments, notes)
}

fn user_message(
    text: String,
    text_chars: usize,
    time: &str,
    attachments: Vec<Value>,
    notes: Vec<String>,
) -> Option<Value> {
    let mut text = text;
    for _ in &attachments {
        text.push_str("\n[image]");
    }
    for note in notes {
        if !text.is_empty() {
            text.push_str("\n\n");
        }
        text.push_str(&note);
    }
    if text.trim().is_empty() && attachments.is_empty() {
        return None;
    }
    let mut message = message_value("user", &text, time, "jetbrains_air", "text", false);
    if !attachments.is_empty() {
        message["attachments"] = Value::Array(attachments);
    }
    if text_chars > text.chars().count() {
        message["text_truncated"] = json!(true);
        message["original_text_chars"] = json!(text_chars);
    }
    Some(message)
}

fn entry_messages(
    reader: &mut BufReader<File>,
    entry: &Entry,
    seen_user_ids: &BTreeSet<String>,
) -> Result<Vec<Value>, String> {
    let mut text = String::new();
    let mut text_chars = 0;
    let mut time = String::new();
    let mut attachments = Vec::new();
    let mut notes = Vec::new();
    let mut tool = json!({});
    for reference in &entry.records {
        let record = read_record(reader, *reference)?;
        if time.is_empty() {
            time = timestamp(&record);
        }
        let payload = &record["payload"];
        match entry.tag {
            "tool" => {
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
                    if let Some(value) = payload.get(key) {
                        tool[key] = value.clone();
                    }
                }
            }
            "user" => {
                let delta = payload["contentDelta"].as_str().unwrap_or_default();
                text_chars += delta.chars().count();
                let remaining = super::SEARCH_TEXT_LIMIT.saturating_sub(text.len());
                let mut end = delta.len().min(remaining);
                while !delta.is_char_boundary(end) {
                    end -= 1;
                }
                text.push_str(&delta[..end]);
                let (images, mut extra) = context_attachments(
                    &record,
                    *reference,
                    payload["contextItems"].as_array(),
                    &["payload", "contextItems"],
                );
                attachments.extend(images);
                notes.append(&mut extra);
                // 无 contextItems 时 attachments 数组是同一份上下文的摘要，
                // 只补可读文本（不含附件副本路径，图片无法定位）。
                if payload["contextItems"].as_array().is_none()
                    && let Some(items) = payload["attachments"].as_array()
                {
                    for item in items {
                        let body = item["body"].as_str().unwrap_or_default();
                        if !body.trim().is_empty() {
                            let title = item["title"]
                                .as_str()
                                .or_else(|| item["name"].as_str())
                                .unwrap_or_default();
                            notes.push(if title.is_empty() {
                                body.to_string()
                            } else {
                                format!("{title}\n{body}")
                            });
                        }
                    }
                }
            }
            "retry" => {
                let request = &payload["request"];
                if text.is_empty() {
                    text = request["text"].as_str().unwrap_or_default().to_string();
                    text_chars = text.chars().count();
                }
                let (images, mut extra) = context_attachments(
                    &record,
                    *reference,
                    request["explicitContextItems"].as_array(),
                    &["payload", "request", "explicitContextItems"],
                );
                attachments.extend(images);
                notes.append(&mut extra);
            }
            "chunk" => {
                let delta = payload["contentDelta"].as_str().unwrap_or_default();
                text_chars += delta.chars().count();
                let remaining = super::SEARCH_TEXT_LIMIT.saturating_sub(text.len());
                let mut end = delta.len().min(remaining);
                while !delta.is_char_boundary(end) {
                    end -= 1;
                }
                text.push_str(&delta[..end]);
            }
            "plan" | "error" => {
                // 由调用方按条目类型单独处理。
            }
            _ => {}
        }
    }
    match entry.tag {
        "tool" => {
            let title = tool["title"].as_str().unwrap_or_default();
            let id = tool["toolCallId"].as_str().unwrap_or_default();
            // 工具统计名归一到 toolCallId 前缀（exec/read/edit，随机后缀
            // 一并剥除），title 仅展示。
            let name = id
                .split(':')
                .next()
                .filter(|prefix| !prefix.is_empty())
                .map(stable_tool_prefix)
                .filter(|prefix| !prefix.is_empty())
                .or_else(|| tool["kind"].as_str())
                .unwrap_or("tool");
            let input = tool["rawInput"].to_string();
            let input = if input == "null" {
                String::new()
            } else {
                input
            };
            let label = if title.is_empty() { name } else { title };
            let mut call = message_value(
                "tool",
                format!("[{label}] {input}").trim(),
                &time,
                "jetbrains_air",
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
                    "jetbrains_air",
                    "tool_result",
                    false,
                );
                result["tool_name"] = json!(name);
                result["tool_kind"] = json!("tool_result");
                result["tool_call_id"] = json!(id);
                result["is_error"] = json!(tool["status"] == "failed");
                messages.push(result);
            }
            Ok(messages)
        }
        "user" => Ok(user_message(text, text_chars, &time, attachments, notes)
            .into_iter()
            .collect()),
        "retry" => {
            // 重试请求在 PromptRetryRequestUpdated 里携带完整正文；同一
            // messageId 已有 MessageDelta 时不重复产出。
            if !entry.message_id.is_empty() && seen_user_ids.contains(&entry.message_id) {
                return Ok(Vec::new());
            }
            Ok(user_message(text, text_chars, &time, attachments, notes)
                .into_iter()
                .collect())
        }
        "chunk" => {
            let (subtype, synthetic) = match entry.chunk_role.as_str() {
                "Runtime" => ("thinking", true),
                _ => ("text", false),
            };
            Ok((!text.trim().is_empty())
                .then(|| {
                    let mut message = message_value(
                        "assistant",
                        &text,
                        &time,
                        "jetbrains_air",
                        subtype,
                        synthetic,
                    );
                    if text_chars > text.chars().count() {
                        message["text_truncated"] = json!(true);
                        message["original_text_chars"] = json!(text_chars);
                    }
                    message
                })
                .into_iter()
                .collect())
        }
        "plan" => {
            let Some(reference) = entry.records.last() else {
                return Ok(Vec::new());
            };
            let record = read_record(reader, *reference)?;
            let entries = record["payload"]["entries"].as_array();
            let text = entries
                .into_iter()
                .flatten()
                .filter_map(|item| {
                    let content = item["content"].as_str().unwrap_or_default();
                    if content.trim().is_empty() {
                        return None;
                    }
                    let status = item["status"].as_str().unwrap_or_default();
                    Some(if status.is_empty() {
                        format!("- {content}")
                    } else {
                        format!("- [{status}] {content}")
                    })
                })
                .collect::<Vec<_>>()
                .join("\n");
            Ok((!text.is_empty())
                .then(|| message_value("assistant", &text, &time, "jetbrains_air", "plan", false))
                .into_iter()
                .collect())
        }
        "error" => {
            let Some(reference) = entry.records.first() else {
                return Ok(Vec::new());
            };
            let record = read_record(reader, *reference)?;
            let payload = &record["payload"];
            let text = [
                payload["title"].as_str(),
                payload["message"].as_str(),
                payload["details"].as_str(),
            ]
            .into_iter()
            .flatten()
            .filter(|part| !part.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n");
            Ok((!text.is_empty())
                .then(|| {
                    let mut message =
                        message_value("assistant", &text, &time, "jetbrains_air", "error", true);
                    message["is_error"] = json!(true);
                    message
                })
                .into_iter()
                .collect())
        }
        _ => Ok(Vec::new()),
    }
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
    // `_key` 以「项目哈希/线程 id」保证跨产品目录唯一；线程 id 取自
    // 目录名解码，事件里的 threadId 字段一致时以事件为准。
    let thread_dir = path.parent().and_then(|dir| dir.file_name());
    let project_dir = path
        .parent()
        .and_then(|thread| thread.parent())
        .and_then(|threads| threads.parent())
        .and_then(|project| project.file_name())
        .and_then(|name| name.to_str())
        .unwrap_or("unknown");
    let mut thread_id = thread_dir
        .and_then(|name| name.to_str())
        .map(percent_decode)
        .unwrap_or_else(|| "unknown".into());
    let mut title = String::new();
    let mut model = String::new();
    let mut agent_session_id = String::new();
    let mut runtime_kind = String::new();
    let mut reader = BufReader::new(File::open(path).map_err(error_text)?);
    let mut entries: Vec<Entry> = Vec::new();
    let mut tools = HashMap::<String, usize>::new();
    let mut deltas = HashMap::<String, usize>::new();
    let mut retries = HashMap::<String, usize>::new();
    let mut seen_user_ids = BTreeSet::<String>::new();
    let mut plan_index: Option<usize> = None;
    let mut chunk: Option<usize> = None;
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
            .map_err(|error| format!("JetBrains Air 事件日志第 {line_number} 行：{error}"))?;
        state.event_count += 1;
        let time = timestamp(&record);
        if state.timestamp.is_empty() {
            state.timestamp = time.clone();
        }
        if time > state.last_timestamp {
            state.last_timestamp = time.clone();
        }
        let tag = record["type"].as_str().unwrap_or_default();
        if let Some(events) = events.as_mut() {
            events.push(json!({"line_number": line_number, "timestamp": time, "type": tag,
                "payload": if line.chars().count() > 10_000 { json!({"truncated":true,"original_chars":line.chars().count()}) } else { record.clone() }}));
        }
        if let Some(id) = record["threadId"].as_str().filter(|id| !id.is_empty())
            && thread_id == "unknown"
        {
            thread_id = id.to_string();
        }
        match tag {
            "MessageDelta" => {
                let id = record["payload"]["messageId"].as_str().unwrap_or_default();
                if !id.is_empty() {
                    seen_user_ids.insert(id.to_string());
                }
                chunk = None;
                match deltas.get(id) {
                    Some(index) => entries[*index].records.push(reference),
                    None => {
                        deltas.insert(id.into(), entries.len());
                        entries.push(Entry::new("user", &record, reference));
                    }
                }
            }
            "MessageCompleted" => {
                let id = record["payload"]["messageId"].as_str().unwrap_or_default();
                if !id.is_empty() {
                    seen_user_ids.insert(id.to_string());
                }
                chunk = None;
            }
            "MessageChunk" => {
                let role = record["payload"]["role"].as_str().unwrap_or_default();
                let turn = record["turnId"].as_str().unwrap_or_default();
                let index = chunk.filter(|index| {
                    entries[*index].tag == "chunk"
                        && entries[*index].chunk_role == role
                        && entries[*index].turn_id == turn
                });
                if let Some(index) = index {
                    entries[index].records.push(reference);
                } else {
                    chunk = Some(entries.len());
                    entries.push(Entry::new("chunk", &record, reference));
                }
            }
            "ToolCallUpdated" => {
                chunk = None;
                let id = record["payload"]["toolCallId"].as_str().unwrap_or_default();
                match tools.get(id) {
                    Some(index) => entries[*index].records.push(reference),
                    None => {
                        tools.insert(id.into(), entries.len());
                        entries.push(Entry::new("tool", &record, reference));
                    }
                }
            }
            "PromptRetryRequestUpdated" => {
                chunk = None;
                let id = record["payload"]["request"]["messageId"]
                    .as_str()
                    .unwrap_or_default();
                match retries.get(id) {
                    Some(index) => entries[*index].records.push(reference),
                    None => {
                        retries.insert(id.into(), entries.len());
                        entries.push(Entry::new("retry", &record, reference));
                    }
                }
            }
            "PlanUpdated" => {
                chunk = None;
                match plan_index {
                    Some(index) => entries[index].records.push(reference),
                    None => {
                        plan_index = Some(entries.len());
                        entries.push(Entry::new("plan", &record, reference));
                    }
                }
            }
            "ThreadFailed" | "ThreadDisconnected" => {
                chunk = None;
                let payload = &record["payload"];
                if tag == "ThreadFailed"
                    || payload["title"].as_str().is_some_and(|v| !v.is_empty())
                    || payload["message"].as_str().is_some_and(|v| !v.is_empty())
                {
                    entries.push(Entry::new("error", &record, reference));
                }
            }
            "ThreadCreated" => {
                chunk = None;
                let payload = &record["payload"];
                if let Some(cwd) = payload["cwd"].as_str() {
                    state.cwd = cwd.into();
                }
                if let Some(kind) = payload["runtimeKind"].as_str() {
                    runtime_kind = kind.into();
                }
                if let Some(agent) = payload["agentId"].as_str() {
                    state.originator = decode_agent_id(agent);
                }
            }
            "RuntimeSessionBound" => {
                let payload = &record["payload"];
                if let Some(cwd) = payload["cwd"].as_str()
                    && state.cwd.is_empty()
                {
                    state.cwd = cwd.into();
                }
                if let Some(id) = payload["agentSessionId"].as_str() {
                    agent_session_id = id.into();
                }
            }
            "ThreadUpdated" => {
                chunk = None;
                if let Some(value) = record["payload"]["title"]
                    .as_str()
                    .filter(|value| !value.trim().is_empty())
                {
                    title = value.to_string();
                }
            }
            "ConfigOptionUpdated" => {
                if let Some(option) = record["payload"]["configOptions"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .find(|option| option["configOptionId"].as_str() == Some("model"))
                    && let Some(value) = option["value"].as_str()
                {
                    model = value.into();
                }
            }
            "PromptTurnFinished" => {
                let payload = &record["payload"];
                state.record_usage(
                    &time,
                    TokenUsage {
                        input: payload["inputTokens"].as_u64().unwrap_or_default(),
                        output: payload["outputTokens"].as_u64().unwrap_or_default(),
                        cache_read: payload["cacheReadTokens"].as_u64().unwrap_or_default(),
                        cache_write: payload["cacheWriteTokens"].as_u64().unwrap_or_default(),
                    },
                    &model,
                );
                chunk = None;
            }
            _ => {
                if !NOISE_TYPES.contains(&tag) {
                    chunk = None;
                }
            }
        }
    }
    state.id = format!("{project_dir}/{thread_id}");
    if state.cwd.is_empty() {
        state.cwd = store_project_dir(path);
    }
    let mut messages = HeadTail::new(DETAIL_MESSAGE_LIMIT);
    let mut sequence = 0;
    for entry in &entries {
        for message in entry_messages(&mut reader, entry, &seen_user_ids)? {
            // accept_message 返回带 command_name/file_activity/file_edit 标注的
            // 归一化副本，详情与 visitor 必须使用它；None 表示重复消息被去重。
            let Some(mut message) = state.accept_message(message) else {
                continue;
            };
            if detail {
                attach_message_key(
                    &mut message,
                    json!({"kind":"jetbrains_air", "message_index":sequence}),
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
    let title = [
        meta["displayTitle"].as_str(),
        meta["automaticTitle"].as_str(),
        Some(title.as_str()),
    ]
    .into_iter()
    .flatten()
    .find(|value| !value.trim().is_empty());
    if let Some(title) = title {
        summary["title"] = json!(compact_title(title, 90));
    }
    if !model.is_empty() {
        summary["model"] = json!(model);
    }
    if !agent_session_id.is_empty() {
        summary["agent_session_id"] = json!(agent_session_id);
    }
    if !runtime_kind.is_empty() {
        summary["runtime_kind"] = json!(runtime_kind);
    }
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
        json!({"summary":summary,"usage_events": state.usage.events, "usage_event_count": state.usage.event_count, "conversation_messages":messages,"raw_events":events,
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

/// 详情里记录的是线程 `attachments/` 副本的绝对路径；回读时重新解析
/// 记录行、校验指纹，再把 storagePath 约束在该线程附件目录内。
pub(super) fn read_attachment(
    path: &Path,
    _source: &Source,
    request: &Value,
) -> Result<Value, String> {
    let line_number = request["line_number"]
        .as_u64()
        .filter(|value| *value > 0)
        .ok_or_else(|| "图片定位信息无效".to_string())?;
    let file = File::open(path).map_err(|error| format!("读取会话文件失败：{error}"))?;
    let mut found = None;
    for (index, line) in BufReader::new(file).lines().enumerate() {
        if index as u64 + 1 == line_number {
            found = Some(line.map_err(|error| format!("读取会话记录失败：{error}"))?);
            break;
        }
    }
    let line = found.ok_or_else(|| "图片所在记录已不存在，请刷新会话".to_string())?;
    let record: Value =
        serde_json::from_str(&line).map_err(|error| format!("会话记录解析失败：{error}"))?;
    if Some(json_fingerprint(&record).as_str()) != request["record_fingerprint"].as_str() {
        return Err("会话内容已变化，请刷新后重试".into());
    }
    let block = super::attachment::value_at_path(&record, &request["path"])?;
    let storage = block["storagePath"]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "该附件没有可用的副本".to_string())?;
    let attachments_dir = path
        .parent()
        .ok_or_else(|| "JetBrains Air 会话路径无效".to_string())?
        .join("attachments");
    let root = std::fs::canonicalize(&attachments_dir)
        .map_err(|error| format!("附件目录不可用：{error}"))?;
    let target =
        std::fs::canonicalize(storage).map_err(|error| format!("附件副本不可读：{error}"))?;
    if !target.starts_with(&root) {
        return Err("附件路径超出会话目录".into());
    }
    super::attachment::image_value_from_path(
        &target,
        super::attachment::MAX_IMAGE_BYTES,
        block["mimeType"].as_str(),
    )
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::path::Path;

    use serde_json::json;
    use tempfile::tempdir;

    use super::{
        decode_agent_id, discover_files, matches_path, parse_detail, parse_summary, percent_decode,
        read_attachment,
    };
    use crate::sessions::{Source, SourceFormat};

    fn source(root: &Path) -> Source {
        Source {
            kind: "jetbrains_air",
            display_name: "JetBrains Air",
            root: root.into(),
            format: SourceFormat::JetBrainsAir,
            archived: false,
        }
    }

    fn write_thread(
        acp: &Path,
        project: &str,
        thread: &str,
        records: &[serde_json::Value],
    ) -> std::path::PathBuf {
        let dir = acp
            .join("projects")
            .join(project)
            .join("threads")
            .join(thread);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("events.jsonl");
        let mut file = std::fs::File::create(&path).unwrap();
        for record in records {
            writeln!(file, "{record}").unwrap();
        }
        path
    }

    fn event(
        seq: u64,
        thread: &str,
        source: &str,
        tag: &str,
        payload: serde_json::Value,
    ) -> serde_json::Value {
        json!({
            "id": format!("{thread}#{seq}"),
            "threadId": thread,
            "seq": seq,
            "timestamp": 1_793_879_600_000_i64 + seq as i64,
            "source": source,
            "type": tag,
            "payload": payload,
            "version": 1,
        })
    }

    #[test]
    fn 线程目录名做百分号解码() {
        assert_eq!(percent_decode("acp%3Ae841b4e3"), "acp:e841b4e3");
        assert_eq!(percent_decode("plain"), "plain");
        // 非 ASCII 与残缺编码不 panic、原样保留。
        assert_eq!(percent_decode("%é"), "%é");
        assert_eq!(percent_decode("acp%草稿"), "acp%草稿");
        assert_eq!(percent_decode("acp%"), "acp%");
        assert_eq!(percent_decode("acp%3"), "acp%3");
        assert_eq!(percent_decode("%zz"), "%zz");
    }

    #[test]
    fn agent_id_hex_解码出_registry_id() {
        assert_eq!(
            decode_agent_id("acp.dynamic.6163702e72656769737472792e646576696e"),
            "acp.registry.devin"
        );
        assert_eq!(decode_agent_id("custom-agent"), "custom-agent");
        // 非 ASCII 与非法 hex 不 panic、原样保留。
        assert_eq!(decode_agent_id("acp.dynamic.4é"), "acp.dynamic.4é");
        assert_eq!(decode_agent_id("acp.dynamic.中文"), "acp.dynamic.中文");
        assert_eq!(decode_agent_id("acp.dynamic.zz"), "acp.dynamic.zz");
    }

    #[test]
    fn 工具统计名剥除随机后缀() {
        use super::stable_tool_prefix;
        // ACP 代理的 uuid 后缀与内置助手的 hex 后缀各归一到工具名。
        assert_eq!(
            stable_tool_prefix("exec-46cf3aed-7983-47c0-a0d7-107edb76f64c"),
            "exec"
        );
        assert_eq!(
            stable_tool_prefix("call_c7ca01fa94804567977c0f0490ebbe28"),
            "call"
        );
        // 冒号前缀格式（由调用方先行 split）与含非十六进制词的分隔名原样保留。
        assert_eq!(stable_tool_prefix("get_output"), "get_output");
        assert_eq!(stable_tool_prefix("edit"), "edit");
        // 短于 4 位或含非十六进制字符的尾段不剥，避免误伤普通命名。
        assert_eq!(stable_tool_prefix("my-tool"), "my-tool");
        assert_eq!(stable_tool_prefix("run-ab"), "run-ab");
    }

    #[test]
    fn 发现与匹配只认线程事件文件() {
        let directory = tempdir().unwrap();
        let acp = directory.path().join("IntelliJIdea2026.3/acp");
        let path = write_thread(&acp, "8bf5402b", "acp%3Ae841b4e3", &[]);
        let source = source(&acp);
        assert_eq!(discover_files(&source), vec![path.clone()]);
        assert!(matches_path(&source.root, &path));
        assert!(!matches_path(
            &source.root,
            &acp.join("projects/8bf5402b/store.json")
        ));
        assert!(!matches_path(&source.root, &acp.join("air/process.log")));
    }

    #[test]
    fn 摘要归并线程元数据与用量() {
        let directory = tempdir().unwrap();
        let acp = directory.path().join("acp");
        let thread = "acp%3At1";
        let path = write_thread(
            &acp,
            "proj1",
            thread,
            &[
                event(
                    0,
                    "acp:t1",
                    "Runtime",
                    "ThreadCreated",
                    json!({
                        "title": "Devin", "runtimeKind": "Acp",
                        "agentId": "acp.dynamic.6163702e72656769737472792e646576696e",
                        "cwd": "C:/work/demo",
                    }),
                ),
                event(
                    1,
                    "acp:t1",
                    "Runtime",
                    "RuntimeSessionBound",
                    json!({
                        "runtimeKind": "Acp", "agentSessionId": "thundering-plane",
                    }),
                ),
                event(
                    2,
                    "acp:t1",
                    "User",
                    "MessageDelta",
                    json!({
                        "messageId": "user-1", "role": "User", "contentDelta": "更新仓库",
                    }),
                ),
                event(
                    3,
                    "acp:t1",
                    "User",
                    "MessageCompleted",
                    json!({"messageId": "user-1"}),
                ),
                event(
                    4,
                    "acp:t1",
                    "Runtime",
                    "ThreadUpdated",
                    json!({"title": "更新仓库"}),
                ),
                event(
                    5,
                    "acp:t1",
                    "Agent",
                    "MessageChunk",
                    json!({
                        "role": "Agent", "contentDelta": "好的，",
                    }),
                ),
                event(
                    6,
                    "acp:t1",
                    "Agent",
                    "MessageChunk",
                    json!({
                        "role": "Agent", "contentDelta": "我先看下状态",
                    }),
                ),
                event(
                    7,
                    "acp:t1",
                    "Agent",
                    "UsageUpdated",
                    json!({
                        "totalTokens": 100, "contextWindow": 262000,
                    }),
                ),
                event(
                    8,
                    "acp:t1",
                    "Agent",
                    "MessageChunk",
                    json!({
                        "role": "Runtime", "contentDelta": "内部推理",
                    }),
                ),
                event(
                    9,
                    "acp:t1",
                    "Agent",
                    "ToolCallUpdated",
                    json!({
                        "toolCallId": "exec:0#abc", "start": true, "kind": "execute",
                        "title": "Ran git", "rawInput": {"command": "git status"},
                    }),
                ),
                event(
                    10,
                    "acp:t1",
                    "Agent",
                    "ToolCallUpdated",
                    json!({
                        "toolCallId": "exec:0#abc", "status": "completed",
                        "content": [{"type":"content","content":{"type":"resource",
                            "resource": {"text": "clean", "uri": "tool://out"}}}],
                    }),
                ),
                event(
                    11,
                    "acp:t1",
                    "Agent",
                    "PromptTurnFinished",
                    json!({
                        "outcome": "SUCCESS", "inputTokens": 10, "outputTokens": 5,
                        "cacheReadTokens": 3, "cacheWriteTokens": 0,
                    }),
                ),
            ],
        );
        let (summary, search) = parse_summary(&path, &source(&acp)).unwrap();
        assert_eq!(summary["id"], "proj1/acp:t1");
        assert_eq!(summary["_key"], "jetbrains_air:proj1/acp:t1");
        assert_eq!(summary["title"], "更新仓库");
        assert_eq!(summary["cwd"], "C:/work/demo");
        assert_eq!(summary["originator"], "acp.registry.devin");
        assert_eq!(summary["agent_session_id"], "thundering-plane");
        assert_eq!(summary["runtime_kind"], "Acp");
        assert_eq!(summary["source_read_only"], true);
        assert_eq!(summary["message_count"], 4); // user + assistant + tool_call + tool_result
        assert_eq!(summary["input_tokens"], 10);
        assert_eq!(summary["output_tokens"], 5);
        assert_eq!(summary["cached_input_tokens"], 3);
        assert!(search.contains("更新仓库"));
        assert!(search.contains("git status"));
    }

    #[test]
    fn 详情输出消息列表原始事件与用量事件() {
        let directory = tempdir().unwrap();
        let acp = directory.path().join("acp");
        let path = write_thread(
            &acp,
            "proj1",
            "acp%3At2",
            &[
                event(
                    0,
                    "acp:t2",
                    "Runtime",
                    "ThreadCreated",
                    json!({
                        "runtimeKind": "Acp", "cwd": "C:/work/demo",
                    }),
                ),
                event(
                    1,
                    "acp:t2",
                    "User",
                    "MessageDelta",
                    json!({
                        "messageId": "user-1", "role": "User", "contentDelta": "你好",
                    }),
                ),
                event(
                    2,
                    "acp:t2",
                    "Agent",
                    "MessageChunk",
                    json!({
                        "role": "Agent", "contentDelta": "你好！",
                    }),
                ),
                event(
                    3,
                    "acp:t2",
                    "Agent",
                    "PromptTurnFinished",
                    json!({
                        "outcome": "SUCCESS", "inputTokens": 4, "outputTokens": 2,
                    }),
                ),
            ],
        );
        let detail = parse_detail(&path, &source(&acp)).unwrap();
        let messages = detail["conversation_messages"].as_array().unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["role"], "user");
        assert_eq!(messages[0]["text"], "你好");
        assert_eq!(messages[1]["role"], "assistant");
        assert_eq!(messages[1]["text"], "你好！");
        assert_eq!(detail["usage_event_count"], 1);
        assert_eq!(detail["usage_events"][0]["usage"]["input"], 4);
        assert_eq!(detail["raw_events"].as_array().unwrap().len(), 4);
        assert!(messages[0]["_message_key"].is_string());
    }

    #[test]
    fn 工具消息携带文件活动标注() {
        let directory = tempdir().unwrap();
        let acp = directory.path().join("acp");
        let path = write_thread(
            &acp,
            "proj1",
            "acp%3At6",
            &[event(
                0,
                "acp:t6",
                "Agent",
                "ToolCallUpdated",
                json!({
                    "toolCallId": "write:1", "kind": "write", "status": "completed",
                    "title": "写入文件",
                    "rawInput": {"path": "/work/demo/weekly.md", "content": "本周三件事"},
                    "content": [{"type": "diff", "path": "/work/demo/weekly.md",
                                 "oldText": "", "newText": "本周三件事"}],
                }),
            )],
        );
        let detail = parse_detail(&path, &source(&acp)).unwrap();
        let messages = detail["conversation_messages"].as_array().unwrap();
        let call = messages
            .iter()
            .find(|message| message["tool_kind"] == "tool_call")
            .unwrap();
        assert_eq!(
            call["file_activity"],
            json!([{ "path": "/work/demo/weekly.md", "action": "write" }])
        );
        assert_eq!(call["file_edit"]["path"], "/work/demo/weekly.md");
        assert_eq!(call["file_edit"]["edits"][0]["new"], "本周三件事");
    }

    #[test]
    fn 项目_store_json_符号链接不外读() {
        let directory = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let acp = directory.path().join("acp");
        let path = write_thread(&acp, "proj9", "acp%3At9", &[]);
        std::fs::write(
            outside.path().join("store.json"),
            r#"{"projectDirectory":"/outside"}"#,
        )
        .unwrap();
        #[cfg(unix)]
        {
            // project 变量仅在 unix 下使用，放进同一 cfg 避免 Windows 报未使用。
            use std::os::unix::fs::symlink;
            let project = acp.join("projects/proj9");
            symlink(
                outside.path().join("store.json"),
                project.join("store.json"),
            )
            .unwrap();
        }
        // 符号链接的 store.json 被跳过（cwd 留空），解析不受影响。
        let (summary, _) = parse_summary(&path, &source(&acp)).unwrap();
        assert_eq!(summary["cwd"], "");
    }

    #[test]
    fn 重试请求在没有消息增量时产出用户消息() {
        let directory = tempdir().unwrap();
        let acp = directory.path().join("acp");
        let path = write_thread(
            &acp,
            "proj1",
            "acp%3At3",
            &[
                event(
                    0,
                    "acp:t3",
                    "Runtime",
                    "ThreadCreated",
                    json!({
                        "runtimeKind": "Acp", "cwd": "C:/work/demo",
                    }),
                ),
                event(
                    1,
                    "acp:t3",
                    "User",
                    "PromptRetryRequestUpdated",
                    json!({
                        "request": {"text": "带图请求", "messageId": "user-9",
                            "explicitContextItems": []},
                    }),
                ),
                event(
                    2,
                    "acp:t3",
                    "Runtime",
                    "ThreadFailed",
                    json!({
                        "message": "quota exhausted",
                    }),
                ),
                // 相同 messageId 同时有增量与重试时只保留增量。
                event(
                    3,
                    "acp:t3",
                    "User",
                    "MessageDelta",
                    json!({
                        "messageId": "user-1", "role": "User", "contentDelta": "正式消息",
                    }),
                ),
                event(
                    4,
                    "acp:t3",
                    "User",
                    "PromptRetryRequestUpdated",
                    json!({
                        "request": {"text": "重复", "messageId": "user-1",
                            "explicitContextItems": []},
                    }),
                ),
            ],
        );
        let detail = parse_detail(&path, &source(&acp)).unwrap();
        let texts: Vec<_> = detail["conversation_messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["text"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(texts, vec!["带图请求", "quota exhausted", "正式消息"]);
        // error 消息为 synthetic，不计入 message_count。
        assert_eq!(detail["summary"]["message_count"], 2);
    }

    #[test]
    fn 附件定位回读线程目录内的图片副本() {
        let directory = tempdir().unwrap();
        let acp = directory.path().join("acp");
        let thread_dir = acp.join("projects/proj1/threads/acp%3At4");
        std::fs::create_dir_all(thread_dir.join("attachments")).unwrap();
        // 最小合法 PNG 头。
        std::fs::write(
            thread_dir.join("attachments/shot.png"),
            b"\x89PNG\r\n\x1a\nrest",
        )
        .unwrap();
        let storage = thread_dir
            .join("attachments/shot.png")
            .to_string_lossy()
            .replace('\\', "/");
        let path = write_thread(
            &acp,
            "proj1",
            "acp%3At4",
            &[event(
                0,
                "acp:t4",
                "User",
                "MessageDelta",
                json!({
                    "messageId": "user-1", "role": "User", "contentDelta": "看图",
                    "contextItems": [{
                        "title": "图像",
                        "payload": {"type": "screenshot", "mimeType": "image/png",
                            "storagePath": storage},
                    }],
                }),
            )],
        );
        let detail = parse_detail(&path, &source(&acp)).unwrap();
        let message = &detail["conversation_messages"][0];
        assert_eq!(message["text"], "看图\n[image]");
        let locator = message["attachments"][0]["locator"].clone();
        let image = read_attachment(&path, &source(&acp), &locator).unwrap();
        assert_eq!(image["media_type"], "image/png");
        // 指纹不匹配时拒绝回读。
        let mut stale = locator.clone();
        stale["record_fingerprint"] = json!("0".repeat(64));
        assert!(read_attachment(&path, &source(&acp), &stale).is_err());
    }

    #[test]
    fn 损坏行阻止解析但不影响其他会话() {
        let directory = tempdir().unwrap();
        let acp = directory.path().join("acp");
        let dir = acp.join("projects/p/threads/acp%3Abad");
        std::fs::create_dir_all(&dir).unwrap();
        let bad = dir.join("events.jsonl");
        std::fs::write(&bad, "{ not json\n").unwrap();
        assert!(parse_summary(&bad, &source(&acp)).is_err());
        let good = write_thread(
            &acp,
            "p",
            "acp%3Agood",
            &[event(
                0,
                "acp:good",
                "Runtime",
                "ThreadCreated",
                json!({
                    "runtimeKind": "Acp", "cwd": "C:/work/demo",
                }),
            )],
        );
        assert!(parse_summary(&good, &source(&acp)).is_ok());
    }

    #[test]
    fn 空线程只有元数据事件() {
        let directory = tempdir().unwrap();
        let acp = directory.path().join("acp");
        let path = write_thread(
            &acp,
            "p",
            "acp%3Aempty",
            &[
                event(
                    0,
                    "acp:empty",
                    "Runtime",
                    "ThreadCreated",
                    json!({
                        "runtimeKind": "Acp", "cwd": "C:/work/demo",
                    }),
                ),
                event(
                    1,
                    "acp:empty",
                    "Agent",
                    "ConfigOptionUpdated",
                    json!({
                        "configOptions": [{"configOptionId": "model", "value": "swe-2-high"}],
                    }),
                ),
            ],
        );
        let (summary, _) = parse_summary(&path, &source(&acp)).unwrap();
        assert_eq!(summary["message_count"], 0);
        assert_eq!(summary["model"], "swe-2-high");
    }

    #[test]
    fn 根目录之外或形状不符的路径被拒绝() {
        let directory = tempdir().unwrap();
        let acp = directory.path().join("acp");
        let outside = directory.path().join("other/threads/t/events.jsonl");
        std::fs::create_dir_all(outside.parent().unwrap()).unwrap();
        std::fs::write(&outside, "").unwrap();
        assert!(parse_summary(&outside, &source(&acp)).is_err());
        // 线程目录内的其他文件不是会话。
        let sibling = write_thread(&acp, "p", "acp%3At5", &[])
            .parent()
            .unwrap()
            .join("summary.json");
        std::fs::write(&sibling, "{}").unwrap();
        assert!(parse_summary(&sibling, &source(&acp)).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn 线程目录符号链接不参与发现且解析被拒绝() {
        let directory = tempdir().unwrap();
        let acp = directory.path().join("acp");
        let external = directory.path().join("external");
        std::fs::create_dir_all(&external).unwrap();
        std::fs::write(external.join("events.jsonl"), "").unwrap();
        let threads = acp.join("projects/p/threads");
        std::fs::create_dir_all(&threads).unwrap();
        std::os::unix::fs::symlink(&external, threads.join("acp%3Alink")).unwrap();
        let source = source(&acp);
        assert!(discover_files(&source).is_empty());
        assert!(
            parse_summary(&threads.join("acp%3Alink/events.jsonl"), &source)
                .unwrap_err()
                .contains("符号链接")
        );
    }

    #[test]
    fn 没有上下文项时回退读取附件数组的可读文本() {
        let directory = tempdir().unwrap();
        let acp = directory.path().join("acp");
        let path = write_thread(
            &acp,
            "proj1",
            "acp%3At6",
            &[event(
                0,
                "acp:t6",
                "User",
                "MessageDelta",
                json!({
                    "messageId": "user-1", "role": "User", "contentDelta": "看下这个",
                    "attachments": [
                        {"title": "错误日志", "body": "panic at main"},
                        {"name": "snippet.rs", "body": "fn main() {}"},
                        {"title": "空项", "body": "  "}
                    ],
                }),
            )],
        );
        let detail = parse_detail(&path, &source(&acp)).unwrap();
        let text = detail["conversation_messages"][0]["text"].as_str().unwrap();
        assert_eq!(
            text,
            "看下这个\n\n错误日志\npanic at main\n\nsnippet.rs\nfn main() {}"
        );
    }

    #[test]
    fn 同名线程在不同项目下键不冲突() {
        let directory = tempdir().unwrap();
        let acp = directory.path().join("acp");
        for project in ["p1", "p2"] {
            write_thread(
                &acp,
                project,
                "acp%3Asame",
                &[event(
                    0,
                    "acp:same",
                    "User",
                    "MessageDelta",
                    json!({"messageId": "m", "role": "User", "contentDelta": "hi"}),
                )],
            );
        }
        let keys: Vec<_> = discover_files(&source(&acp))
            .iter()
            .map(|path| {
                parse_summary(path, &source(&acp)).unwrap().0["_key"]
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .collect();
        assert_eq!(keys.len(), 2);
        assert_ne!(keys[0], keys[1]);
    }

    #[test]
    fn 超长流式正文按上限截断并保留原始长度() {
        let directory = tempdir().unwrap();
        let acp = directory.path().join("acp");
        let long = "x".repeat(70_000);
        let path = write_thread(
            &acp,
            "proj1",
            "acp%3At7",
            &[event(
                0,
                "acp:t7",
                "Agent",
                "MessageChunk",
                json!({"role": "Agent", "contentDelta": long}),
            )],
        );
        let detail = parse_detail(&path, &source(&acp)).unwrap();
        let message = &detail["conversation_messages"][0];
        assert_eq!(message["text"].as_str().unwrap().chars().count(), 20_000);
        assert_eq!(message["text_truncated"], true);
        assert_eq!(message["original_text_chars"], 70_000);
    }
}
