//! VS Code Copilot Chat 面板会话。
//!
//! 数据根是 VS Code 的 `User` 目录（macOS 为
//! `~/Library/Application Support/Code/User`，Windows 为 `%APPDATA%/Code/User`，
//! Linux 为 `~/.config/Code/User`）。会话文件有两处：
//! - `workspaceStorage/<hash>/chatSessions/<session-id>.json|.jsonl`：按工作区保存，
//!   同级 `workspace.json` 的 `folder`/`workspace` URI 给出项目目录；
//! - `globalStorage/emptyWindowChatSessions/<session-id>.json|.jsonl`：空窗口会话，
//!   没有工作区映射。
//!
//! `.json` 是单个 JSON 文档（version 3）：`sessionId`、毫秒时间戳
//! `creationDate`/`lastMessageDate`、可选 `customTitle`，以及 `requests[]`。
//! 每个 request 的 `message` 是用户输入（字符串或 `{text, parts}`），
//! `response` 是按 kind 区分的响应项数组（markdownContent/thinking/
//! toolInvocationSerialized/textEditGroup 等；markdown 正文常是
//! 不带 kind 的裸 IMarkdownString）。
//! `.jsonl`（1.109 起）是同一文档的追加日志：首条 `{"kind":0,"v":<快照>}`
//! （快照没有 `lastMessageDate`，另有可选 `workingDirectory` URI），之后是
//! kind 1（set）、kind 2（数组 push，可带 `i` 先截断）、kind 3（删除）；
//! 同一 id 两种文件并存时以 `.jsonl` 为准。

use std::{
    fs::File,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
};

use percent_encoding::percent_decode_str;
use serde_json::{json, Value};

use super::{
    append_limited, attach_message_key, compact_title, error_text, extract_text, message_value,
    summary_search_text, truncate_message, HeadTail, ParseState, Source, DETAIL_EVENT_LIMIT,
    DETAIL_MESSAGE_LIMIT, SEARCH_TEXT_LIMIT,
};

fn collect_session_dir(dir: &Path, paths: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        match path.extension().and_then(|v| v.to_str()) {
            // 同名 .jsonl 存在时以追加日志为准，跳过旧版平铺文件。
            Some("json") if !path.with_extension("jsonl").is_file() => paths.push(path),
            Some("jsonl") => paths.push(path),
            _ => {}
        }
    }
}

fn collect_workspace_sessions(workspace_storage: &Path, paths: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(workspace_storage) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let dir = entry.path();
        if dir.is_dir() {
            collect_session_dir(&dir.join("chatSessions"), paths);
        }
    }
}

pub(super) fn discover_files(source: &Source) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let root = &source.root;
    collect_workspace_sessions(&root.join("workspaceStorage"), &mut paths);
    collect_session_dir(
        &root.join("globalStorage").join("emptyWindowChatSessions"),
        &mut paths,
    );
    // 兼容把 root 直接配置成 workspaceStorage 或某个会话目录。
    match root.file_name().and_then(|v| v.to_str()) {
        Some("workspaceStorage") => collect_workspace_sessions(root, &mut paths),
        Some("chatSessions" | "emptyWindowChatSessions") => collect_session_dir(root, &mut paths),
        _ => {}
    }
    paths.sort();
    paths.dedup();
    paths
}

pub(super) fn matches_path(root: &Path, path: &Path) -> bool {
    let extension = path.extension().and_then(|v| v.to_str());
    if !matches!(extension, Some("json" | "jsonl")) || !path.starts_with(root) {
        return false;
    }
    // 同名 .jsonl 存在时 .json 已被取代，变更归属日志文件。
    if extension == Some("json") && path.with_extension("jsonl").is_file() {
        return false;
    }
    matches!(
        path.parent()
            .and_then(|p| p.file_name())
            .and_then(|v| v.to_str()),
        Some("chatSessions" | "emptyWindowChatSessions")
    )
}

/// `.jsonl` 追加日志取代同 id 的 `.json` 平铺文件；返回可能被遮蔽的旧路径。
pub(super) fn shadowed_flat_path(path: &Path) -> Option<PathBuf> {
    (path.extension().and_then(|v| v.to_str()) == Some("jsonl"))
        .then(|| path.with_extension("json"))
}

/// chatSessions/<id>.json 的上级目录里的 workspace.json 给出工作区 URI。
fn workspace_folder(sessions_file: &Path) -> String {
    let Some(dir) = sessions_file.parent().and_then(|p| p.parent()) else {
        return String::new();
    };
    let Ok(text) = std::fs::read_to_string(dir.join("workspace.json")) else {
        return String::new();
    };
    let Ok(doc) = serde_json::from_str::<Value>(&text) else {
        return String::new();
    };
    let uri = doc["folder"]
        .as_str()
        .or_else(|| doc["workspace"].as_str())
        .unwrap_or_default();
    uri_to_path(uri)
}

fn session_cwd(path: &Path, doc: &Value) -> String {
    let workspace = workspace_folder(path);
    if !workspace.is_empty() {
        return workspace;
    }
    // 空窗口会话和 .jsonl 快照用 workingDirectory 兜底。
    uri_to_path(doc["workingDirectory"].as_str().unwrap_or_default())
}

/// `file://` URI 还原为本地路径（`file://server/x` → `//server/x`，
/// `file:///c:/x` → `c:/x`）；其他 scheme（vscode-remote 等）返回解码后的
/// 完整 URI，避免与本地同名路径混淆；无 scheme 时整体解码返回。
fn uri_to_path(uri: &str) -> String {
    let decoded = percent_decode_str(uri)
        .decode_utf8()
        .unwrap_or_default()
        .into_owned();
    let Some(pos) = uri.find("://") else {
        return decoded;
    };
    if !uri[..pos].eq_ignore_ascii_case("file") {
        return decoded;
    }
    let rest = &decoded[pos + 3..];
    let (authority, path) = match rest.find('/') {
        Some(slash) => (&rest[..slash], &rest[slash..]),
        None => (rest, ""),
    };
    if !authority.is_empty() && authority != "localhost" {
        return format!("//{authority}{path}");
    }
    // /c:/x 形式的盘符路径去掉开头的斜杠。
    if path.len() > 2 && path.as_bytes()[1].is_ascii_alphabetic() && path.as_bytes()[2] == b':' {
        return path[1..].to_string();
    }
    path.to_string()
}

/// `.json` 直接解析；`.jsonl` 逐条回放追加日志。写入到一半的文件
/// 返回 Err，由监听事件触发下次重试。
fn read_document(path: &Path) -> Result<Value, String> {
    let reader = BufReader::new(File::open(path).map_err(error_text)?);
    if path.extension().and_then(|v| v.to_str()) != Some("jsonl") {
        return serde_json::from_reader(reader).map_err(error_text);
    }
    let mut doc = Value::Null;
    let mut snapshot_seen = false;
    for line in reader.lines() {
        let line = line.map_err(error_text)?;
        if line.trim().is_empty() {
            continue;
        }
        let entry: Value = serde_json::from_str(&line).map_err(error_text)?;
        if !snapshot_seen {
            // kind 0 完整快照之前出现其他 entry 视为错误。
            if entry["kind"].as_i64() != Some(0) {
                return Err("会话日志首条不是完整快照".into());
            }
            doc = entry["v"].clone();
            snapshot_seen = true;
            continue;
        }
        match entry["kind"].as_i64() {
            Some(1) => apply_set(&mut doc, &entry),
            Some(2) => apply_push(&mut doc, &entry),
            Some(3) => apply_remove(&mut doc, &entry),
            // 未知 kind（以及重复的快照）忽略。
            _ => {}
        }
    }
    if !snapshot_seen {
        return Err("会话日志为空或缺少快照".into());
    }
    Ok(doc)
}

/// 沿路径段（字符串对象键 / 数字数组下标）定位到目标节点的父节点，
/// 返回父节点与最后一段；中间路径不存在时返回 None。
fn locate_mut<'a, 'b>(doc: &'a mut Value, path: &'b [Value]) -> Option<(&'a mut Value, &'b Value)> {
    let (last, parents) = path.split_last()?;
    let mut node = doc;
    for segment in parents {
        node = match segment {
            Value::String(key) => node.get_mut(key.as_str())?,
            Value::Number(index) => node.get_mut(index.as_u64()? as usize)?,
            _ => return None,
        };
    }
    Some((node, last))
}

/// kind 1 set：空路径替换根；对象键插入/覆盖；数组下标 < len 覆盖、
/// == len 追加，其余越界忽略。
fn apply_set(doc: &mut Value, entry: &Value) {
    let Some(path) = entry["k"].as_array() else {
        return;
    };
    if path.is_empty() {
        *doc = entry["v"].clone();
        return;
    }
    let Some((parent, last)) = locate_mut(doc, path) else {
        return;
    };
    match (parent, last) {
        (Value::Object(map), Value::String(key)) => {
            map.insert(key.clone(), entry["v"].clone());
        }
        (Value::Array(items), Value::Number(index)) => match index.as_u64().map(|i| i as usize) {
            Some(i) if i < items.len() => items[i] = entry["v"].clone(),
            Some(i) if i == items.len() => items.push(entry["v"].clone()),
            _ => {}
        },
        _ => {}
    }
}

/// kind 2 push：带 `i` 先把目标数组截断到长度 i 再追加 `v`
/// （目标不存在时视为空数组）。
fn apply_push(doc: &mut Value, entry: &Value) {
    let Some(path) = entry["k"].as_array() else {
        return;
    };
    let Some((parent, last)) = locate_mut(doc, path) else {
        return;
    };
    let target = match (parent, last) {
        (Value::Object(map), Value::String(key)) => Some(
            map.entry(key.clone())
                .or_insert_with(|| Value::Array(Vec::new())),
        ),
        (Value::Array(items), Value::Number(index)) => {
            index.as_u64().and_then(|i| items.get_mut(i as usize))
        }
        _ => None,
    };
    let Some(items) = target.and_then(Value::as_array_mut) else {
        return;
    };
    if let Some(i) = entry["i"].as_u64() {
        items.truncate(i as usize);
    }
    match entry.get("v") {
        Some(Value::Array(values)) => items.extend(values.iter().cloned()),
        Some(value) => items.push(value.clone()),
        None => {}
    }
}

/// kind 3 删除：对象删键；数组下标置为 Null。
fn apply_remove(doc: &mut Value, entry: &Value) {
    let Some(path) = entry["k"].as_array() else {
        return;
    };
    let Some((parent, last)) = locate_mut(doc, path) else {
        return;
    };
    match (parent, last) {
        (Value::Object(map), Value::String(key)) => {
            map.remove(key);
        }
        (Value::Array(items), Value::Number(index)) => {
            if let Some(slot) = index.as_u64().and_then(|i| items.get_mut(i as usize)) {
                *slot = Value::Null;
            }
        }
        _ => {}
    }
}

fn millis_to_iso(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_default()
}

fn millis_field(value: &Value, key: &str) -> Option<i64> {
    value[key]
        .as_i64()
        .or_else(|| value[key].as_f64().map(|v| v as i64))
}

fn timestamp_field(value: &Value, key: &str) -> String {
    millis_field(value, key)
        .map(millis_to_iso)
        .unwrap_or_default()
}

/// `.jsonl` 快照没有 lastMessageDate：取 lastMessageDate 与各 request 的
/// timestamp/responseTimestamp 最大毫秒值，都没有时回落 creationDate。
fn last_timestamp(doc: &Value) -> String {
    let mut last = millis_field(doc, "lastMessageDate");
    for request in doc["requests"].as_array().into_iter().flatten() {
        for key in ["timestamp", "responseTimestamp"] {
            if let Some(ms) = millis_field(request, key) {
                last = Some(last.map_or(ms, |current| current.max(ms)));
            }
        }
    }
    last.or_else(|| millis_field(doc, "creationDate"))
        .map(millis_to_iso)
        .unwrap_or_default()
}

/// IMarkdownString（`{value}`）、`{text}`、字符串或数组的文本提取。
/// `extract_text` 不覆盖 `value` 键，这里单独处理。
fn markdown_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => (!text.trim().is_empty()).then(|| text.clone()),
        Value::Array(items) => {
            let text = items
                .iter()
                .filter_map(markdown_text)
                .collect::<Vec<_>>()
                .join("\n");
            (!text.is_empty()).then_some(text)
        }
        Value::Object(_) => value["value"]
            .as_str()
            .or_else(|| value["text"].as_str())
            .filter(|text| !text.trim().is_empty())
            .map(str::to_string),
        _ => None,
    }
}

fn tool_invocation_message(item: &Value, timestamp: &str) -> Value {
    let name = item["toolId"]
        .as_str()
        .or_else(|| item["toolName"].as_str())
        .or_else(|| item["toolSpecificData"]["toolId"].as_str())
        .unwrap_or("tool");
    let mut parts = Vec::new();
    if let Some(text) = markdown_text(&item["invocationMessage"])
        .or_else(|| markdown_text(&item["pastTenseMessage"]))
    {
        parts.push(text);
    }
    if let Some(command) = item["toolSpecificData"]["commandLine"]["commandLine"]
        .as_str()
        .or_else(|| item["toolSpecificData"]["command"].as_str())
    {
        parts.push(format!("`{command}`"));
    }
    if let Some(result) =
        markdown_text(&item["resultDetails"]).or_else(|| extract_text(&item["resultDetails"]))
    {
        parts.push(result);
    }
    let mut value = message_value(
        "tool",
        &parts.join("\n"),
        timestamp,
        "chat_request",
        "tool_invocation",
        false,
    );
    value["tool_name"] = Value::String(name.to_string());
    value["tool_kind"] = Value::String("tool_result".into());
    if let Some(id) = item["toolCallId"].as_str().filter(|v| !v.is_empty()) {
        value["tool_call_id"] = Value::String(id.to_string());
    }
    if item["resultDetails"]["isError"].as_bool() == Some(true)
        || item["isError"].as_bool() == Some(true)
    {
        value["is_error"] = Value::Bool(true);
    }
    value
}

fn text_edit_message(item: &Value, timestamp: &str) -> Value {
    let uri = &item["uri"];
    let path = uri["path"]
        .as_str()
        .or_else(|| uri["fsPath"].as_str())
        .unwrap_or_default();
    let name = Path::new(path)
        .file_name()
        .and_then(|v| v.to_str())
        .unwrap_or(path);
    // edits 是二维数组（每批一组 TextEdit），修改处数取内层长度之和。
    let edits = item["edits"]
        .as_array()
        .map(|groups| {
            groups
                .iter()
                .map(|batch| batch.as_array().map_or(1, Vec::len))
                .sum::<usize>()
        })
        .unwrap_or(0);
    let mut value = message_value(
        "tool",
        &format!("编辑 {name}（{edits} 处修改）"),
        timestamp,
        "chat_request",
        "text_edit",
        false,
    );
    value["tool_name"] = Value::String("textEdit".into());
    value["tool_kind"] = Value::String("tool_result".into());
    value
}

/// inlineReference 内联文件引用：优先 `name`，其次 `inlineReference.name`，
/// 否则取 `inlineReference` 里 URI 路径的文件名。
fn inline_reference_name(item: &Value) -> Option<String> {
    if let Some(name) = item["name"].as_str().filter(|v| !v.is_empty()) {
        return Some(name.to_string());
    }
    let reference = &item["inlineReference"];
    if let Some(name) = reference["name"].as_str().filter(|v| !v.is_empty()) {
        return Some(name.to_string());
    }
    let raw = reference
        .as_str()
        .or_else(|| reference["uri"]["path"].as_str())
        .or_else(|| reference["path"].as_str())
        .or_else(|| reference["location"]["uri"]["path"].as_str())
        .filter(|v| !v.is_empty())?;
    let decoded = percent_decode_str(raw).decode_utf8().unwrap_or_default();
    Path::new(decoded.as_ref())
        .file_name()
        .and_then(|v| v.to_str())
        .map(str::to_string)
        .or(Some(decoded.into_owned()))
}

/// 正文类片段：裸字符串、无 kind 的 IMarkdownString（`{value}`）、
/// markdownContent/markdownVuln 的 content、inlineReference（渲染为 `name`）。
fn text_fragment(item: &Value) -> Option<String> {
    // 取原始文本，保留纯空白片段（段落间换行、引用旁空格），合并时才不会粘连。
    let raw = |value: &Value| {
        value
            .as_str()
            .or_else(|| value["value"].as_str())
            .map(str::to_string)
    };
    match item["kind"].as_str() {
        Some("markdownContent" | "markdownVuln") => raw(&item["content"]),
        Some("inlineReference") => inline_reference_name(item).map(|name| format!("`{name}`")),
        // 持久化的正文是不带 kind 的裸 IMarkdownString，旧数据还可能是纯字符串。
        None => raw(item),
        _ => None,
    }
}

fn flush_text(buffer: &mut String, messages: &mut Vec<Value>, timestamp: &str) {
    if !buffer.trim().is_empty() {
        messages.push(message_value(
            "assistant",
            buffer,
            timestamp,
            "chat_request",
            "markdown",
            false,
        ));
    }
    buffer.clear();
}

/// 一个 request 的 response 数组：连续正文片段合并为一条 assistant 消息
/// （VS Code 本身直接拼接 value，不加额外换行）；thinking/progress/
/// toolInvocation/textEditGroup 等结构性片段先冲刷正文再各自输出；
/// codeblockUri、undoStop 等未知 kind 忽略且不冲刷，避免拆开代码块。
/// response 为字符串时按单个正文片段处理。
fn response_messages(response: &Value, timestamp: &str) -> Vec<Value> {
    let mut messages = Vec::new();
    let mut buffer = String::new();
    for item in response
        .as_array()
        .into_iter()
        .flatten()
        .chain((!response.is_array()).then_some(response))
    {
        if let Some(fragment) = text_fragment(item) {
            buffer.push_str(&fragment);
            continue;
        }
        match item["kind"].as_str().unwrap_or_default() {
            "thinking" => {
                flush_text(&mut buffer, &mut messages, timestamp);
                if let Some(text) =
                    markdown_text(&item["value"]).or_else(|| markdown_text(&item["thinking"]))
                {
                    messages.push(message_value(
                        "assistant",
                        &text,
                        timestamp,
                        "chat_request",
                        "thinking",
                        true,
                    ));
                }
            }
            "progressMessage" | "progressMessageWithSpinner" => {
                flush_text(&mut buffer, &mut messages, timestamp);
                if let Some(text) = markdown_text(&item["content"]) {
                    messages.push(message_value(
                        "assistant",
                        &text,
                        timestamp,
                        "chat_request",
                        "progress",
                        true,
                    ));
                }
            }
            "toolInvocationSerialized" | "toolInvocation" => {
                flush_text(&mut buffer, &mut messages, timestamp);
                messages.push(tool_invocation_message(item, timestamp));
            }
            "prepareToolInvocation" => {
                flush_text(&mut buffer, &mut messages, timestamp);
                let name = item["toolName"].as_str().unwrap_or("tool");
                let mut value = message_value(
                    "tool",
                    &format!("[{name}]"),
                    timestamp,
                    "chat_request",
                    "tool_call",
                    false,
                );
                value["tool_name"] = Value::String(name.to_string());
                value["tool_kind"] = Value::String("tool_call".into());
                messages.push(value);
            }
            "textEditGroup" => {
                flush_text(&mut buffer, &mut messages, timestamp);
                messages.push(text_edit_message(item, timestamp));
            }
            _ => {}
        }
    }
    flush_text(&mut buffer, &mut messages, timestamp);
    messages
}

fn request_timestamp(request: &Value, fallback: &str) -> String {
    let stamp = timestamp_field(request, "timestamp");
    if stamp.is_empty() {
        fallback.to_string()
    } else {
        stamp
    }
}

fn request_messages(request: &Value, fallback_ts: &str) -> Vec<Value> {
    let timestamp = request_timestamp(request, fallback_ts);
    let mut messages = Vec::new();
    let user_text = request["message"]
        .as_str()
        .map(str::to_string)
        .or_else(|| markdown_text(&request["message"]));
    if let Some(text) = user_text.filter(|text| !text.trim().is_empty()) {
        messages.push(message_value(
            "user",
            &text,
            &timestamp,
            "chat_request",
            "user",
            false,
        ));
    }
    messages.extend(response_messages(&request["response"], &timestamp));
    if let Some(error) = request["result"]["errorDetails"]["message"]
        .as_str()
        .map(str::to_string)
        .or_else(|| markdown_text(&request["result"]["errorDetails"]))
    {
        let mut value = message_value(
            "assistant",
            &error,
            &timestamp,
            "chat_request",
            "error",
            false,
        );
        value["is_error"] = Value::Bool(true);
        messages.push(value);
    }
    messages
}

fn build_state(path: &Path, doc: &Value, cwd: &str) -> ParseState {
    let mut state = ParseState::new(path);
    if let Some(id) = doc["sessionId"].as_str().filter(|v| !v.is_empty()) {
        state.id = id.to_string();
    }
    state.timestamp = timestamp_field(doc, "creationDate");
    state.last_timestamp = last_timestamp(doc);
    if state.last_timestamp.is_empty() {
        state.last_timestamp = state.timestamp.clone();
    }
    state.cwd = cwd.to_string();
    state.event_count = doc["requests"].as_array().map_or(0, Vec::len);
    let fallback_ts = state.timestamp.clone();
    for request in doc["requests"].as_array().into_iter().flatten() {
        for message in request_messages(request, &fallback_ts) {
            state.accept_message(message);
        }
    }
    state
}

fn model_label(doc: &Value) -> Option<String> {
    let model = &doc["inputState"]["selectedModel"];
    model["name"]
        .as_str()
        .or_else(|| model["family"].as_str())
        .or_else(|| model["id"].as_str())
        .filter(|v| !v.is_empty())
        .map(str::to_string)
}

fn apply_session_meta(summary: &mut Value, doc: &Value) {
    // 用户自定义标题优先；否则沿用首条用户消息/目录名的默认逻辑。
    if let Some(title) = doc["customTitle"].as_str().filter(|v| !v.trim().is_empty()) {
        summary["title"] = Value::String(compact_title(title, 90));
    }
    summary["source_read_only"] = Value::Bool(true);
}

fn session_payload(doc: &Value) -> Value {
    json!({
        "sessionId": doc["sessionId"],
        "version": doc["version"],
        "responderUsername": doc["responderUsername"],
        "initialLocation": doc["initialLocation"],
        "customTitle": doc["customTitle"],
        "isImported": doc["isImported"],
        "selectedModel": doc["inputState"]["selectedModel"]["name"]
            .as_str()
            .or_else(|| doc["inputState"]["selectedModel"]["family"].as_str()),
    })
}

pub(super) fn parse_summary(path: &Path, source: &Source) -> Result<(Value, String), String> {
    let doc = read_document(path)?;
    let cwd = session_cwd(path, &doc);
    let state = build_state(path, &doc, &cwd);
    let mut summary = state.summary(path, source);
    apply_session_meta(&mut summary, &doc);
    let mut search = summary_search_text(&summary);
    append_limited(&mut search, &[&state.search_text], SEARCH_TEXT_LIMIT);
    if let Some(model) = model_label(&doc) {
        append_limited(&mut search, &[&model], SEARCH_TEXT_LIMIT);
    }
    if let Some(responder) = doc["responderUsername"].as_str() {
        append_limited(&mut search, &[responder], SEARCH_TEXT_LIMIT);
    }
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
    let doc = read_document(path)?;
    let cwd = session_cwd(path, &doc);
    let state = build_state(path, &doc, &cwd);
    let mut messages = HeadTail::new(DETAIL_MESSAGE_LIMIT);
    let mut events = HeadTail::new(DETAIL_EVENT_LIMIT);
    let fallback_ts = state.timestamp.clone();

    events.push(json!({
        "line_number": Value::Null,
        "timestamp": nullable(&state.timestamp),
        "type": "session",
        "payload": session_payload(&doc),
    }));
    for (request_index, request) in doc["requests"].as_array().into_iter().flatten().enumerate() {
        for (message_index, mut message) in request_messages(request, &fallback_ts)
            .into_iter()
            .enumerate()
        {
            attach_message_key(
                &mut message,
                json!({
                    "kind": "vscode_chat_request",
                    "session_id": state.id,
                    "request_index": request_index,
                    "request_id": request["requestId"],
                    "message_index": message_index,
                }),
            );
            visitor(&message);
            truncate_message(&mut message);
            messages.push(message);
        }
        let serialized = request.to_string();
        let payload = if serialized.chars().count() > 10_000 {
            json!({ "truncated": true, "original_chars": serialized.chars().count() })
        } else {
            request.clone()
        };
        events.push(json!({
            "line_number": Value::Null,
            "timestamp": nullable(&request_timestamp(request, &fallback_ts)),
            "type": "request",
            "payload": payload,
        }));
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
    apply_session_meta(&mut summary, &doc);
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

fn nullable(value: &str) -> Value {
    if value.is_empty() {
        Value::Null
    } else {
        Value::String(value.into())
    }
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use tempfile::tempdir;

    use super::{
        discover_files, matches_path, parse_detail, parse_summary, shadowed_flat_path, uri_to_path,
    };
    use crate::sessions::{Source, SourceFormat};

    fn source(root: &Path) -> Source {
        Source {
            kind: "vscode_copilot",
            display_name: "VS Code Copilot Chat",
            root: root.into(),
            format: SourceFormat::VsCodeCopilot,
            archived: false,
        }
    }

    fn write_session(user_dir: &Path, hash: &str, id: &str, doc: &str) -> PathBuf {
        let dir = user_dir
            .join("workspaceStorage")
            .join(hash)
            .join("chatSessions");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("{id}.json"));
        std::fs::write(&path, doc).unwrap();
        path
    }

    fn write_workspace(user_dir: &Path, hash: &str, folder_uri: &str) {
        let dir = user_dir.join("workspaceStorage").join(hash);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("workspace.json"),
            format!("{{\"folder\": \"{folder_uri}\"}}"),
        )
        .unwrap();
    }

    fn sample_doc(id: &str) -> String {
        format!(
            r#"{{
            "version": 3,
            "sessionId": "{id}",
            "creationDate": 1760514473246,
            "lastMessageDate": 1760514490000,
            "customTitle": "修复登录缺陷",
            "responderUsername": "GitHub Copilot",
            "initialLocation": "panel",
            "inputState": {{"selectedModel": {{"name": "GPT-4.1"}}}},
            "requests": [
                {{
                    "requestId": "req-1",
                    "message": {{"text": "帮我修复登录缺陷", "parts": []}},
                    "timestamp": 1760514475000,
                    "response": [
                        {{"kind": "thinking", "value": "先定位登录入口"}},
                        {{"value": "问题在 auth.rs 的 token 校验，见 ", "supportThemeIcons": false}},
                        {{"kind": "inlineReference", "inlineReference": {{"uri": {{"path": "/work/ax/src/auth.rs"}}}}}},
                        {{"kind": "codeblockUri", "uri": {{"path": "file:///work/ax/src/auth.rs"}}}},
                        {{"value": " 的校验逻辑", "supportThemeIcons": false}},
                        {{"kind": "toolInvocationSerialized", "toolId": "copilot_readFile", "toolCallId": "call-1", "invocationMessage": {{"value": "读取 auth.rs"}}, "isComplete": true, "resultDetails": {{"input": {{"value": "auth.rs"}}, "output": {{"value": "fn verify() {{}}"}}, "isError": false}}}},
                        {{"kind": "textEditGroup", "uri": {{"path": "/work/ax/src/auth.rs"}}, "edits": [[{{"range": {{}}, "text": "x"}}]], "done": true}},
                        {{"kind": "markdownContent", "content": {{"value": "已修复"}}}}
                    ]
                }},
                {{
                    "requestId": "req-2",
                    "message": "再补充测试",
                    "timestamp": 1760514485000,
                    "response": [
                        {{"kind": "markdownContent", "content": {{"value": "已添加 auth.test.rs"}}}}
                    ],
                    "result": {{"errorDetails": {{"message": "rate limited"}}}}
                }}
            ]
        }}"#
        )
    }

    #[test]
    fn 解析会话并映射工作区() {
        let directory = tempdir().unwrap();
        let user_dir = directory.path();
        write_workspace(user_dir, "abc123", "file:///work/ax%20proj");
        let path = write_session(user_dir, "abc123", "s-1", &sample_doc("s-1"));

        let (summary, search) = parse_summary(&path, &source(user_dir)).unwrap();
        assert_eq!(summary["id"], "s-1");
        assert_eq!(summary["_key"], "vscode_copilot:s-1");
        assert_eq!(summary["cwd"], "/work/ax proj");
        assert_eq!(summary["title"], "修复登录缺陷");
        assert_eq!(summary["source_kind"], "vscode_copilot");
        assert_eq!(summary["source_read_only"], true);
        assert_eq!(summary["model_provider"], "github");
        assert_eq!(summary["originator"], "vscode_copilot_chat");
        // user×2 + assistant×4（合并正文、"已修复"、"已添加"、errorDetails）
        // + tool×2 = 8；thinking 计入上下文。
        assert_eq!(summary["message_count"], 8);
        assert_eq!(summary["context_count"], 1);
        assert_eq!(summary["tool_count"], 2);
        assert_eq!(summary["timestamp"], "2025-10-15T07:47:53.246Z");
        assert_eq!(summary["last_timestamp"], "2025-10-15T07:48:10.000Z");
        assert!(search.contains("修复登录缺陷"));
        assert!(search.contains("GPT-4.1"));

        let detail = parse_detail(&path, &source(user_dir)).unwrap();
        let messages = detail["conversation_messages"].as_array().unwrap();
        assert_eq!(messages.len(), 9);
        // 裸 markdown + inlineReference + codeblockUri + 裸 markdown 合并成一条。
        let merged = messages
            .iter()
            .find(|m| {
                m["text"]
                    .as_str()
                    .unwrap_or_default()
                    .contains("问题在 auth.rs")
            })
            .unwrap();
        let merged_text = merged["text"].as_str().unwrap();
        assert!(merged_text.contains("`auth.rs`"));
        assert!(merged_text.ends_with("的校验逻辑"));
        let tool = messages
            .iter()
            .find(|m| m["tool_name"] == "copilot_readFile")
            .unwrap();
        assert_eq!(tool["tool_call_id"], "call-1");
        assert!(tool["text"].as_str().unwrap().contains("读取 auth.rs"));
        assert!(messages.iter().all(|m| m["_message_key"].is_string()));
        let error = messages.iter().find(|m| m["is_error"] == true).unwrap();
        assert!(error["text"].as_str().unwrap().contains("rate limited"));
        assert_eq!(detail["raw_events"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn jsonl_追加日志回放() {
        let directory = tempdir().unwrap();
        let user_dir = directory.path();
        // 无 workspace.json；cwd 回落到快照里的 workingDirectory。
        let dir = user_dir
            .join("workspaceStorage")
            .join("log1")
            .join("chatSessions");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("log-1.jsonl");
        std::fs::write(
            &path,
            [
                r#"{"kind":0,"v":{"version":3,"sessionId":"log-1","creationDate":1760514473246,"workingDirectory":"file:///work/log%20dir","requests":[]}}"#,
                r#"{"kind":2,"k":["requests"],"v":[{"requestId":"r1","message":"记录日志","timestamp":1760514480000,"responseTimestamp":1760514485000,"response":[]},{"requestId":"stale","message":"会被截断的草稿","timestamp":1760514481000}]}"#,
                r#"{"kind":1,"k":["requests",0,"response"],"v":[{"value":"完成","supportThemeIcons":false}]}"#,
                r#"{"kind":1,"k":["customTitle"],"v":"日志会话"}"#,
                r#"{"kind":2,"k":["requests"],"i":1,"v":[{"requestId":"r2","message":"继续","timestamp":1760514490000,"responseTimestamp":1760514499000,"response":[]}]}"#,
            ]
            .join("\n"),
        )
        .unwrap();

        let (summary, _) = parse_summary(&path, &source(user_dir)).unwrap();
        assert_eq!(summary["id"], "log-1");
        assert_eq!(summary["title"], "日志会话");
        assert_eq!(summary["cwd"], "/work/log dir");
        // r1（user+assistant）+ r2（user）= 3；stale 被 i=1 截断丢弃。
        assert_eq!(summary["message_count"], 3);
        assert_eq!(summary["timestamp"], "2025-10-15T07:47:53.246Z");
        assert_eq!(summary["last_timestamp"], "2025-10-15T07:48:19.000Z");
    }

    #[test]
    fn jsonl_空会话解析为空摘要() {
        let directory = tempdir().unwrap();
        let user_dir = directory.path();
        let dir = user_dir
            .join("globalStorage")
            .join("emptyWindowChatSessions");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("empty-1.jsonl");
        std::fs::write(
            &path,
            r#"{"kind":0,"v":{"version":3,"sessionId":"empty-1","creationDate":1760514473246,"requests":[]}}"#,
        )
        .unwrap();
        let (summary, _) = parse_summary(&path, &source(user_dir)).unwrap();
        assert_eq!(summary["id"], "empty-1");
        assert_eq!(summary["message_count"], 0);
        assert_eq!(summary["cwd"], "");
        // 空日志文件（可能刚创建还没写入快照）视为错误，等下次变更重试。
        std::fs::write(&path, "").unwrap();
        assert!(parse_summary(&path, &source(user_dir)).is_err());
    }

    #[test]
    fn 空请求列表也能生成摘要() {
        let directory = tempdir().unwrap();
        let user_dir = directory.path();
        let path = write_session(
            user_dir,
            "def456",
            "empty-1",
            r#"{"version":3,"sessionId":"empty-1","creationDate":1760514473246,"lastMessageDate":1760514473246,"requests":[]}"#,
        );
        let (summary, _) = parse_summary(&path, &source(user_dir)).unwrap();
        assert_eq!(summary["id"], "empty-1");
        assert_eq!(summary["message_count"], 0);
        assert_eq!(summary["cwd"], "");
    }

    #[test]
    fn 发现工作区与空窗口会话() {
        let directory = tempdir().unwrap();
        let user_dir = directory.path();
        let a = write_session(user_dir, "h1", "a", "{}");
        let empty_dir = user_dir
            .join("globalStorage")
            .join("emptyWindowChatSessions");
        std::fs::create_dir_all(&empty_dir).unwrap();
        let b = empty_dir.join("b.json");
        std::fs::write(&b, "{}").unwrap();
        // 非会话文件不应被发现。
        std::fs::write(
            user_dir
                .join("workspaceStorage")
                .join("h1")
                .join("state.vscdb"),
            "x",
        )
        .unwrap();

        let found = discover_files(&source(user_dir));
        assert!(found.contains(&a));
        assert!(found.contains(&b));
        assert_eq!(found.len(), 2);
        assert!(matches_path(user_dir, &a));
        assert!(matches_path(user_dir, &b));
        assert!(!matches_path(
            user_dir,
            &user_dir
                .join("workspaceStorage")
                .join("h1")
                .join("workspace.json")
        ));
    }

    #[test]
    fn jsonl_取代同名_json() {
        let directory = tempdir().unwrap();
        let user_dir = directory.path();
        let flat = write_session(user_dir, "h1", "s-1", "{}");
        let log = flat.with_extension("jsonl");
        std::fs::write(&log, "{}").unwrap();

        let found = discover_files(&source(user_dir));
        assert_eq!(found, vec![log.clone()]);
        assert!(matches_path(user_dir, &log));
        assert!(!matches_path(user_dir, &flat));
        assert_eq!(shadowed_flat_path(&log), Some(flat.clone()));
        assert_eq!(shadowed_flat_path(&flat), None);
    }

    #[test]
    fn uri_解码() {
        assert_eq!(uri_to_path("file:///work/a%20b"), "/work/a b");
        assert_eq!(uri_to_path("file:///c%3A/Users/a%20b"), "c:/Users/a b");
        assert_eq!(uri_to_path("file://localhost/x/y"), "/x/y");
        assert_eq!(uri_to_path("file://server/share/x"), "//server/share/x");
        assert_eq!(
            uri_to_path("vscode-remote://ssh-remote%2Bhost/home/u/proj"),
            "vscode-remote://ssh-remote+host/home/u/proj"
        );
        assert_eq!(uri_to_path(""), "");
    }
}
