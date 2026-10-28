//! DeepSeek Harness（dsh）会话日志的只读回放。
//! 会话目录 `<root>/sessions/<工作区 slug>/<session-id>/` 内可能并存多代
//! `session[.vN].jsonl[.zstd]`，只读最新一代；.zstd 为追加写入的多帧 JSONL。
use std::{
    collections::HashMap,
    fs::{self, File},
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
};

use serde_json::{json, Value};
use walkdir::WalkDir;

use super::{
    append_limited, attach_message_key, compact_title, error_text, extract_text, message_value,
    summary_search_text, timestamp_from_millis, truncate_message, HeadTail, ParseState, Source,
    DETAIL_EVENT_LIMIT, DETAIL_MESSAGE_LIMIT, SEARCH_TEXT_LIMIT,
};

const ZSTD_MAGIC: [u8; 4] = [0x28, 0xB5, 0x2F, 0xFD];

/// 声明根可指向 `~/.dsh` 或其 `sessions` 子目录。
pub(super) fn sessions_root(root: &Path) -> PathBuf {
    if root.file_name().and_then(|s| s.to_str()) == Some("sessions") {
        root.into()
    } else {
        root.join("sessions")
    }
}

/// 日志代际：`session.jsonl` 为 0，`session.vN.jsonl[.zstd]` 为 N。
fn generation(name: &str) -> Option<u32> {
    let stem = name
        .strip_suffix(".zstd")
        .unwrap_or(name)
        .strip_suffix(".jsonl")?;
    match stem {
        "session" => Some(0),
        _ => stem.strip_prefix("session.v")?.parse().ok(),
    }
}

pub(super) fn matches_path(root: &Path, path: &Path) -> bool {
    path.strip_prefix(sessions_root(root))
        .is_ok_and(|relative| {
            relative.components().count() == 3
                && relative
                    .components()
                    .nth(1)
                    .and_then(|component| component.as_os_str().to_str())
                    .is_some_and(|name| name.starts_with("session-"))
                && relative
                    .file_name()
                    .and_then(|name| name.to_str())
                    .and_then(generation)
                    .is_some()
        })
}

/// 每个会话目录只取最新一代日志；同代并存时以压缩格式为准
/// （原始 JSONL 是非默认的写出配置）。
pub(super) fn discover_files(source: &Source) -> Vec<PathBuf> {
    let mut best: HashMap<PathBuf, (u32, bool, PathBuf)> = HashMap::new();
    for entry in WalkDir::new(sessions_root(&source.root))
        .max_depth(3)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file() && matches_path(&source.root, entry.path()))
    {
        let path = entry.into_path();
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        let key = path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| path.clone());
        let candidate = (
            generation(name).unwrap_or_default(),
            name.ends_with(".zstd"),
            path,
        );
        best.entry(key)
            .and_modify(|current| {
                if (candidate.0, candidate.1) > (current.0, current.1) {
                    *current = candidate.clone();
                }
            })
            .or_insert(candidate);
    }
    let mut files = best
        .into_values()
        .map(|(_, _, path)| path)
        .collect::<Vec<_>>();
    files.sort();
    files
}

fn validate_path(path: &Path, source: &Source) -> Result<(), String> {
    let root = sessions_root(&source.root);
    let relative = path.strip_prefix(&root).map_err(error_text)?;
    if !matches_path(&source.root, path) {
        return Err("DeepSeek Harness 会话路径无效".into());
    }
    let mut current = root;
    for component in relative.components() {
        if !matches!(component, std::path::Component::Normal(_)) {
            return Err("DeepSeek Harness 会话路径无效".into());
        }
        current.push(component);
        if std::fs::symlink_metadata(&current)
            .map_err(error_text)?
            .file_type()
            .is_symlink()
        {
            return Err("DeepSeek Harness 会话路径不能包含符号链接".into());
        }
    }
    Ok(())
}

/// 按魔数判断压缩格式：多帧 zstd 流或原始 JSONL。
fn open_events(path: &Path) -> Result<Box<dyn BufRead>, String> {
    let mut reader = BufReader::new(File::open(path).map_err(error_text)?);
    if reader
        .fill_buf()
        .map_err(error_text)?
        .starts_with(&ZSTD_MAGIC)
    {
        return Ok(Box::new(BufReader::new(
            zstd::stream::Decoder::new(reader).map_err(error_text)?,
        )));
    }
    Ok(Box::new(reader))
}

fn block_text(block: &Value) -> String {
    match block["type"].as_str().unwrap_or_default() {
        "text" => block["text"].as_str().unwrap_or_default().into(),
        kind if kind.starts_with("image") => "[image]".into(),
        "resource_link" | "file" => {
            format!("[file] {}", block["uri"].as_str().unwrap_or_default())
        }
        _ => extract_text(block).unwrap_or_default(),
    }
}

fn image_block_id(block: &Value) -> Option<&str> {
    (block["type"].as_str() == Some("image"))
        .then(|| block["attachment"]["attachmentId"].as_str())
        .flatten()
        .filter(|value| !value.trim().is_empty())
}

fn attach_block_image(message: &mut Value, block: &Value, base: &[Value], index: usize) {
    if image_block_id(block).is_none() {
        return;
    }
    let mut path = base.to_vec();
    path.push(json!(index));
    message["attachments"] = json!([{ "kind": "image", "locator": { "path": path } }]);
}

fn attach_content_images(message: &mut Value, content: &Value, base: &[Value]) {
    let Some(blocks) = content.as_array() else {
        return;
    };
    let attachments = blocks
        .iter()
        .enumerate()
        .filter(|(_, block)| image_block_id(block).is_some())
        .map(|(index, _)| {
            let mut path = base.to_vec();
            path.push(json!(index));
            json!({ "kind": "image", "locator": { "path": path } })
        })
        .collect::<Vec<_>>();
    if !attachments.is_empty() {
        message["attachments"] = Value::Array(attachments);
    }
}

/// 详情只带行号与事件序号，读取时按行回放并校验序号。
fn attach_deepseek_locator(message: &mut Value, line_number: usize, seq: Option<i64>) {
    let Some(attachments) = message.get_mut("attachments").and_then(Value::as_array_mut) else {
        return;
    };
    for attachment in attachments {
        if let Some(locator) = attachment.get_mut("locator") {
            locator["line_number"] = json!(line_number);
            if let Some(seq) = seq {
                locator["seq"] = json!(seq);
            }
        }
    }
}

fn content_text(content: &Value) -> String {
    // 部分版本的 dsh 会把 content 写成纯字符串而非块数组，先按字符串取。
    if let Some(text) = content.as_str() {
        return text.into();
    }
    let text = content
        .as_array()
        .into_iter()
        .flatten()
        .map(block_text)
        .filter(|text| !text.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    if text.is_empty() {
        // 单个块对象等其他形态交给通用提取兜底，避免正文被静默丢弃。
        extract_text(content).unwrap_or_default()
    } else {
        text
    }
}

fn tool_call_message(record: &Value, timestamp: &str) -> Value {
    let data = &record["data"];
    let name = data["name"].as_str().unwrap_or("unknown_tool");
    let arguments = match data["arguments"].as_str() {
        Some(text) => text.to_string(),
        None => serde_json::to_string(&data["arguments"]).unwrap_or_default(),
    };
    let mut value = message_value(
        "tool",
        &format!("[{name}] {arguments}"),
        timestamp,
        "tool/call",
        "tool_call",
        false,
    );
    value["tool_name"] = Value::String(name.into());
    value["tool_kind"] = Value::String("tool_call".into());
    if let Some(id) = data["callId"].as_str() {
        value["tool_call_id"] = Value::String(id.into());
    }
    value
}

fn tool_result_message(
    record: &Value,
    timestamp: &str,
    tool_names: &HashMap<String, String>,
) -> Value {
    let message = &record["data"]["message"];
    let id = message["toolCallId"]
        .as_str()
        .or_else(|| message["source"]["callId"].as_str())
        .unwrap_or_default();
    let name = tool_names
        .get(id)
        .map(String::as_str)
        .unwrap_or(if id.is_empty() { "tool_result" } else { id });
    let text = content_text(&message["content"]);
    let mut value = message_value(
        "tool",
        &text,
        timestamp,
        "tool/result",
        "tool_result",
        false,
    );
    attach_content_images(
        &mut value,
        &message["content"],
        &[json!("data"), json!("message"), json!("content")],
    );
    value["tool_name"] = Value::String(name.into());
    value["tool_kind"] = Value::String("tool_result".into());
    if !id.is_empty() {
        value["tool_call_id"] = Value::String(id.into());
    }
    if message["isError"].as_bool() == Some(true) {
        value["is_error"] = Value::Bool(true);
    }
    value
}

fn assistant_messages(
    record: &Value,
    timestamp: &str,
    tool_names: &mut HashMap<String, String>,
) -> Vec<Value> {
    let message = &record["data"]["message"];
    let mut messages = Vec::new();
    // 字符串形态的 content 没有块结构，整条作为正文消息保留。
    if let Some(text) = message["content"].as_str() {
        if !text.trim().is_empty() {
            messages.push(message_value(
                "assistant",
                text,
                timestamp,
                "assistant/message",
                "text",
                false,
            ));
        }
        return messages;
    }
    for (block_index, block) in message["content"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
    {
        match block["type"].as_str().unwrap_or_default() {
            "reasoning" | "thinking" => {
                let text = block["text"]
                    .as_str()
                    .or_else(|| block["thinking"].as_str())
                    .unwrap_or_default();
                if !text.trim().is_empty() {
                    messages.push(message_value(
                        "assistant",
                        text,
                        timestamp,
                        "assistant/message",
                        "thinking",
                        true,
                    ));
                }
            }
            "tool-call" | "tool_call" | "tool_use" => {
                // 工具调用以独立的 tool/call 事件为准，这里只登记名字供结果回填。
                if let (Some(id), Some(name)) = (
                    block["id"].as_str(),
                    block["name"]
                        .as_str()
                        .or_else(|| block["function"]["name"].as_str()),
                ) {
                    tool_names.insert(id.into(), name.into());
                }
            }
            _ => {
                let text = block_text(block);
                if !text.trim().is_empty() {
                    let mut value = message_value(
                        "assistant",
                        &text,
                        timestamp,
                        "assistant/message",
                        block["type"].as_str().unwrap_or("text"),
                        false,
                    );
                    attach_block_image(
                        &mut value,
                        block,
                        &[json!("data"), json!("message"), json!("content")],
                        block_index,
                    );
                    messages.push(value);
                }
            }
        }
    }
    messages
}

fn event_messages(
    record: &Value,
    timestamp: &str,
    tool_names: &mut HashMap<String, String>,
) -> Vec<Value> {
    match record["type"].as_str().unwrap_or_default() {
        "user/message" => {
            let data = &record["data"];
            let text = content_text(&data["content"]);
            if text.trim().is_empty() {
                return Vec::new();
            }
            let kind = data["source"]["kind"].as_str().unwrap_or("user");
            // runtime-context/time-context 等注入内容按合成上下文处理，
            // 不计入用户消息也不进搜索正文。
            let mut value = if kind == "user" {
                message_value("user", &text, timestamp, "user/message", "text", false)
            } else {
                message_value("system", &text, timestamp, "user/message", kind, true)
            };
            attach_content_images(
                &mut value,
                &data["content"],
                &[json!("data"), json!("content")],
            );
            vec![value]
        }
        "assistant/message" => assistant_messages(record, timestamp, tool_names),
        "system/message" => {
            let text = content_text(&record["data"]["message"]["content"]);
            (!text.trim().is_empty())
                .then(|| {
                    let mut value =
                        message_value("system", &text, timestamp, "system/message", "system", true);
                    attach_content_images(
                        &mut value,
                        &record["data"]["message"]["content"],
                        &[json!("data"), json!("message"), json!("content")],
                    );
                    value
                })
                .into_iter()
                .collect()
        }
        "tool/call" => {
            let data = &record["data"];
            if let (Some(id), Some(name)) = (data["callId"].as_str(), data["name"].as_str()) {
                tool_names.insert(id.into(), name.into());
            }
            vec![tool_call_message(record, timestamp)]
        }
        "tool/result" => vec![tool_result_message(record, timestamp, tool_names)],
        _ => Vec::new(),
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
    let mut state = ParseState::new(path);
    if let Some(id) = path
        .parent()
        .and_then(|parent| parent.file_name())
        .and_then(|name| name.to_str())
    {
        state.id = id.to_string();
    }
    let mut title = String::new();
    let mut model = String::new();
    let mut tool_names = HashMap::<String, String>::new();
    let mut messages = HeadTail::new(DETAIL_MESSAGE_LIMIT);
    let mut events = detail.then(|| HeadTail::new(DETAIL_EVENT_LIMIT));
    let mut sequence = 0;

    for (index, line) in open_events(path)?.lines().enumerate() {
        // 撕裂的尾部 zstd frame 或非 UTF-8 行：首行就失败说明文件整体损坏，
        // 中段失败则保留已解码部分并记录标记事件。
        let line = match line {
            Ok(line) => line,
            Err(error) if index == 0 => return Err(error_text(&error)),
            Err(error) => {
                state.event_count += 1;
                if let Some(events) = events.as_mut() {
                    events.push(json!({
                        "line_number": index + 1,
                        "timestamp": Value::Null,
                        "type": "read_error",
                        "payload": { "message": error_text(&error) },
                    }));
                }
                break;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        let record = match serde_json::from_str::<Value>(&line) {
            Ok(record) => record,
            Err(error) => {
                state.event_count += 1;
                if let Some(events) = events.as_mut() {
                    events.push(json!({
                        "line_number": index + 1,
                        "timestamp": Value::Null,
                        "type": "parse_error",
                        "payload": { "message": error.to_string() },
                    }));
                }
                continue;
            }
        };
        state.event_count += 1;
        let time = record["time"]
            .as_i64()
            .and_then(timestamp_from_millis)
            .unwrap_or_default();
        if state.timestamp.is_empty() && !time.is_empty() {
            state.timestamp = time.clone();
        }
        if !time.is_empty() {
            state.last_timestamp = time.clone();
        }
        let kind = record["type"].as_str().unwrap_or("unknown");
        if let Some(events) = events.as_mut() {
            events.push(json!({
                "line_number": index + 1,
                "timestamp": time,
                "type": kind,
                "payload": if line.chars().count() > 10_000 {
                    json!({ "truncated": true, "original_chars": line.chars().count() })
                } else {
                    record.clone()
                },
            }));
        }
        match kind {
            "session" => {
                if let Some(id) = record["id"].as_str() {
                    state.id = id.to_string();
                }
                state.cwd = record["cwd"].as_str().unwrap_or_default().into();
                if let Some(created) = record["createdAt"].as_i64().and_then(timestamp_from_millis)
                {
                    if state.timestamp.is_empty() {
                        state.timestamp = created;
                    }
                }
                let parent = record["parentSessionId"]
                    .as_str()
                    .filter(|value| !value.trim().is_empty());
                if let Some(parent) = parent {
                    state.parent_session_id = parent.into();
                }
                if record["delegationDepth"].as_u64().unwrap_or(0) > 0 || parent.is_some() {
                    state.hidden = true;
                    state.hidden_reason = "subagent".into();
                }
            }
            "session/title" => {
                if let Some(value) = record["data"]["title"]
                    .as_str()
                    .filter(|value| !value.trim().is_empty())
                {
                    title = value.into();
                }
            }
            "assistant/message" => {
                let source_info = &record["data"]["message"]["source"];
                // provider 形如 deepseek-account，是账号域标识，对用户没有辨识度；
                // 徽章与 Provider 筛选优先展示模型名，未记录模型时回退 provider。
                if let Some(name) = source_info["model"]
                    .as_str()
                    .filter(|value| !value.trim().is_empty())
                {
                    model = name.into();
                    state.provider = name.into();
                } else if let Some(provider) = source_info["provider"].as_str() {
                    state.provider = provider.into();
                }
                let usage = &record["data"]["usage"];
                state.input_tokens += usage["inputTokens"].as_u64().unwrap_or(0);
                state.cached_input_tokens += usage["cacheReadTokens"].as_u64().unwrap_or(0)
                    + usage["cacheWriteTokens"].as_u64().unwrap_or(0);
                state.output_tokens += usage["outputTokens"].as_u64().unwrap_or(0);
            }
            _ => {}
        }
        for mut message in event_messages(&record, &time, &mut tool_names) {
            state.accept_message(message.clone());
            if detail {
                attach_message_key(
                    &mut message,
                    json!({
                        "kind": "deepseek_event",
                        "seq": record["seq"],
                        "message_index": sequence,
                    }),
                );
                attach_deepseek_locator(&mut message, index + 1, record["seq"].as_i64());
                visitor(&message);
                truncate_message(&mut message);
                messages.push(message);
            }
            sequence += 1;
        }
    }

    let mut summary = state.summary(path, source);
    if !title.trim().is_empty() {
        summary["title"] = Value::String(compact_title(&title, 90));
    }
    if !model.is_empty() {
        summary["model"] = Value::String(model);
    }
    summary["source_read_only"] = Value::Bool(true);
    if !detail {
        let mut search = summary_search_text(&summary);
        append_limited(&mut search, &[&state.search_text], SEARCH_TEXT_LIMIT);
        return Ok(json!({ "summary": summary, "search_text": search }));
    }
    let (mut messages, omitted_messages, total_messages) = messages.finish(json!({
        "role": "system",
        "text": "",
        "timestamp": Value::Null,
        "source_type": "viewer",
        "source_subtype": "truncation",
        "is_truncation_marker": true,
    }));
    if let Some(marker) = messages
        .iter_mut()
        .find(|value| value["is_truncation_marker"] == true)
    {
        marker["omitted_count"] = json!(omitted_messages);
    }
    let (mut events, omitted_events, total_events) = events
        .unwrap_or_else(|| HeadTail::new(DETAIL_EVENT_LIMIT))
        .finish(json!({
            "line_number": Value::Null,
            "timestamp": Value::Null,
            "type": "viewer_truncation",
            "payload": { "omitted_events": 0 },
        }));
    if let Some(marker) = events
        .iter_mut()
        .find(|value| value["type"] == "viewer_truncation")
    {
        marker["payload"]["omitted_events"] = json!(omitted_events);
    }
    let truncated = omitted_messages + omitted_events > 0;
    if truncated {
        summary["detail_truncated"] = Value::Bool(true);
    }
    Ok(json!({
        "summary": summary,
        "conversation_messages": messages,
        "raw_events": events,
        "truncation": {
            "truncated": truncated,
            "messages": { "total": total_messages, "omitted": omitted_messages },
            "raw_events": { "total": total_events, "omitted": omitted_events },
        },
    }))
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

/// 读取 DeepSeek 图片块：优先对象库原件，其次请求缓存中的处理后副本。
pub(super) fn read_attachment(
    path: &Path,
    source: &Source,
    request: &Value,
) -> Result<Value, String> {
    validate_path(path, source)?;
    let line_number = request["line_number"]
        .as_u64()
        .filter(|value| *value > 0)
        .ok_or_else(|| "图片定位信息无效".to_string())?;
    let record = read_record_at_line(path, line_number)?;
    if let Some(seq) = request["seq"].as_i64() {
        if record["seq"].as_i64() != Some(seq) {
            return Err("会话内容已变化，请刷新后重试".into());
        }
    }
    let block = super::attachment::value_at_path(&record, &request["path"])?;
    let attachment_id = image_block_id(block)
        .and_then(|value| value.strip_prefix("sha256:"))
        .filter(|value| is_sha256(value))
        .ok_or_else(|| "图片定位信息无效".to_string())?;
    let media_type = block["attachment"]["mediaType"].as_str();
    let home = dsh_home(&source.root);
    let object = home
        .join("attachments/v1/objects")
        .join(&attachment_id[..2])
        .join(attachment_id);
    if object.is_file() {
        return super::attachment::image_value_from_path(
            &object,
            super::attachment::MAX_IMAGE_BYTES,
            media_type,
        );
    }
    if let Some(variant) = variant_id(home, attachment_id) {
        let cache = home
            .join("cache/attachments/request-images")
            .join(&variant[..2])
            .join(&variant);
        if cache.is_file() {
            return super::attachment::image_value_from_path(
                &cache,
                super::attachment::MAX_IMAGE_BYTES,
                media_type,
            );
        }
    }
    Err("图片缓存已被清理，无法读取".into())
}

/// 根目录可指向 `~/.dsh` 或其 `sessions` 子目录，附件库始终相对 dsh 主目录。
fn dsh_home(root: &Path) -> &Path {
    if root.file_name().and_then(|value| value.to_str()) == Some("sessions") {
        root.parent().unwrap_or(root)
    } else {
        root
    }
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn read_record_at_line(path: &Path, line_number: u64) -> Result<Value, String> {
    for (index, line) in open_events(path)?.lines().enumerate() {
        if index as u64 + 1 == line_number {
            let line = line.map_err(error_text)?;
            return serde_json::from_str(&line)
                .map_err(|error| format!("会话记录解析失败：{error}"));
        }
    }
    Err("图片所在记录已不存在，请刷新会话".into())
}

/// `files-v3.json` 把附件 ID 映射到请求缓存里的 variant ID。
fn variant_id(root: &Path, attachment_id: &str) -> Option<String> {
    let path = root.join("llm-deepseek/files-v3.json");
    let metadata = fs::metadata(&path).ok()?;
    if metadata.len() > 16 * 1024 * 1024 {
        return None;
    }
    let value: Value = serde_json::from_str(&fs::read_to_string(&path).ok()?).ok()?;
    let variant = value["records"].as_array()?.iter().find(|record| {
        record["attachmentId"]
            .as_str()
            .and_then(|value| value.strip_prefix("sha256:"))
            == Some(attachment_id)
    })?["variantId"]
        .as_str()?
        .strip_prefix("sha256:")?;
    is_sha256(variant).then(|| variant.to_string())
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
    use std::io::Write;
    use std::path::Path;

    use serde_json::json;
    use tempfile::tempdir;

    use super::{discover_files, generation, matches_path, parse_detail, parse_summary};
    use crate::sessions::{Source, SourceFormat};

    fn source(root: &Path) -> Source {
        Source {
            kind: "deepseek",
            display_name: "DeepSeek Harness",
            root: root.into(),
            format: SourceFormat::DeepSeek,
            archived: false,
        }
    }

    fn write_session(
        dir: &Path,
        records: &[serde_json::Value],
        compress: bool,
    ) -> std::path::PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let name = if compress {
            "session.v4.jsonl.zstd"
        } else {
            "session.v4.jsonl"
        };
        let path = dir.join(name);
        let body = records
            .iter()
            .map(|value| value.to_string())
            .collect::<Vec<_>>()
            .join("\n");
        if compress {
            let mut encoder = zstd::stream::Encoder::new(Vec::new(), 0).unwrap();
            encoder.write_all(body.as_bytes()).unwrap();
            // 模拟追加写入的第二帧，验证多帧解码。
            let extra = encoder.finish().unwrap();
            let mut file = std::fs::File::create(&path).unwrap();
            file.write_all(&extra).unwrap();
            let mut encoder = zstd::stream::Encoder::new(Vec::new(), 0).unwrap();
            encoder.write_all(b"").unwrap();
            file.write_all(&encoder.finish().unwrap()).unwrap();
        } else {
            std::fs::write(&path, body).unwrap();
        }
        path
    }

    fn fixture() -> Vec<serde_json::Value> {
        vec![
            json!({"type":"session","version":4,"id":"session-abc","createdAt":1792377434881_i64,"cwd":"/work/repo","isSeeded":false,"delegationDepth":0,"agentPreset":"standard"}),
            json!({"type":"user/message","seq":8,"time":1792377447184_i64,"data":{"content":[{"type":"text","text":"分析当前项目"}],"source":{"kind":"user"},"role":"user","id":"u1"}}),
            json!({"type":"user/message","seq":9,"time":1792377447185_i64,"data":{"content":[{"type":"text","text":"Turn 1 时间上下文"}],"source":{"kind":"time-context"},"role":"user","id":"u2"}}),
            json!({"type":"system/message","seq":10,"time":1792377447186_i64,"data":{"message":{"role":"system","content":[{"type":"text","text":"系统提示"}]}}}),
            json!({"type":"assistant/message","seq":11,"time":1792377448200_i64,"data":{"turn":1,"step":1,"message":{"role":"assistant","content":[{"type":"reasoning","text":"思考"},{"type":"text","text":"开始查看"},{"type":"tool-call","id":"call_1","name":"bash","arguments":"{\"command\":\"ls\"}"}],"source":{"kind":"model","provider":"deepseek-account","model":"deepseek-flash"},"id":"a1"},"usage":{"inputTokens":100,"outputTokens":20,"cacheReadTokens":300,"cacheWriteTokens":0}}}),
            json!({"type":"tool/call","seq":12,"time":1792377448253_i64,"data":{"turn":1,"step":1,"callId":"call_1","name":"bash","arguments":"{\"command\":\"ls\"}"}}),
            json!({"type":"tool/result","seq":13,"time":1792377448282_i64,"data":{"turn":1,"step":1,"message":{"role":"tool","source":{"kind":"tool","callId":"call_1"},"toolCallId":"call_1","content":[{"type":"text","text":"file.txt"}],"isError":false,"id":"t1"}}}),
            json!({"type":"session/title","seq":14,"time":1792377448300_i64,"data":{"title":"分析项目结构","messageSeqs":[8],"source":{"kind":"llm"}}}),
        ]
    }

    #[test]
    fn 图片按对象库与请求缓存读取() {
        let directory = tempdir().unwrap();
        let attachment_id = "346a66e7e14b37118bc8c4b7bc05f4571953156e789297c91d7a818166cee477";
        let object = directory
            .path()
            .join("attachments/v1/objects")
            .join(&attachment_id[..2])
            .join(attachment_id);
        std::fs::create_dir_all(object.parent().unwrap()).unwrap();
        std::fs::write(&object, "data:image/png;base64,QUJD").unwrap();
        let session = directory
            .path()
            .join("sessions/work/session-image")
            .to_path_buf();
        let records = [
            json!({"type":"session","version":4,"id":"session-image","createdAt":1792377434881_i64,"cwd":"/work/repo"}),
            json!({"type":"user/message","seq":8,"time":1792377447184_i64,"data":{"content":[
                {"type":"image","attachment":{"attachmentId":format!("sha256:{attachment_id}"),"mediaType":"image/png","width":1,"height":1,"bytes":3,"name":"shot.png"}},
                {"type":"text","text":"看图"}
            ],"source":{"kind":"user"},"role":"user","id":"u1"}}),
        ];
        let path = write_session(&session, &records, false);
        let detail = parse_detail(&path, &source(directory.path())).unwrap();
        let message = detail["conversation_messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|message| message["attachments"].is_array())
            .unwrap();
        assert_eq!(message["text"], "[image]\n看图");
        let locator = &message["attachments"][0]["locator"];
        assert_eq!(locator["line_number"], 2);
        assert_eq!(locator["seq"], 8);
        assert_eq!(locator["path"], json!(["data", "content", 0]));
        let payload = super::read_attachment(&path, &source(directory.path()), locator).unwrap();
        assert_eq!(payload["data_url"], "data:image/png;base64,QUJD");

        // 对象库被清理时返回明确错误，不回退成空白图片。
        std::fs::remove_file(&object).unwrap();
        assert!(
            super::read_attachment(&path, &source(directory.path()), locator)
                .unwrap_err()
                .contains("清理")
        );
    }

    #[test]
    fn 文件名代际解析() {
        assert_eq!(generation("session.jsonl"), Some(0));
        assert_eq!(generation("session.jsonl.zstd"), Some(0));
        assert_eq!(generation("session.v3.jsonl.zstd"), Some(3));
        assert_eq!(generation("session.v4.jsonl"), Some(4));
        assert_eq!(generation("session.lock"), None);
        assert_eq!(generation("session.vx.jsonl"), None);
        assert_eq!(generation("other.jsonl"), None);
    }

    #[test]
    fn 同目录只保留最新一代日志() {
        let directory = tempdir().unwrap();
        let session = directory
            .path()
            .join("sessions/work/session-abc")
            .to_path_buf();
        std::fs::create_dir_all(&session).unwrap();
        std::fs::write(session.join("session.v3.jsonl.zstd"), "old").unwrap();
        std::fs::write(session.join("session.v4.jsonl.zstd"), "new").unwrap();
        std::fs::write(session.join("session.lock"), "").unwrap();
        let files = discover_files(&source(directory.path()));
        assert_eq!(files, vec![session.join("session.v4.jsonl.zstd")]);
    }

    #[test]
    fn 摘要解析多帧压缩会话() {
        let directory = tempdir().unwrap();
        let session = directory
            .path()
            .join("sessions/--work-repo--/session-abc")
            .to_path_buf();
        let path = write_session(&session, &fixture(), true);
        assert!(matches_path(directory.path(), &path));
        let (summary, search) = parse_summary(&path, &source(directory.path())).unwrap();
        assert_eq!(summary["id"], "session-abc");
        assert_eq!(summary["_key"], "deepseek:session-abc");
        assert_eq!(summary["title"], "分析项目结构");
        assert_eq!(summary["cwd"], "/work/repo");
        assert_eq!(summary["model_provider"], "deepseek-flash");
        assert_eq!(summary["model"], "deepseek-flash");
        assert_eq!(summary["message_count"], 4);
        assert_eq!(summary["context_count"], 3);
        assert_eq!(summary["role_counts"]["user"], 1);
        assert_eq!(summary["role_counts"]["assistant"], 1);
        assert_eq!(summary["role_counts"]["tool"], 2);
        assert_eq!(summary["input_tokens"], 100);
        assert_eq!(summary["output_tokens"], 20);
        assert_eq!(summary["cached_input_tokens"], 300);
        assert_eq!(summary["source_read_only"], true);
        assert_eq!(summary["hidden"], false);
        assert!(search.contains("分析当前项目"));
        assert!(search.contains("file.txt"));
        // 注入的时间上下文属于合成上下文，不进搜索正文。
        assert!(!search.contains("时间上下文"));
    }

    #[test]
    fn 缺少模型名时回退_provider() {
        let directory = tempdir().unwrap();
        let session = directory
            .path()
            .join("sessions/--work-repo--/session-provider")
            .to_path_buf();
        let records = vec![
            json!({"type":"session","version":4,"id":"session-provider","createdAt":1792377434881_i64,"cwd":"/work/repo"}),
            json!({"type":"assistant/message","seq":1,"time":1792377448200_i64,"data":{"message":{"role":"assistant","content":[{"type":"text","text":"回答"}],"source":{"kind":"model","provider":"deepseek-account"},"id":"a1"}}}),
        ];
        let path = write_session(&session, &records, true);
        let (summary, _) = parse_summary(&path, &source(directory.path())).unwrap();
        assert_eq!(summary["model_provider"], "deepseek-account");
        assert!(summary.get("model").is_none());
    }

    #[test]
    fn 详情包含消息与原始事件() {
        let directory = tempdir().unwrap();
        let session = directory
            .path()
            .join("sessions/--work-repo--/session-abc")
            .to_path_buf();
        let path = write_session(&session, &fixture(), true);
        let detail = parse_detail(&path, &source(directory.path())).unwrap();
        let messages = detail["conversation_messages"].as_array().unwrap();
        assert_eq!(messages.len(), 7);
        assert_eq!(messages[0]["role"], "user");
        assert_eq!(messages[1]["synthetic_context"], true);
        assert_eq!(messages[3]["source_subtype"], "thinking");
        assert_eq!(messages[5]["tool_kind"], "tool_call");
        assert_eq!(messages[5]["tool_call_id"], "call_1");
        assert_eq!(messages[6]["tool_kind"], "tool_result");
        assert_eq!(messages[6]["tool_name"], "bash");
        assert!(messages[6]["is_error"].is_null());
        let events = detail["raw_events"].as_array().unwrap();
        assert_eq!(events.len(), 8);
        assert_eq!(detail["truncation"]["truncated"], false);
    }

    #[test]
    fn 原始未压缩日志同样可读() {
        let directory = tempdir().unwrap();
        let session = directory
            .path()
            .join("sessions/--work-repo--/session-abc")
            .to_path_buf();
        let path = write_session(&session, &fixture(), false);
        let (summary, _) = parse_summary(&path, &source(directory.path())).unwrap();
        assert_eq!(summary["id"], "session-abc");
        assert_eq!(summary["message_count"], 4);
    }

    #[test]
    fn content为纯字符串时消息不丢失() {
        let directory = tempdir().unwrap();
        let session = directory
            .path()
            .join("sessions/--work-repo--/session-str")
            .to_path_buf();
        let records = vec![
            json!({"type":"session","version":4,"id":"session-str","createdAt":1792377434881_i64,"cwd":"/work/repo"}),
            // 部分版本的 dsh 会把 content 写成纯字符串而非块数组。
            json!({"type":"user/message","seq":1,"time":1792377447184_i64,"data":{"content":"帮我看看这个报错","source":{"kind":"user"},"role":"user","id":"u1"}}),
            json!({"type":"system/message","seq":2,"time":1792377447186_i64,"data":{"message":{"role":"system","content":"系统提示"}}}),
            json!({"type":"assistant/message","seq":3,"time":1792377448200_i64,"data":{"message":{"role":"assistant","content":"这是字符串形态的回答","source":{"kind":"model","provider":"deepseek-account","model":"deepseek-flash"},"id":"a1"}}}),
        ];
        let path = write_session(&session, &records, true);
        let (summary, search) = parse_summary(&path, &source(directory.path())).unwrap();
        assert_eq!(summary["role_counts"]["user"], 1);
        assert_eq!(summary["role_counts"]["assistant"], 1);
        assert_eq!(summary["context_count"], 1);
        assert!(search.contains("帮我看看这个报错"));
        assert!(search.contains("这是字符串形态的回答"));
        let detail = parse_detail(&path, &source(directory.path())).unwrap();
        let messages = detail["conversation_messages"].as_array().unwrap();
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0]["text"], "帮我看看这个报错");
        assert_eq!(messages[1]["text"], "系统提示");
        assert_eq!(messages[2]["role"], "assistant");
        assert_eq!(messages[2]["text"], "这是字符串形态的回答");
        assert_eq!(messages[2]["source_subtype"], "text");
        assert_eq!(messages[2]["synthetic_context"], false);
    }

    #[test]
    fn content为单个块对象时消息不丢失() {
        let directory = tempdir().unwrap();
        let session = directory
            .path()
            .join("sessions/--work-repo--/session-obj")
            .to_path_buf();
        let records = vec![
            json!({"type":"session","version":4,"id":"session-obj","createdAt":1792377434881_i64,"cwd":"/work/repo"}),
            // content 为单个块对象而非数组时同样保留正文。
            json!({"type":"user/message","seq":1,"time":1792377447184_i64,"data":{"content":{"type":"text","text":"对象形态的用户消息"},"source":{"kind":"user"},"role":"user","id":"u1"}}),
            json!({"type":"tool/result","seq":2,"time":1792377447186_i64,"data":{"message":{"role":"tool","toolCallId":"call_1","content":{"type":"text","text":"对象形态的工具结果"},"isError":false,"id":"t1"}}}),
        ];
        let path = write_session(&session, &records, true);
        let (summary, search) = parse_summary(&path, &source(directory.path())).unwrap();
        assert_eq!(summary["role_counts"]["user"], 1);
        assert_eq!(summary["role_counts"]["tool"], 1);
        assert!(search.contains("对象形态的用户消息"));
        assert!(search.contains("对象形态的工具结果"));
        let detail = parse_detail(&path, &source(directory.path())).unwrap();
        let messages = detail["conversation_messages"].as_array().unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["text"], "对象形态的用户消息");
        assert_eq!(messages[1]["text"], "对象形态的工具结果");
        assert_eq!(messages[1]["tool_call_id"], "call_1");
    }

    #[test]
    fn 委托子会话标记为子代理() {
        let directory = tempdir().unwrap();
        let session = directory
            .path()
            .join("sessions/--work-repo--/session-sub")
            .to_path_buf();
        let mut records = fixture();
        records[0] = json!({"type":"session","version":4,"id":"session-sub","createdAt":1792377434881_i64,"cwd":"/work/repo","delegationDepth":1,"parentSessionId":"session-abc"});
        let path = write_session(&session, &records, true);
        let (summary, _) = parse_summary(&path, &source(directory.path())).unwrap();
        assert_eq!(summary["hidden"], true);
        assert_eq!(summary["hidden_reason"], "subagent");
        assert_eq!(summary["parent_session_id"], "session-abc");

        // 只携带 parentSessionId、没有 delegationDepth 的旧式 header 同样隐藏。
        records[0] = json!({"type":"session","version":3,"id":"session-sub2","createdAt":1792377434881_i64,"cwd":"/work/repo","parentSessionId":"session-abc"});
        let path = write_session(&session, &records, true);
        let (summary, _) = parse_summary(&path, &source(directory.path())).unwrap();
        assert_eq!(summary["hidden"], true);
        assert_eq!(summary["parent_session_id"], "session-abc");
    }

    #[test]
    fn 损坏输入按行容忍且坏压缩流报错() {
        let directory = tempdir().unwrap();
        let session = directory
            .path()
            .join("sessions/--work-repo--/session-bad")
            .to_path_buf();
        std::fs::create_dir_all(&session).unwrap();
        let path = session.join("session.v4.jsonl.zstd");
        std::fs::write(&path, b"not-zstd-and-not-json\n{bad").unwrap();
        // 内容不是 zstd 魔数时按原始 JSONL 处理，坏行被容忍为空会话。
        let (summary, _) = parse_summary(&path, &source(directory.path())).unwrap();
        assert_eq!(summary["message_count"], 0);
        let bad_zstd = session.join("session.v5.jsonl.zstd");
        std::fs::write(&bad_zstd, [0x28, 0xB5, 0x2F, 0xFD, 0xFF]).unwrap();
        assert!(parse_summary(&bad_zstd, &source(directory.path())).is_err());
    }

    #[test]
    fn 撕裂的尾部压缩帧保留已解码部分() {
        let directory = tempdir().unwrap();
        let session = directory
            .path()
            .join("sessions/--work-repo--/session-torn")
            .to_path_buf();
        let path = write_session(&session, &fixture(), true);
        // 模拟进程崩溃留下的半个 frame：有效帧之后拼接截断碎片。
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        file.write_all(&[0x28, 0xB5, 0x2F, 0xFD, 0x00, 0x58, 0x1F])
            .unwrap();
        drop(file);

        let (summary, _) = parse_summary(&path, &source(directory.path())).unwrap();
        assert_eq!(summary["message_count"], 4);
        let detail = parse_detail(&path, &source(directory.path())).unwrap();
        let events = detail["raw_events"].as_array().unwrap();
        assert_eq!(events.last().unwrap()["type"], "read_error");
    }

    #[cfg(unix)]
    #[test]
    fn 直接读取拒绝符号链接() {
        let directory = tempdir().unwrap();
        let root = directory.path().join("sessions");
        let external = directory.path().join("external");
        std::fs::create_dir_all(root.join("w")).unwrap();
        std::fs::create_dir_all(&external).unwrap();
        std::fs::write(external.join("session.v4.jsonl.zstd"), "").unwrap();
        std::os::unix::fs::symlink(&external, root.join("w/session-abc")).unwrap();
        let path = root.join("w/session-abc/session.v4.jsonl.zstd");
        assert!(matches_path(directory.path(), &path));
        assert!(discover_files(&source(directory.path())).is_empty());
        assert!(parse_detail(&path, &source(directory.path()))
            .unwrap_err()
            .contains("符号链接"));
    }
}
