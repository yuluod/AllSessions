//! Hermes Agent（Nous Research）会话适配器（只读）。
//!
//! 数据布局（root 指向 Hermes 数据根，macOS/Linux 为 `~/.hermes`，
//! Windows 为 `%LOCALAPPDATA%\hermes`，`HERMES_HOME` 可覆盖）：
//! - `state.db`：SQLite 聚合库。`sessions` 表存会话元数据
//!   （source/model/title/cwd/git_branch 与 epoch 浮点时间戳），
//!   `messages` 表存全部会话消息（role/content/tool_calls/reasoning/active）。
//! - `profiles/<name>/state.db`：命名 profile 各自独立的 state.db。
//! - root 也可以直接指向某个 state.db 文件。
//!
//! 解析要点（对齐官方 session-storage 文档）：
//! - 就地压缩：旧消息行 `active=0` 归档，保留上下文重新插入 `active=1`；
//!   只读取 active 行，避免同一条消息出现两代。
//! - 委托子代理会话（`source='subagent'` 或 `model_config` 带
//!   `$._delegate_from` 标记）不进列表。
//! - 时间戳为 Unix epoch 浮点，统一转 ISO 8601。
//! - `content` 为空而 `reasoning` 非空的是思考行；Codex Responses 的最终
//!   回复可能只存在于 `codex_message_items`，按 content → codex_message_items
//!   顺序回退。
//! - 压缩分裂产生的 `parent_session_id` 链不合并：每代都是独立会话，
//!   且该字段在 AllSessions 里有子代理语义，不填充以免误导。
//! - 官方 schema_version 已到 30 且列集随版本增减，查询按现存列自适应，
//!   缺失的列以 null 占位，旧库与新库共用同一解析路径。
//!
//! 来源整体只读，不生成 `_delete_ref`。

use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

use rusqlite::{Connection, OpenFlags, Row};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::{
    append_limited, attach_message_key, message_value, summary_search_text, timestamp_from_millis,
    truncate_message, HeadTail, ParseState, Source, DETAIL_EVENT_LIMIT, DETAIL_MESSAGE_LIMIT,
    SEARCH_TEXT_LIMIT,
};

const STATE_DB: &str = "state.db";
/// 原始消息字段超过该字符数时只保留元信息。
const RAW_PAYLOAD_LIMIT: usize = 10_000;

/// 单库/单会话级错误：（路径，会话标识，错误描述）。
type ScanError = (PathBuf, String, String);

pub(super) struct ParsedSource {
    pub sessions: Vec<ParsedSession>,
    pub active_paths: BTreeSet<String>,
    pub errors: Vec<ScanError>,
}

pub(super) struct ParsedSession {
    pub summary: Value,
    pub search_text: String,
    pub path: PathBuf,
    pub detail_locator: DetailLocator,
}

#[derive(Clone)]
pub(super) struct DetailLocator {
    database_path: PathBuf,
    session_id: String,
    pub(super) content_fingerprint: String,
}

struct SessionRow {
    id: String,
    source: String,
    model: String,
    model_config: String,
    title: String,
    cwd: String,
    git_branch: String,
    git_repo_root: String,
    started_at: f64,
    ended_at: Option<f64>,
}

struct MessageRow {
    id: i64,
    role: String,
    content: String,
    tool_call_id: String,
    tool_calls: String,
    tool_name: String,
    timestamp: f64,
    reasoning: String,
    codex_message_items: String,
}

fn state_databases(root: &Path) -> Vec<PathBuf> {
    if root.is_file() {
        return vec![root.to_path_buf()];
    }
    let mut paths = vec![root.join(STATE_DB)];
    if let Ok(entries) = fs::read_dir(root.join("profiles")) {
        for entry in entries.flatten() {
            let candidate = entry.path().join(STATE_DB);
            if entry.path().is_dir() && candidate.is_file() {
                paths.push(candidate);
            }
        }
    }
    paths.sort();
    paths
}

fn open_database(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| format!("无法只读打开 Hermes 状态库（{}）：{error}", path.display()))?;
    connection
        .busy_timeout(Duration::from_secs(2))
        .map_err(|error| format!("无法配置 Hermes 状态库读取超时：{error}"))?;
    Ok(connection)
}

fn validate_tables(connection: &Connection) -> Result<(), String> {
    for table in ["sessions", "messages"] {
        let count = connection
            .query_row(
                "select count(*) from sqlite_master where type = 'table' and name = ?1",
                [table],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| format!("无法检查 Hermes 状态库结构：{error}"))?;
        if count != 1 {
            return Err("不是受支持的 Hermes 状态库（缺少 sessions/messages 表）".into());
        }
    }
    Ok(())
}

fn existing_columns(connection: &Connection, table: &str) -> BTreeMap<String, usize> {
    let mut columns = BTreeMap::new();
    let Ok(mut statement) = connection.prepare(&format!("pragma table_info({table})")) else {
        return columns;
    };
    let Ok(mut rows) = statement.query([]) else {
        return columns;
    };
    while let Ok(Some(row)) = rows.next() {
        if let Ok(name) = row.get::<_, String>(1) {
            columns.insert(name, columns.len());
        }
    }
    columns
}

/// 缺失列以 null 占位，行内索引保持稳定；session_id 由调用方绑定。
fn session_select_sql(columns: &BTreeMap<String, usize>) -> String {
    let column = |name: &str| {
        if columns.contains_key(name) {
            name.to_string()
        } else {
            "null".to_string()
        }
    };
    format!(
        "select id, source, {model}, {model_config}, {title}, {cwd}, {git_branch}, \
         {git_repo_root}, started_at, {ended_at} from sessions order by started_at",
        model = column("model"),
        model_config = column("model_config"),
        title = column("title"),
        cwd = column("cwd"),
        git_branch = column("git_branch"),
        git_repo_root = column("git_repo_root"),
        ended_at = column("ended_at"),
    )
}

fn session_row(row: &Row<'_>) -> SessionRow {
    SessionRow {
        id: row.get::<_, String>(0).unwrap_or_default(),
        source: row.get::<_, String>(1).unwrap_or_default(),
        model: row.get::<_, Option<String>>(2).unwrap_or_default().unwrap_or_default(),
        model_config: row.get::<_, Option<String>>(3).unwrap_or_default().unwrap_or_default(),
        title: row.get::<_, Option<String>>(4).unwrap_or_default().unwrap_or_default(),
        cwd: row.get::<_, Option<String>>(5).unwrap_or_default().unwrap_or_default(),
        git_branch: row.get::<_, Option<String>>(6).unwrap_or_default().unwrap_or_default(),
        git_repo_root: row.get::<_, Option<String>>(7).unwrap_or_default().unwrap_or_default(),
        started_at: row.get::<_, f64>(8).unwrap_or_default(),
        ended_at: row.get::<_, Option<f64>>(9).unwrap_or_default(),
    }
}

/// reasoning 优先，缺失时回退 reasoning_content；active 过滤把归档代排除，
/// NULL 视为活跃（旧库没有该列时 coalesce 不生效于查询外）。
fn message_select_sql(columns: &BTreeMap<String, usize>) -> String {
    let column = |name: &str| {
        if columns.contains_key(name) {
            name.to_string()
        } else {
            "null".to_string()
        }
    };
    let reasoning = match (
        columns.contains_key("reasoning"),
        columns.contains_key("reasoning_content"),
    ) {
        (true, true) => "coalesce(nullif(reasoning, ''), nullif(reasoning_content, ''))".to_string(),
        (true, false) => column("reasoning"),
        (false, true) => column("reasoning_content"),
        (false, false) => "null".to_string(),
    };
    let active_filter = if columns.contains_key("active") {
        " and coalesce(active, 1) != 0"
    } else {
        ""
    };
    format!(
        "select id, role, {content}, {tool_call_id}, {tool_calls}, {tool_name}, timestamp, \
         {reasoning} as reasoning, {codex_message_items} \
         from messages where session_id = ?1{active_filter} order by timestamp, id",
        content = column("content"),
        tool_call_id = column("tool_call_id"),
        tool_calls = column("tool_calls"),
        tool_name = column("tool_name"),
        codex_message_items = column("codex_message_items"),
    )
}

fn message_row(row: &Row<'_>) -> MessageRow {
    MessageRow {
        id: row.get::<_, i64>(0).unwrap_or_default(),
        role: row.get::<_, String>(1).unwrap_or_default(),
        content: row.get::<_, Option<String>>(2).unwrap_or_default().unwrap_or_default(),
        tool_call_id: row.get::<_, Option<String>>(3).unwrap_or_default().unwrap_or_default(),
        tool_calls: row.get::<_, Option<String>>(4).unwrap_or_default().unwrap_or_default(),
        tool_name: row.get::<_, Option<String>>(5).unwrap_or_default().unwrap_or_default(),
        timestamp: row.get::<_, f64>(6).unwrap_or_default(),
        reasoning: row.get::<_, Option<String>>(7).unwrap_or_default().unwrap_or_default(),
        codex_message_items: row
            .get::<_, Option<String>>(8)
            .unwrap_or_default()
            .unwrap_or_default(),
    }
}

fn load_sessions(
    connection: &Connection,
    columns: &BTreeMap<String, usize>,
) -> Result<Vec<SessionRow>, String> {
    let mut statement = connection
        .prepare(&session_select_sql(columns))
        .map_err(|error| format!("无法查询 Hermes 会话：{error}"))?;
    let mut rows = statement
        .query([])
        .map_err(|error| format!("无法查询 Hermes 会话：{error}"))?;
    let mut sessions = Vec::new();
    while let Some(row) = rows
        .next()
        .map_err(|error| format!("无法读取 Hermes 会话：{error}"))?
    {
        sessions.push(session_row(row));
    }
    Ok(sessions)
}

fn load_messages(
    connection: &Connection,
    columns: &BTreeMap<String, usize>,
    session_id: &str,
) -> Result<Vec<MessageRow>, String> {
    let mut statement = connection
        .prepare(&message_select_sql(columns))
        .map_err(|error| format!("无法查询 Hermes 消息：{error}"))?;
    let mut rows = statement
        .query([session_id])
        .map_err(|error| format!("无法查询 Hermes 消息：{error}"))?;
    let mut messages = Vec::new();
    while let Some(row) = rows
        .next()
        .map_err(|error| format!("无法读取 Hermes 消息：{error}"))?
    {
        messages.push(message_row(row));
    }
    Ok(messages)
}

/// epoch 浮点秒转毫秒级 ISO 8601；非法值视为缺失。
fn iso_timestamp(seconds: f64) -> String {
    if !seconds.is_finite() || seconds <= 0.0 {
        return String::new();
    }
    timestamp_from_millis((seconds * 1000.0) as i64).unwrap_or_default()
}

/// 委托子代理会话：source 标记或 model_config 的 `$._delegate_from` 键。
fn is_delegate_session(row: &SessionRow) -> bool {
    if row.source == "subagent" {
        return true;
    }
    serde_json::from_str::<Value>(&row.model_config)
        .ok()
        .and_then(|config| {
            config.as_object().map(|object| {
                object.contains_key("$._delegate_from") || object.contains_key("_delegate_from")
            })
        })
        .unwrap_or(false)
}

/// Hermes 模型引用形如 `anthropic/claude-sonnet-4.6`，取首个 `/` 前
/// 作为 provider；无法拆分时不做推断。
fn model_provider(model: &str) -> String {
    model
        .split_once('/')
        .map(|(provider, _)| provider)
        .filter(|provider| !provider.is_empty())
        .unwrap_or("unknown")
        .to_string()
}

/// 从 codex_message_items（Codex Responses 投影）里收集输出文本，
/// 跳过 reasoning/summary 等非正文键。仅作 content 为空时的回退。
fn collect_text_fragments(value: &Value, parts: &mut Vec<String>) {
    match value {
        Value::Array(items) => {
            for item in items {
                collect_text_fragments(item, parts);
            }
        }
        Value::Object(object) => {
            for (key, item) in object {
                if key == "text" {
                    if let Some(text) = item.as_str().filter(|text| !text.trim().is_empty()) {
                        parts.push(text.to_string());
                    }
                } else if !matches!(key.as_str(), "reasoning" | "summary") {
                    collect_text_fragments(item, parts);
                }
            }
        }
        _ => {}
    }
}

fn codex_reply_text(raw: &str) -> String {
    let Ok(items) = serde_json::from_str::<Value>(raw) else {
        return String::new();
    };
    let mut parts = Vec::new();
    collect_text_fragments(&items, &mut parts);
    parts.join("\n")
}

fn tool_call_values(
    raw: &str,
    timestamp: &str,
    tool_names: &mut HashMap<String, String>,
) -> Vec<Value> {
    let Ok(calls) = serde_json::from_str::<Value>(raw) else {
        return Vec::new();
    };
    let mut values = Vec::new();
    for call in calls.as_array().into_iter().flatten() {
        // OpenAI 风格 {id, function:{name, arguments}}，兼容扁平 {id, name, arguments}。
        let function = &call["function"];
        let name = function["name"]
            .as_str()
            .or_else(|| call["name"].as_str())
            .unwrap_or("tool");
        let id = call["id"].as_str().unwrap_or_default();
        let arguments = if function.get("arguments").is_some_and(|value| !value.is_null()) {
            &function["arguments"]
        } else {
            &call["arguments"]
        };
        let text = match arguments {
            Value::String(text) => text.clone(),
            Value::Null => String::new(),
            other => serde_json::to_string_pretty(other).unwrap_or_default(),
        };
        let mut value = message_value(
            "tool",
            &format!("[{name}] {text}"),
            timestamp,
            "hermes",
            "tool_call",
            false,
        );
        value["tool_name"] = Value::String(name.to_string());
        value["tool_kind"] = Value::String("tool_call".into());
        if !id.is_empty() {
            value["tool_call_id"] = Value::String(id.to_string());
            tool_names.insert(id.to_string(), name.to_string());
        }
        values.push(value);
    }
    values
}

/// 一条 messages 行转成会话消息；tool_names 用于 tool_call_id → 工具名回填。
fn hermes_messages(row: &MessageRow, tool_names: &mut HashMap<String, String>) -> Vec<Value> {
    let timestamp = iso_timestamp(row.timestamp);
    let mut messages = Vec::new();
    match row.role.as_str() {
        "system" | "developer" => {
            if !row.content.trim().is_empty() {
                messages.push(message_value(
                    &row.role,
                    &row.content,
                    &timestamp,
                    "hermes",
                    "context",
                    true,
                ));
            }
        }
        "user" => {
            if !row.content.trim().is_empty() {
                messages.push(message_value(
                    "user",
                    &row.content,
                    &timestamp,
                    "hermes",
                    "text",
                    false,
                ));
            }
        }
        "assistant" => {
            if !row.reasoning.trim().is_empty() {
                messages.push(message_value(
                    "assistant",
                    &row.reasoning,
                    &timestamp,
                    "hermes",
                    "thinking",
                    true,
                ));
            }
            let reply = if row.content.trim().is_empty() {
                codex_reply_text(&row.codex_message_items)
            } else {
                row.content.clone()
            };
            if !reply.trim().is_empty() {
                messages.push(message_value(
                    "assistant",
                    &reply,
                    &timestamp,
                    "hermes",
                    "text",
                    false,
                ));
            }
            messages.extend(tool_call_values(&row.tool_calls, &timestamp, tool_names));
        }
        "tool" => {
            if row.content.trim().is_empty() {
                return messages;
            }
            let name = if row.tool_call_id.is_empty() && !row.tool_name.is_empty() {
                row.tool_name.clone()
            } else {
                tool_names
                    .get(&row.tool_call_id)
                    .cloned()
                    .unwrap_or_else(|| "tool_result".to_string())
            };
            let mut value = message_value(
                "tool",
                &row.content,
                &timestamp,
                "hermes",
                "tool_result",
                false,
            );
            value["tool_kind"] = Value::String("tool_result".into());
            value["tool_name"] = Value::String(name);
            if !row.tool_call_id.is_empty() {
                value["tool_call_id"] = Value::String(row.tool_call_id.clone());
            }
            messages.push(value);
        }
        _ => {}
    }
    messages
}

fn session_state(database: &Path, row: &SessionRow) -> ParseState {
    let mut state = ParseState::new(database);
    state.id = row.id.clone();
    state.originator = "hermes_agent".into();
    state.provider = model_provider(&row.model);
    state.timestamp = iso_timestamp(row.started_at);
    state.last_timestamp = row.ended_at.map(iso_timestamp).unwrap_or_default();
    state.cwd = if row.cwd.is_empty() {
        row.git_repo_root.clone()
    } else {
        row.cwd.clone()
    };
    state
}

fn hermes_summary(
    state: &ParseState,
    row: &SessionRow,
    database: &Path,
    source: &Source,
) -> (Value, String) {
    let mut summary = state.summary(database, source);
    if !row.title.trim().is_empty() {
        summary["title"] = Value::String(row.title.trim().to_string());
    }
    summary["source_read_only"] = Value::Bool(true);
    let mut search_text = summary_search_text(&summary);
    append_limited(&mut search_text, &[&state.search_text], SEARCH_TEXT_LIMIT);
    append_limited(
        &mut search_text,
        &[&row.model, &row.source, &row.git_branch, &row.git_repo_root],
        SEARCH_TEXT_LIMIT,
    );
    (summary, search_text)
}

fn hash_message(hash: &mut Sha256, row: &MessageRow) {
    hash.update(row.id.to_string().as_bytes());
    hash.update([0]);
    hash.update(row.role.as_bytes());
    hash.update([0]);
    hash.update(row.timestamp.to_string().as_bytes());
    hash.update([0]);
    for text in [
        &row.content,
        &row.tool_calls,
        &row.reasoning,
        &row.codex_message_items,
        &row.tool_call_id,
        &row.tool_name,
    ] {
        hash.update(text.as_bytes());
        hash.update([0]);
    }
}

fn scan_session(
    connection: &Connection,
    database: &Path,
    row: &SessionRow,
    source: &Source,
    message_columns: &BTreeMap<String, usize>,
) -> Result<Option<ParsedSession>, String> {
    let messages = load_messages(connection, message_columns, &row.id)?;
    let mut state = session_state(database, row);
    let mut content_hash = Sha256::new();
    content_hash.update(
        json!([
            row.id,
            row.source,
            row.model,
            row.title,
            row.cwd,
            row.started_at,
            row.ended_at,
        ])
        .to_string()
        .as_bytes(),
    );
    let mut tool_names = HashMap::new();
    let mut last_activity = 0.0_f64;
    for message in &messages {
        hash_message(&mut content_hash, message);
        last_activity = last_activity.max(message.timestamp);
        state.event_count += 1;
        for value in hermes_messages(message, &mut tool_names) {
            state.accept_message(value);
        }
    }
    if state.message_count == 0 {
        return Ok(None);
    }
    // 活跃时间取最后一条消息，其次会话行的 ended_at。
    let last_timestamp = if last_activity > 0.0 {
        iso_timestamp(last_activity)
    } else if !state.last_timestamp.is_empty() {
        state.last_timestamp.clone()
    } else {
        state.timestamp.clone()
    };
    state.last_timestamp = last_timestamp;
    let (summary, search_text) = hermes_summary(&state, row, database, source);
    Ok(Some(ParsedSession {
        summary,
        search_text,
        path: database.to_path_buf(),
        detail_locator: DetailLocator {
            database_path: database.to_path_buf(),
            session_id: row.id.clone(),
            content_fingerprint: content_hash
                .finalize()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect(),
        },
    }))
}

fn scan_database(
    database: &Path,
    source: &Source,
) -> Result<(Vec<ParsedSession>, Vec<ScanError>), String> {
    let connection = open_database(database)?;
    validate_tables(&connection)?;
    let session_columns = existing_columns(&connection, "sessions");
    let message_columns = existing_columns(&connection, "messages");
    let mut sessions = Vec::new();
    let mut errors = Vec::new();
    for row in load_sessions(&connection, &session_columns)? {
        if is_delegate_session(&row) {
            continue;
        }
        match scan_session(&connection, database, &row, source, &message_columns) {
            Ok(Some(session)) => sessions.push(session),
            Ok(None) => {}
            Err(error) => errors.push((database.to_path_buf(), row.id.clone(), error)),
        }
    }
    Ok((sessions, errors))
}

pub(super) fn parse_source(source: &Source) -> Result<ParsedSource, String> {
    let mut sessions = Vec::new();
    let mut active_paths = BTreeSet::new();
    let mut errors = Vec::new();
    for database in state_databases(&source.root) {
        // 库文件不存在（如刚安装 Hermes）不算错误，留待后续刷新发现。
        if !database.is_file() {
            continue;
        }
        active_paths.insert(database.to_string_lossy().into_owned());
        match scan_database(&database, source) {
            Ok((mut database_sessions, mut database_errors)) => {
                sessions.append(&mut database_sessions);
                errors.append(&mut database_errors);
            }
            Err(error) => errors.push((database, "state.db".into(), error)),
        }
    }
    Ok(ParsedSource {
        sessions,
        active_paths,
        errors,
    })
}

/// 监听规则：主库与各 profile 库的 state.db 及其 -wal；
/// -shm 变化不触发（只读连接也可能更新共享内存）。
pub(super) fn matches_path(root: &Path, path: &Path) -> bool {
    state_databases(root)
        .iter()
        .any(|database| super::opencode_event_matches(database, path))
}

fn raw_payload(row: &MessageRow) -> Value {
    let total = row.content.chars().count()
        + row.tool_calls.chars().count()
        + row.reasoning.chars().count()
        + row.codex_message_items.chars().count();
    if total > RAW_PAYLOAD_LIMIT {
        return json!({
            "truncated": true,
            "original_chars": total,
            "role": row.role,
        });
    }
    json!({
        "role": row.role,
        "content": row.content,
        "tool_call_id": row.tool_call_id,
        "tool_calls": serde_json::from_str::<Value>(&row.tool_calls)
            .unwrap_or(Value::Null),
        "tool_name": row.tool_name,
        "reasoning": row.reasoning,
        "codex_message_items": serde_json::from_str::<Value>(&row.codex_message_items)
            .unwrap_or(Value::Null),
    })
}

pub(super) fn parse_detail(source: &Source, locator: &DetailLocator) -> Result<Value, String> {
    visit_detail(source, locator, &mut |_| {})
}

pub(super) fn visit_detail(
    source: &Source,
    locator: &DetailLocator,
    visitor: &mut dyn FnMut(&Value),
) -> Result<Value, String> {
    let connection = open_database(&locator.database_path)?;
    validate_tables(&connection)?;
    let message_columns = existing_columns(&connection, "messages");
    let session_columns = existing_columns(&connection, "sessions");
    let Some(row) = load_sessions(&connection, &session_columns)?
        .into_iter()
        .find(|row| row.id == locator.session_id)
    else {
        return Err("Hermes 会话已不存在".into());
    };
    let messages = load_messages(&connection, &message_columns, &locator.session_id)?;
    let mut state = session_state(&locator.database_path, &row);
    let mut detail_messages = HeadTail::new(DETAIL_MESSAGE_LIMIT);
    let mut events = HeadTail::new(DETAIL_EVENT_LIMIT);
    let mut tool_names = HashMap::new();
    let mut last_activity = 0.0_f64;
    for message in &messages {
        last_activity = last_activity.max(message.timestamp);
        state.event_count += 1;
        for mut value in hermes_messages(message, &mut tool_names)
            .into_iter()
            .filter_map(|value| state.accept_message(value))
        {
            attach_message_key(
                &mut value,
                json!({
                    "source_kind": "hermes",
                    "session_id": locator.session_id,
                    "message_id": message.id,
                }),
            );
            visitor(&value);
            truncate_message(&mut value);
            detail_messages.push(value);
        }
        events.push(json!({
            "line_number": message.id,
            "timestamp": iso_timestamp(message.timestamp),
            "type": message.role,
            "payload": raw_payload(message),
        }));
    }
    let last_timestamp = if last_activity > 0.0 {
        iso_timestamp(last_activity)
    } else if !state.last_timestamp.is_empty() {
        state.last_timestamp.clone()
    } else {
        state.timestamp.clone()
    };
    state.last_timestamp = last_timestamp;
    let (mut message_values, omitted_messages, total_messages) = detail_messages.finish(json!({
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
    let (mut summary, _) = hermes_summary(&state, &row, &locator.database_path, source);
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

    use rusqlite::{params, Connection};
    use tempfile::tempdir;

    use super::{matches_path, parse_detail, parse_source};
    use crate::sessions::{Source, SourceFormat};

    fn source(root: &Path) -> Source {
        Source {
            kind: "hermes",
            display_name: "Hermes Agent",
            root: root.into(),
            format: SourceFormat::Hermes,
            archived: false,
        }
    }

    fn create_state_db(path: &Path, minimal: bool) -> Connection {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        let connection = Connection::open(path).unwrap();
        // 旧版库只保留最小列集（started_at 之外全部缺失）。
        let sessions_sql = if minimal {
            "create table sessions (
                id text primary key,
                source text not null,
                started_at real not null
            );"
        } else {
            "create table sessions (
                id text primary key,
                source text not null,
                model text,
                model_config text,
                title text,
                cwd text,
                git_branch text,
                git_repo_root text,
                started_at real not null,
                ended_at real,
                parent_session_id text
            );"
        };
        connection
            .execute_batch(&format!(
                "{sessions_sql}
                create table messages (
                    id integer primary key autoincrement,
                    session_id text not null references sessions(id),
                    role text not null,
                    content text,
                    tool_call_id text,
                    tool_calls text,
                    tool_name text,
                    timestamp real not null,
                    reasoning text,
                    reasoning_content text,
                    codex_message_items text,
                    active integer
                );"
            ))
            .unwrap();
        connection
    }

    #[test]
    fn 解析会话消息与归档行过滤() {
        let directory = tempdir().unwrap();
        let root = directory.path();
        let database = root.join("state.db");
        let connection = create_state_db(&database, false);
        connection
            .execute(
                "insert into sessions (id, source, model, title, cwd, git_branch, started_at, ended_at)
                 values (?1, 'cli', 'anthropic/claude-sonnet-4.6', '修复构建', '/work/app', 'main', 1760000000.0, 1760000100.0)",
                ["20260917_101530_a1b2c3d4"],
            )
            .unwrap();
        let rows: [(f64, &str, &str); 6] = [
            (1760000001.0, "user", "帮我修复构建"),
            (
                1760000002.0,
                "assistant",
                "[{\"id\":\"call-1\",\"function\":{\"name\":\"bash\",\"arguments\":\"{\\\"command\\\":\\\"ls\\\"}\"}}]",
            ),
            (1760000003.0, "tool", "src\nREADME.md"),
            (1760000002.0, "assistant", "旧代的回复"),
            (1760000004.0, "assistant", "已修复，请查看"),
            (1760000004.5, "assistant", "思考中"),
        ];
        // 第一条 assistant 行带 reasoning 与 tool_calls；tool 行带 tool_call_id。
        connection
            .execute(
                "insert into messages (session_id, role, content, reasoning, tool_calls, timestamp, active)
                 values (?1, 'user', ?2, null, null, ?3, 1)",
                params!["20260917_101530_a1b2c3d4", rows[0].2, rows[0].0],
            )
            .unwrap();
        connection
            .execute(
                "insert into messages (session_id, role, content, reasoning, tool_calls, timestamp, active)
                 values (?1, 'assistant', '我先看看目录', '需要定位构建脚本', ?2, ?3, 1)",
                params![
                    "20260917_101530_a1b2c3d4",
                    rows[1].2,
                    rows[1].0
                ],
            )
            .unwrap();
        connection
            .execute(
                "insert into messages (session_id, role, content, tool_call_id, timestamp, active)
                 values (?1, 'tool', ?2, 'call-1', ?3, 1)",
                params!["20260917_101530_a1b2c3d4", rows[2].2, rows[2].0],
            )
            .unwrap();
        // active=0 的两代归档行，不应出现在结果里。
        connection
            .execute(
                "insert into messages (session_id, role, content, timestamp, active)
                 values (?1, 'assistant', ?2, ?3, 0)",
                params!["20260917_101530_a1b2c3d4", rows[3].2, rows[3].0],
            )
            .unwrap();
        connection
            .execute(
                "insert into messages (session_id, role, content, reasoning, timestamp, active)
                 values (?1, 'assistant', '', ?2, ?3, 0)",
                params!["20260917_101530_a1b2c3d4", rows[5].2, rows[5].0],
            )
            .unwrap();
        connection
            .execute(
                "insert into messages (session_id, role, content, timestamp, active)
                 values (?1, 'assistant', ?2, ?3, 1)",
                params!["20260917_101530_a1b2c3d4", rows[4].2, rows[4].0],
            )
            .unwrap();
        drop(connection);

        let parsed = parse_source(&source(root)).unwrap();
        assert_eq!(parsed.sessions.len(), 1);
        assert_eq!(
            parsed.active_paths,
            std::collections::BTreeSet::from([database.to_string_lossy().into_owned()])
        );
        let session = &parsed.sessions[0];
        let summary = &session.summary;
        assert_eq!(summary["id"], "20260917_101530_a1b2c3d4");
        assert_eq!(summary["_key"], "hermes:20260917_101530_a1b2c3d4");
        assert_eq!(summary["title"], "修复构建");
        assert_eq!(summary["cwd"], "/work/app");
        assert_eq!(summary["model_provider"], "anthropic");
        assert_eq!(summary["originator"], "hermes_agent");
        assert_eq!(summary["timestamp"], "2025-10-09T08:53:20.000Z");
        assert_eq!(summary["last_timestamp"], "2025-10-09T08:53:24.000Z");
        assert_eq!(summary["source_read_only"], true);
        // user + 助手文本 + 工具调用 + 工具结果 + 最终回复 = 5 条；
        // thinking 计入上下文。
        assert_eq!(summary["message_count"], 5);
        assert_eq!(summary["context_count"], 1);
        assert_eq!(summary["tool_count"], 2);
        assert!(session.search_text.contains("claude-sonnet-4.6"));
        assert!(session.search_text.contains("main"));

        let detail = parse_detail(&source(root), &session.detail_locator).unwrap();
        let messages = detail["conversation_messages"].as_array().unwrap();
        assert_eq!(messages.len(), 6);
        let tool_result = messages
            .iter()
            .find(|message| message["tool_kind"] == "tool_result")
            .unwrap();
        assert_eq!(tool_result["tool_name"], "bash");
        assert_eq!(tool_result["tool_call_id"], "call-1");
        // raw_events 按消息行计数：4 条活跃行（active=0 的两行被过滤）。
        assert_eq!(detail["raw_events"].as_array().unwrap().len(), 4);
        assert!(messages
            .iter()
            .all(|message| message["_message_key"].is_string()));
    }

    #[test]
    fn 排除子代理与委托会话() {
        let directory = tempdir().unwrap();
        let root = directory.path();
        let connection = create_state_db(&root.join("state.db"), false);
        connection
            .execute(
                "insert into sessions (id, source, started_at) values ('s-main', 'cli', 1760000000.0)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "insert into sessions (id, source, started_at) values ('s-sub', 'subagent', 1760000000.0)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "insert into sessions (id, source, model_config, started_at) values ('s-delegate', 'cli', '{\"$._delegate_from\":\"s-main\"}', 1760000000.0)",
                [],
            )
            .unwrap();
        for id in ["s-main", "s-sub", "s-delegate"] {
            connection
                .execute(
                    "insert into messages (session_id, role, content, timestamp, active)
                     values (?1, 'user', '消息', 1760000001.0, 1)",
                    [id],
                )
                .unwrap();
        }
        drop(connection);

        let parsed = parse_source(&source(root)).unwrap();
        assert_eq!(parsed.sessions.len(), 1);
        assert_eq!(parsed.sessions[0].summary["id"], "s-main");
    }

    #[test]
    fn 发现命名profile库并跳过缺失主库() {
        let directory = tempdir().unwrap();
        let root = directory.path();
        let main = create_state_db(&root.join("state.db"), false);
        main.execute(
            "insert into sessions (id, source, started_at) values ('s-main', 'cli', 1760000000.0)",
            [],
        )
        .unwrap();
        main.execute(
            "insert into messages (session_id, role, content, timestamp) values ('s-main', 'user', '主库消息', 1760000001.0)",
            [],
        )
        .unwrap();
        drop(main);
        let profile = create_state_db(&root.join("profiles").join("coder").join("state.db"), false);
        profile
            .execute(
                "insert into sessions (id, source, title, started_at) values ('s-coder', 'cli', 'profile 会话', 1760000002.0)",
                [],
            )
            .unwrap();
        profile
            .execute(
                "insert into messages (session_id, role, content, timestamp) values ('s-coder', 'user', 'profile 消息', 1760000003.0)",
                [],
            )
            .unwrap();
        drop(profile);

        let parsed = parse_source(&source(root)).unwrap();
        assert_eq!(parsed.sessions.len(), 2);
        assert!(parsed.active_paths.contains(
            &root.join("profiles")
                .join("coder")
                .join("state.db")
                .to_string_lossy()
                .into_owned()
        ));
    }

    #[test]
    fn 旧列集数据库自适应() {
        let directory = tempdir().unwrap();
        let root = directory.path();
        let database = root.join("state.db");
        let connection = create_state_db(&database, true);
        connection
            .execute(
                "insert into sessions (id, source, started_at) values ('s-old', 'cli', 1760000000.0)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "insert into messages (session_id, role, content, timestamp) values ('s-old', 'user', '旧库消息', 1760000001.0)",
                [],
            )
            .unwrap();
        drop(connection);

        let parsed = parse_source(&source(root)).unwrap();
        assert_eq!(parsed.sessions.len(), 1);
        let summary = &parsed.sessions[0].summary;
        assert_eq!(summary["title"], "旧库消息");
        assert_eq!(summary["model_provider"], "unknown");
        // 无 ended_at 时活跃时间回退到首条消息。
        assert_eq!(summary["last_timestamp"], "2025-10-09T08:53:21.000Z");
    }

    #[test]
    fn codex_最终回复回退到_项目投影() {
        let directory = tempdir().unwrap();
        let root = directory.path();
        let connection = create_state_db(&root.join("state.db"), false);
        connection
            .execute(
                "insert into sessions (id, source, started_at) values ('s-codex', 'cli', 1760000000.0)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "insert into messages (session_id, role, content, codex_message_items, timestamp) \
                 values ('s-codex', 'assistant', '', ?1, 1760000001.0)",
                params![r#"[{"type":"message","content":[{"type":"output_text","text":"最终回复"}]}]"#],
            )
            .unwrap();
        drop(connection);

        let parsed = parse_source(&source(root)).unwrap();
        let detail = parse_detail(&source(root), &parsed.sessions[0].detail_locator).unwrap();
        let messages = detail["conversation_messages"].as_array().unwrap();
        assert!(messages
            .iter()
            .any(|message| message["text"] == "最终回复"));
    }

    #[test]
    fn 非hermes库上报错误且空会话跳过() {
        let directory = tempdir().unwrap();
        let root = directory.path();
        let foreign = root.join("state.db");
        std::fs::write(&foreign, "not sqlite at all").unwrap();
        // 缺 sessions 表的合法 SQLite。
        let profile_db = root.join("profiles").join("x").join("state.db");
        std::fs::create_dir_all(profile_db.parent().unwrap()).unwrap();
        Connection::open(&profile_db)
            .unwrap()
            .execute_batch("create table other(x)")
            .unwrap();

        let parsed = parse_source(&source(root)).unwrap();
        assert!(parsed.sessions.is_empty());
        assert_eq!(parsed.errors.len(), 2);
    }

    #[test]
    fn 监听路径匹配主库与_wal() {
        let directory = tempdir().unwrap();
        let root = directory.path();
        let database = root.join("state.db");
        std::fs::write(&database, "").unwrap();
        assert!(matches_path(root, &database));
        assert!(matches_path(root, &root.join("state.db-wal")));
        assert!(!matches_path(root, &root.join("state.db-shm")));
        assert!(!matches_path(root, &root.join("logs").join("x.log")));
        assert!(!matches_path(root, &root.join("other.db")));
    }
}
