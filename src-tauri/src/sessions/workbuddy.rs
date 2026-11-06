//! WorkBuddy 桌面版会话日志的只读回放。
//! 会话正文为 `~/.workbuddy/projects/<工作区 slug>/<会话 id>.jsonl`，逐行
//! 事件流：`message`（input_text/output_text 块）、`reasoning`（思考正文在
//! rawContent）、`function_call`/`function_call_result`（工具调用与结果）与
//! `ai-title` 等元数据行。用户消息正文由注入上下文包裹，真实提问位于
//! `<user_query>` 标签内。图片不入行内，正文块 `image_blob_ref` 指向
//! `~/.workbuddy/blobs/<id 前两位>/<sha256>` 内容寻址副本。
//! 根目录可指向 `~/.workbuddy` 或其 `projects` 子目录。
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use walkdir::WalkDir;

use super::{
    DETAIL_EVENT_LIMIT, DETAIL_MESSAGE_LIMIT, HeadTail, ParseState, SEARCH_TEXT_LIMIT, Source,
    append_limited, attach_attachment_locator, attach_message_delete_ref, compact_title,
    error_text, message_value, summary_search_text, timestamp_from_millis, truncate_message,
};

/// 声明根可指向 `~/.workbuddy` 或其 `projects` 子目录。
pub(super) fn sessions_root(root: &Path) -> PathBuf {
    if root.file_name().and_then(|value| value.to_str()) == Some("projects") {
        root.into()
    } else {
        root.join("projects")
    }
}

/// 会话文件形如 `projects/<工作区 slug>/<会话 id>.jsonl`；
/// 相邻的 `<会话 id>.file-rollback.ndjson` 是文件快照引用，不是事件流。
pub(super) fn matches_path(root: &Path, path: &Path) -> bool {
    path.strip_prefix(sessions_root(root))
        .is_ok_and(|relative| {
            relative.components().count() == 2
                && relative
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.ends_with(".jsonl"))
        })
}

pub(super) fn discover_files(source: &Source) -> Vec<PathBuf> {
    let mut files = WalkDir::new(sessions_root(&source.root))
        .max_depth(2)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file() && matches_path(&source.root, entry.path()))
        .map(|entry| entry.into_path())
        .collect::<Vec<_>>();
    files.sort();
    files
}

/// 增量监听和详情读取也遵守扫描时不跟随符号链接的边界。
fn validate_path(path: &Path, source: &Source) -> Result<(), String> {
    let root = sessions_root(&source.root);
    let relative = path.strip_prefix(&root).map_err(error_text)?;
    if !matches_path(&source.root, path) {
        return Err("WorkBuddy 会话路径无效".into());
    }
    let mut current = root;
    for component in relative.components() {
        if !matches!(component, std::path::Component::Normal(_)) {
            return Err("WorkBuddy 会话路径无效".into());
        }
        current.push(component);
        if std::fs::symlink_metadata(&current)
            .map_err(error_text)?
            .file_type()
            .is_symlink()
        {
            return Err("WorkBuddy 会话路径不能包含符号链接".into());
        }
    }
    Ok(())
}

/// 提取用户消息里 `<user_query>` 标签包裹的真实提问；
/// 提取不到说明该行是纯注入上下文，由调用方按合成上下文处理。
fn user_query_text(text: &str) -> Option<String> {
    let start = text.find("<user_query>")? + "<user_query>".len();
    let end = text[start..].find("</user_query>")? + start;
    let query = text[start..end].trim();
    (!query.is_empty()).then(|| query.to_string())
}

fn output_text(output: &Value) -> String {
    if let Some(text) = output.as_str() {
        return text.into();
    }
    // 结果块数组与单块对象同为 {type, text} 形态（input_text/text）。
    let blocks = output
        .as_array()
        .map(|blocks| blocks.iter().collect::<Vec<_>>())
        .unwrap_or_else(|| vec![output]);
    blocks
        .iter()
        .filter_map(|block| block["text"].as_str())
        .filter(|text| !text.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// 记录内图片块的定位路径：`content` 数组下标。
fn attach_blob_images(message: &mut Value, content: &Value, base: &[Value]) {
    let Some(blocks) = content.as_array() else {
        return;
    };
    let attachments = blocks
        .iter()
        .enumerate()
        .filter(|(_, block)| block["type"].as_str() == Some("image_blob_ref"))
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

fn user_message(record: &Value, timestamp: &str) -> Vec<Value> {
    let content = &record["content"];
    let text = if let Some(text) = content.as_str() {
        text.to_string()
    } else {
        content
            .as_array()
            .into_iter()
            .flatten()
            .map(|block| match block["type"].as_str() {
                Some("image_blob_ref") => "[image]".to_string(),
                _ => block["text"].as_str().unwrap_or_default().to_string(),
            })
            .filter(|text| !text.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n")
    };
    if text.trim().is_empty() {
        return Vec::new();
    }
    match user_query_text(&text) {
        Some(query) => {
            let mut value =
                message_value("user", &query, timestamp, "message", "input_text", false);
            attach_blob_images(&mut value, content, &["content".into()]);
            vec![value]
        }
        // 无标签的用户行是 system-reminder 上下文注入，不计入用户消息。
        None => vec![message_value(
            "system", &text, timestamp, "message", "context", true,
        )],
    }
}

fn assistant_messages(record: &Value, timestamp: &str) -> Vec<Value> {
    record["content"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|block| {
            let text = block["text"].as_str()?;
            (!text.trim().is_empty()).then(|| {
                let mut value = message_value(
                    "assistant",
                    text,
                    timestamp,
                    "message",
                    block["type"].as_str().unwrap_or("output_text"),
                    false,
                );
                attach_blob_images(&mut value, &record["content"], &["content".into()]);
                value
            })
        })
        .collect()
}

fn tool_call_message(record: &Value, timestamp: &str) -> Value {
    let name = record["name"].as_str().unwrap_or("unknown_tool");
    let arguments = record["arguments"].as_str().unwrap_or_default();
    let mut value = message_value(
        "tool",
        &format!("[{name}] {arguments}"),
        timestamp,
        "function_call",
        "tool_call",
        false,
    );
    value["tool_name"] = Value::String(name.into());
    value["tool_kind"] = Value::String("tool_call".into());
    if let Some(id) = record["providerData"]["messageId"].as_str() {
        value["tool_call_id"] = Value::String(id.into());
    }
    value
}

fn tool_result_message(record: &Value, timestamp: &str) -> Value {
    let name = record["name"].as_str().unwrap_or("tool_result");
    let mut value = message_value(
        "tool",
        &output_text(&record["output"]),
        timestamp,
        "function_call_result",
        "tool_result",
        false,
    );
    value["tool_name"] = Value::String(name.into());
    value["tool_kind"] = Value::String("tool_result".into());
    if let Some(id) = record["callId"].as_str() {
        value["tool_call_id"] = Value::String(id.into());
    }
    if record["status"].as_str() == Some("failed") {
        value["is_error"] = Value::Bool(true);
    }
    value
}

fn reasoning_message(record: &Value, timestamp: &str) -> Option<Value> {
    let text = record["rawContent"].as_str()?;
    (!text.trim().is_empty())
        .then(|| message_value("assistant", text, timestamp, "reasoning", "thinking", true))
}

/// 每次模型调用（assistant 消息与 function_call 输出项）各带一份
/// rawUsage 增量，按 providerData.messageId 去重累加；reasoning 行复用
/// 所属消息的 messageId 但不带用量，天然不会重复计数。
fn record_usage(state: &mut ParseState, record: &Value, timestamp: &str, model: &str) {
    let provider = &record["providerData"];
    let usage = &provider["rawUsage"];
    if !usage.is_object() {
        return;
    }
    let message_id = provider["messageId"].as_str().unwrap_or_default();
    if !message_id.is_empty() && !state.counted_response_ids.insert(message_id.into()) {
        return;
    }
    let prompt = usage["prompt_tokens"].as_u64().unwrap_or(0);
    let cached = usage["prompt_cache_hit_tokens"].as_u64().unwrap_or(0).max(
        usage["prompt_tokens_details"]["cached_tokens"]
            .as_u64()
            .unwrap_or(0),
    );
    state.record_usage(
        timestamp,
        super::usage::TokenUsage {
            input: prompt.saturating_sub(cached),
            output: usage["completion_tokens"].as_u64().unwrap_or(0),
            cache_read: cached,
            cache_write: usage["cache_creation_input_tokens"].as_u64().unwrap_or(0),
        },
        model,
    );
}

fn parse(
    path: &Path,
    source: &Source,
    visitor: &mut dyn FnMut(&Value),
    detail: bool,
) -> Result<Value, String> {
    validate_path(path, source)?;
    let mut state = ParseState::new(path);
    if let Some(id) = path.file_stem().and_then(|value| value.to_str()) {
        state.id = id.to_string();
    }
    let mut title = String::new();
    let mut model = String::new();
    let mut messages = HeadTail::new(DETAIL_MESSAGE_LIMIT);
    let mut events = detail.then(|| HeadTail::new(DETAIL_EVENT_LIMIT));

    let reader = BufReader::new(File::open(path).map_err(error_text)?);
    for (index, line) in reader.lines().enumerate() {
        let line = line.map_err(error_text)?;
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
        let time = record["timestamp"]
            .as_i64()
            .and_then(timestamp_from_millis)
            .unwrap_or_default();
        if state.timestamp.is_empty() && !time.is_empty() {
            state.timestamp = time.clone();
        }
        if !time.is_empty() {
            state.last_timestamp = time.clone();
        }
        if let Some(value) = record["cwd"].as_str() {
            state.cwd = value.into();
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
        let outgoing = match kind {
            "ai-title" => {
                if let Some(value) = record["aiTitle"]
                    .as_str()
                    .filter(|value| !value.trim().is_empty())
                {
                    title = value.into();
                }
                Vec::new()
            }
            "message" => {
                if let Some(name) = record["providerData"]["model"]
                    .as_str()
                    .filter(|value| !value.trim().is_empty())
                {
                    model = name.into();
                    state.provider = name.into();
                }
                record_usage(&mut state, &record, &time, &model);
                match record["role"].as_str() {
                    Some("user") => user_message(&record, &time),
                    Some("assistant") => assistant_messages(&record, &time),
                    _ => Vec::new(),
                }
            }
            "function_call" => {
                if let Some(name) = record["providerData"]["model"]
                    .as_str()
                    .filter(|value| !value.trim().is_empty())
                {
                    model = name.into();
                }
                record_usage(&mut state, &record, &time, &model);
                vec![tool_call_message(&record, &time)]
            }
            "function_call_result" => vec![tool_result_message(&record, &time)],
            "reasoning" => reasoning_message(&record, &time).into_iter().collect(),
            _ => Vec::new(),
        };
        for (message_index, message) in outgoing.into_iter().enumerate() {
            // accept_message 返回带 command_name/file_activity/file_edit 标注的
            // 归一化副本，详情与 visitor 必须使用它；None 表示重复消息被去重。
            let Some(mut message) = state.accept_message(message) else {
                continue;
            };
            if detail {
                let fingerprint = super::parse::json_fingerprint(&record);
                attach_message_delete_ref(
                    &mut message,
                    json!({
                        "kind": "jsonl_record",
                        "line_number": index + 1,
                        "message_index": message_index,
                        "record_fingerprint": fingerprint.clone(),
                    }),
                );
                attach_attachment_locator(&mut message, index + 1, &fingerprint);
                visitor(&message);
                truncate_message(&mut message);
                messages.push(message);
            }
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
        "usage_events": state.usage.events,
        "usage_event_count": state.usage.event_count,
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

pub(super) fn visit_detail(
    path: &Path,
    source: &Source,
    visitor: &mut dyn FnMut(&Value),
) -> Result<Value, String> {
    parse(path, source, visitor, true)
}

/// 读取 WorkBuddy 图片：按行回放定位 `image_blob_ref` 块，
/// 再从声明根的 `blobs/<id 前两位>/<sha256>` 内容寻址库回读副本。
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
    let fingerprint = request["record_fingerprint"]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "图片定位信息无效".to_string())?;
    let record = read_record_at_line(path, line_number)?;
    if super::parse::json_fingerprint(&record) != fingerprint {
        return Err("会话内容已变化，请刷新后重试".into());
    }
    let block = super::attachment::value_at_path(&record, &request["path"])?;
    if block["type"].as_str() != Some("image_blob_ref") {
        return Err("图片定位信息无效".into());
    }
    let blob_id = block["blob_id"]
        .as_str()
        .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or_else(|| "图片定位信息无效".to_string())?;
    // 实际副本命名为 `<sha256>.<扩展名>`（如 .png）。只取 blob_path 的
    // 文件名部分并以 blob_id 前缀校验，不信任记录里的绝对路径，
    // 避免恶意记录把读取引向声明根之外。
    let file_name = block["blob_path"]
        .as_str()
        .and_then(|value| Path::new(value).file_name())
        .and_then(|value| value.to_str())
        .filter(|value| value.starts_with(blob_id) && value.len() <= blob_id.len() + ".webp".len())
        .unwrap_or(blob_id);
    let blob_root = workbuddy_home(&source.root).join("blobs");
    let blob = blob_root.join(&blob_id[..2]).join(file_name);
    validate_blob_path(&blob_root, &blob)?;
    if !blob.is_file() {
        return Err("图片副本不存在或已被清理".into());
    }
    super::attachment::image_value_from_path(
        &blob,
        super::attachment::MAX_IMAGE_BYTES,
        block["mime"].as_str(),
    )
}

/// 图片副本位于声明根的 `blobs/` 下；blobs 目录、哈希子目录或文件本身
/// 任一层是符号链接都会越出声明目录，逐层校验并拒绝（与 validate_path
/// 的会话路径边界一致）。中间层缺失不算错误，交给调用方的存在性检查
/// 报「副本不存在」。
fn validate_blob_path(root: &Path, blob: &Path) -> Result<(), String> {
    let link_free = |path: &Path| match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err("WorkBuddy 图片副本路径不能包含符号链接".into())
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error_text(error)),
    };
    link_free(root)?;
    let relative = blob.strip_prefix(root).map_err(error_text)?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        if !matches!(component, std::path::Component::Normal(_)) {
            return Err("WorkBuddy 图片副本路径无效".into());
        }
        current.push(component);
        link_free(&current)?;
    }
    Ok(())
}

/// 根目录可指向 `~/.workbuddy` 或其 `projects` 子目录，附件库始终相对主目录。
fn workbuddy_home(root: &Path) -> PathBuf {
    let root = root.to_path_buf();
    if root.file_name().and_then(|value| value.to_str()) == Some("projects") {
        root.parent().map(Path::to_path_buf).unwrap_or(root)
    } else {
        root
    }
}

fn read_record_at_line(path: &Path, line_number: u64) -> Result<Value, String> {
    for (index, line) in BufReader::new(File::open(path).map_err(error_text)?)
        .lines()
        .enumerate()
    {
        if index as u64 + 1 == line_number {
            let line = line.map_err(error_text)?;
            return serde_json::from_str(&line)
                .map_err(|error| format!("会话记录解析失败：{error}"));
        }
    }
    Err("图片所在记录已不存在，请刷新会话".into())
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use serde_json::json;
    use tempfile::tempdir;

    use super::{discover_files, matches_path, parse_detail, parse_summary};
    use crate::sessions::{Source, SourceFormat};

    fn source(root: &Path) -> Source {
        Source {
            kind: "workbuddy",
            display_name: "WorkBuddy",
            root: root.into(),
            format: SourceFormat::WorkBuddy,
            archived: false,
        }
    }

    fn write_session(home: &Path, records: &[serde_json::Value]) -> std::path::PathBuf {
        let directory = home.join("projects/Users-demo-task");
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("c32b1e47-6421-4f87-aa69-011f5691f19d.jsonl");
        std::fs::write(
            &path,
            records
                .iter()
                .map(|value| value.to_string())
                .collect::<Vec<_>>()
                .join("\n"),
        )
        .unwrap();
        path
    }

    fn fixture() -> Vec<serde_json::Value> {
        vec![
            json!({"type":"session-meta","id":"m0","sessionId":"c32b1e47-6421-4f87-aa69-011f5691f19d","cwd":"/Users/demo/task","timestamp":1793967346000_i64}),
            json!({"type":"ai-title","id":"m1","sessionId":"c32b1e47-6421-4f87-aa69-011f5691f19d","aiTitle":"整理周报","cwd":"/Users/demo/task","timestamp":1793967350000_i64}),
            json!({"type":"message","id":"m2","role":"user","cwd":"/Users/demo/task","sessionId":"c32b1e47-6421-4f87-aa69-011f5691f19d","timestamp":1793967347000_i64,"content":[{"type":"input_text","text":"<system-reminder data-role=\"user-context\">环境信息</system-reminder>\n<user_query>帮我整理周报</user_query>"}],"providerData":{"startsNewUserRequest":true,"agent":"cli","conversationRequestId":"req-1"},"__codebuddyLocal":{"sensitiveUserInputReviewed":true}}),
            json!({"type":"message","id":"m3","role":"assistant","cwd":"/Users/demo/task","sessionId":"c32b1e47-6421-4f87-aa69-011f5691f19d","timestamp":1793967354000_i64,"status":"completed","parentId":"p1","content":[{"type":"output_text","text":"开始整理"}],"message":{"usage":{"requests":1}},"providerData":{"conversationRequestId":"req-1","messageId":"msg-1","model":"deepseek-v4.1-flash","requestModelId":"fast-model","rawUsage":{"prompt_tokens":1000,"completion_tokens":100,"prompt_cache_hit_tokens":200,"cache_creation_input_tokens":50,"credit":0.5}}}),
            json!({"type":"reasoning","id":"m4","sessionId":"c32b1e47-6421-4f87-aa69-011f5691f19d","cwd":"/Users/demo/task","timestamp":1793967355000_i64,"parentId":"p1","content":[],"rawContent":"先想想怎么整理","providerData":{"conversationRequestId":"req-1","messageId":"msg-1"}}),
            json!({"type":"function_call","id":"m5","name":"Read","arguments":"{\"file_path\":\"/tmp/report.md\"}","cwd":"/Users/demo/task","sessionId":"c32b1e47-6421-4f87-aa69-011f5691f19d","timestamp":1793967356000_i64,"providerData":{"conversationRequestId":"req-1","messageId":"msg-2","model":"deepseek-v4.1-flash","rawUsage":{"prompt_tokens":2000,"completion_tokens":80,"prompt_cache_hit_tokens":0}}}),
            json!({"type":"function_call_result","id":"m6","callId":"msg-2","name":"Read","output":[{"type":"input_text","text":"本周完成三件事"}],"cwd":"/Users/demo/task","sessionId":"c32b1e47-6421-4f87-aa69-011f5691f19d","timestamp":1793967357000_i64,"status":"success"}),
            json!({"type":"message","id":"m7","role":"assistant","cwd":"/Users/demo/task","sessionId":"c32b1e47-6421-4f87-aa69-011f5691f19d","timestamp":1793967358000_i64,"status":"completed","parentId":"p2","content":[{"type":"output_text","text":"周报如下"}],"providerData":{"conversationRequestId":"req-1","messageId":"msg-3","model":"deepseek-v4.1-flash","rawUsage":{"prompt_tokens":3000,"completion_tokens":120,"prompt_cache_hit_tokens":400}}}),
        ]
    }

    #[test]
    fn 发现限定在_projects_下的会话文件() {
        let home = tempdir().unwrap();
        let projects = home.path().join("projects/Users-demo-task");
        std::fs::create_dir_all(&projects).unwrap();
        std::fs::write(projects.join("session-a.jsonl"), "{}\n").unwrap();
        // 回滚快照与 traces 追踪都不是会话事件流。
        std::fs::write(projects.join("session-a.file-rollback.ndjson"), "{}\n").unwrap();
        let traces = home.path().join("traces/123");
        std::fs::create_dir_all(&traces).unwrap();
        std::fs::write(traces.join("trace_deadbeef.jsonl"), "{}\n").unwrap();

        let root = home.path().to_path_buf();
        assert!(matches_path(&root, &projects.join("session-a.jsonl")));
        assert!(!matches_path(
            &root,
            &projects.join("session-a.file-rollback.ndjson")
        ));
        assert!(!matches_path(&root, &traces.join("trace_deadbeef.jsonl")));
        assert!(!matches_path(&root, &home.path().join("session-a.jsonl")));
        let files = discover_files(&source(&root));
        assert_eq!(files, vec![projects.join("session-a.jsonl")]);
    }

    #[test]
    fn 摘要归约标题提问用量与工具() {
        let home = tempdir().unwrap();
        let path = write_session(home.path(), &fixture());
        let (summary, search) = parse_summary(&path, &source(home.path())).unwrap();
        assert_eq!(summary["id"], "c32b1e47-6421-4f87-aa69-011f5691f19d");
        assert_eq!(
            summary["_key"],
            "workbuddy:c32b1e47-6421-4f87-aa69-011f5691f19d"
        );
        assert_eq!(summary["title"], "整理周报");
        assert_eq!(summary["cwd"], "/Users/demo/task");
        assert_eq!(summary["model"], "deepseek-v4.1-flash");
        assert_eq!(summary["source_read_only"], true);
        assert_eq!(summary["originator"], "workbuddy");
        // 用户真实提问来自 <user_query> 标签，注入上下文不进用户消息。
        assert_eq!(summary["preview_text"], "开始整理");
        // msg-1 1000/200/50、msg-2 2000/0、msg-3 3000/400，三次调用互不去重。
        assert_eq!(summary["input_tokens"], 6000 - 600);
        assert_eq!(summary["output_tokens"], 300);
        assert_eq!(summary["cached_input_tokens"], 600 + 50);
        assert_eq!(summary["tool_counts"]["read"], 1);
        assert_eq!(summary["message_count"], 5);
        assert!(search.contains("帮我整理周报"));
        assert!(!search.contains("环境信息"));
    }

    #[test]
    fn 详情消息含思考工具与删除定位() {
        let home = tempdir().unwrap();
        let path = write_session(home.path(), &fixture());
        let detail = parse_detail(&path, &source(home.path())).unwrap();
        let messages = detail["conversation_messages"].as_array().unwrap();
        let roles = messages
            .iter()
            .map(|message| {
                format!(
                    "{}:{}",
                    message["role"].as_str().unwrap_or("?"),
                    message["source_subtype"].as_str().unwrap_or("?")
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(
            roles,
            vec![
                "user:input_text",
                "assistant:output_text",
                "assistant:thinking",
                "tool:tool_call",
                "tool:tool_result",
                "assistant:output_text"
            ]
        );
        let thinking = messages
            .iter()
            .find(|message| message["source_subtype"] == "thinking")
            .unwrap();
        assert_eq!(thinking["text"], "先想想怎么整理");
        assert_eq!(thinking["synthetic_context"], true);
        let call = messages
            .iter()
            .find(|message| message["tool_kind"] == "tool_call")
            .unwrap();
        assert_eq!(call["tool_name"], "Read");
        assert!(
            call["text"]
                .as_str()
                .unwrap()
                .contains("\"file_path\":\"/tmp/report.md\"")
        );
        assert!(call["_delete_ref"]["record_fingerprint"].is_string());
        let result = messages
            .iter()
            .find(|message| message["tool_kind"] == "tool_result")
            .unwrap();
        assert_eq!(result["text"], "本周完成三件事");
        // 用量事件逐次保留，供详情的用量时间线展示。
        assert_eq!(detail["usage_event_count"], 3);
    }

    #[test]
    fn 重复消息标识只计一次用量() {
        let home = tempdir().unwrap();
        let mut records = fixture();
        records.push(json!({
            "type":"message","id":"m8","role":"assistant","cwd":"/Users/demo/task",
            "sessionId":"c32b1e47-6421-4f87-aa69-011f5691f19d","timestamp":1793967359000_i64,
            "status":"completed","content":[{"type":"output_text","text":"补充"}],
            "providerData":{"conversationRequestId":"req-1","messageId":"msg-3","model":"deepseek-v4.1-flash","rawUsage":{"prompt_tokens":3000,"completion_tokens":120,"prompt_cache_hit_tokens":400}}
        }));
        let path = write_session(home.path(), &records);
        let (summary, _) = parse_summary(&path, &source(home.path())).unwrap();
        assert_eq!(summary["input_tokens"], 6000 - 600);
        assert_eq!(summary["output_tokens"], 300);
    }

    #[test]
    fn 图片按内容寻址副本读取() {
        let home = tempdir().unwrap();
        let blob_id = "b9fe2fd8ef5d16efa38d861d9279383bd0c264eee51f22c643cd22565ee6c54a";
        let blob = home
            .path()
            .join("blobs")
            .join(&blob_id[..2])
            .join(format!("{blob_id}.png"));
        std::fs::create_dir_all(blob.parent().unwrap()).unwrap();
        std::fs::write(&blob, "data:image/png;base64,QUJD").unwrap();
        let records = vec![json!({
            "type":"message","id":"m2","role":"user","cwd":"/Users/demo/task",
            "sessionId":"c32b1e47-6421-4f87-aa69-011f5691f19d","timestamp":1793967347000_i64,
            "content":[
                {"type":"image_blob_ref","blob_id":blob_id,"blob_path":format!("/home/demo/.workbuddy/blobs/{}/{}.png", &blob_id[..2], blob_id),"mime":"image/png","original_filename":"shot.png","size":3},
                {"type":"input_text","text":"<user_query>@image#1:\"shot.png\" 这张图怎么样</user_query>"}
            ],
            "providerData":{"startsNewUserRequest":true,"agent":"cli"}
        })];
        let path = write_session(home.path(), &records);
        let detail = parse_detail(&path, &source(home.path())).unwrap();
        let message = &detail["conversation_messages"][0];
        assert_eq!(message["attachments"][0]["kind"], "image");
        let locator = &message["attachments"][0]["locator"];
        assert_eq!(locator["line_number"], 1);
        assert_eq!(locator["path"], json!(["content", 0]));
        let payload = super::read_attachment(&path, &source(home.path()), locator).unwrap();
        assert_eq!(payload["data_url"], "data:image/png;base64,QUJD");

        // 指纹变化拒绝回读，不回退到过期内容。
        let stale = json!({
            "line_number": 1,
            "record_fingerprint": "deadbeef",
            "path": locator["path"].clone(),
        });
        assert!(
            super::read_attachment(&path, &source(home.path()), &stale)
                .unwrap_err()
                .contains("已变化")
        );
        // blob 副本缺失时明确报错。
        std::fs::remove_file(&blob).unwrap();
        assert!(
            super::read_attachment(&path, &source(home.path()), locator)
                .unwrap_err()
                .contains("不存在")
        );
    }

    #[test]
    #[cfg(unix)]
    fn 图片副本符号链接越界被拒绝() {
        use std::os::unix::fs::symlink;

        let home = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let blob_id = "b9fe2fd8ef5d16efa38d861d9279383bd0c264eee51f22c643cd22565ee6c54a";
        let blob_dir = home.path().join("blobs").join(&blob_id[..2]);
        std::fs::create_dir_all(&blob_dir).unwrap();
        let records = vec![json!({
            "type":"message","id":"m2","role":"user","cwd":"/Users/demo/task",
            "sessionId":"c32b1e47-6421-4f87-aa69-011f5691f19d","timestamp":1793967347000_i64,
            "content":[
                {"type":"image_blob_ref","blob_id":blob_id,"blob_path":format!("blobs/{}/{}.png", &blob_id[..2], blob_id),"mime":"image/png","original_filename":"shot.png","size":3},
                {"type":"input_text","text":"<user_query>@image#1:\"shot.png\" 这张图怎么样</user_query>"}
            ],
            "providerData":{"startsNewUserRequest":true,"agent":"cli"}
        })];
        let path = write_session(home.path(), &records);
        let detail = parse_detail(&path, &source(home.path())).unwrap();
        let locator = &detail["conversation_messages"][0]["attachments"][0]["locator"];

        // 文件本身是符号链接：即使目标在声明目录内也拒绝读取。
        let blob = blob_dir.join(format!("{blob_id}.png"));
        let outside_file = outside.path().join("real.png");
        std::fs::write(&outside_file, "data:image/png;base64,QUJD").unwrap();
        symlink(&outside_file, &blob).unwrap();
        assert!(
            super::read_attachment(&path, &source(home.path()), locator)
                .unwrap_err()
                .contains("符号链接")
        );

        // 哈希子目录是符号链接同样拒绝，避免从声明目录外读取。
        std::fs::remove_file(&blob).unwrap();
        std::fs::write(&blob, "data:image/png;base64,QUJD").unwrap();
        let outside_dir = outside.path().join("blobs-alias");
        std::fs::create_dir_all(&outside_dir).unwrap();
        std::fs::copy(&blob, outside_dir.join(format!("{blob_id}.png"))).unwrap();
        let real_dir = blob_dir.clone();
        std::fs::remove_dir_all(&real_dir).unwrap();
        symlink(&outside_dir, &blob_dir).unwrap();
        assert!(
            super::read_attachment(&path, &source(home.path()), locator)
                .unwrap_err()
                .contains("符号链接")
        );
    }

    #[test]
    fn 文件活动标注进入详情消息() {
        let home = tempdir().unwrap();
        let records = vec![
            json!({
                "type":"message","id":"m2","role":"user","cwd":"/Users/demo/task",
                "sessionId":"c32b1e47-6421-4f87-aa69-011f5691f19d","timestamp":1793967347000_i64,
                "content":[{"type":"input_text","text":"<user_query>写一下周报</user_query>"}],
                "providerData":{"startsNewUserRequest":true,"agent":"cli"}
            }),
            json!({
                "type":"function_call","id":"m3","name":"Write","arguments":"{\"file_path\":\"/Users/demo/task/weekly.md\",\"content\":\"本周完成三件事\"}",
                "cwd":"/Users/demo/task","sessionId":"c32b1e47-6421-4f87-aa69-011f5691f19d",
                "timestamp":1793967356000_i64,
                "providerData":{"conversationRequestId":"req-1","messageId":"msg-2","model":"deepseek-v4.1-flash"}
            }),
        ];
        let path = write_session(home.path(), &records);
        let detail = parse_detail(&path, &source(home.path())).unwrap();
        let call = detail["conversation_messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|message| message["tool_kind"] == "tool_call")
            .unwrap();
        assert_eq!(
            call["file_activity"],
            json!([{ "path": "/Users/demo/task/weekly.md", "action": "write" }])
        );
        assert_eq!(call["file_edit"]["path"], "/Users/demo/task/weekly.md");
        assert_eq!(call["file_edit"]["edits"][0]["new"], "本周完成三件事");
    }

    #[test]
    fn 只有元数据行的会话没有消息() {
        let home = tempdir().unwrap();
        let records = vec![json!({
            "type":"session-meta","id":"m0","sessionId":"c32b1e47-6421-4f87-aa69-011f5691f19d",
            "cwd":"/Users/demo/task","timestamp":1793967346000_i64
        })];
        let path = write_session(home.path(), &records);
        let (summary, _) = parse_summary(&path, &source(home.path())).unwrap();
        assert_eq!(summary["message_count"], 0);
    }
}
