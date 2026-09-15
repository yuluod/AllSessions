//! Devin 会话适配器（只读），覆盖桌面版与 CLI 两种存储。
//!
//! 桌面版数据布局（root 指向 VS Code fork 的用户目录 `Devin/User`）：
//! - `acp-messages/<uuid>.db`：每会话一个 SQLite。`meta` 存元数据 JSON
//!   （title、configOptions 里的模式与模型），`messages` 按 position 存
//!   ACP JSON 消息（user_message / agent_message / agent_thought /
//!   tool_call / plan）。
//! - `globalStorage/state.vscdb`：ItemTable 的
//!   `windsurf.acp.sessioninfo.session.*` 提供明文 title/cwd/时间戳；
//!   `windsurf.acp.messageStore.session.*` 把 `acp/<connector>/<name>`
//!   形式的会话键映射回消息库 uuid。
//!
//! CLI 数据布局（root 可为 `devin/cli` 目录、`devin` 数据根或
//! `sessions.db` 文件本身）：
//! - `sessions`：slug 会话 id、标题、工作目录、模型与 epoch 秒时间戳；
//!   `hidden` 会话跳过。
//! - `message_nodes`：`parent_node_id` 链成的消息森林，chat_message 为
//!   OpenAI 风格 JSON（system/user/assistant/tool，assistant 含
//!   thinking 与 tool_calls）。当前会话取 `main_chain_id` 所在链
//!   沿最深子节点延伸后的最新末端，回溯到根得到有序消息。
//!
//! 桌面版会把在桌面打开的 CLI 会话镜像进 acp-messages
//! （sessionId 为 `acp/devin-cli/<slug>`）；此类会话统一用 slug 作 id，
//! 与 CLI 库记录去重，先扫描到的根保留。云端会话（devin-cloud）没有本地
//! 消息库，与未发送草稿一样因无消息被排除。来源整体只读，不生成
//! `_delete_ref`。

use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    fs,
    io::ErrorKind,
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

const SESSIONINFO_PREFIX: &str = "windsurf.acp.sessioninfo.session.";
const MESSAGESTORE_PREFIX: &str = "windsurf.acp.messageStore.session.";
/// 原始事件正文超过该字符数时只保留元信息，图片 base64 不进详情。
const RAW_PAYLOAD_LIMIT: usize = 10_000;

pub(super) struct ParsedSource {
    pub sessions: Vec<ParsedSession>,
    pub active_paths: BTreeSet<String>,
    pub errors: Vec<(PathBuf, String, String)>,
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
    /// state.vscdb sessioninfo（明文 title/cwd/时间戳），可能缺失。
    metadata: Value,
    /// true 表示定位到 CLI 的 sessions.db 聚合库，而不是 acp-messages 单库。
    pub(super) cli: bool,
    pub(super) content_fingerprint: String,
}

struct MessageRow {
    position: i64,
    kind: String,
    raw: String,
    payload: Value,
}

impl MessageRow {
    fn new(row: &Row<'_>) -> Self {
        let raw = row.get::<_, String>(2).unwrap_or_default();
        let payload = serde_json::from_str::<Value>(&raw).unwrap_or(Value::Null);
        Self {
            position: row.get::<_, i64>(0).unwrap_or_default(),
            kind: row.get::<_, String>(1).unwrap_or_default(),
            raw,
            payload,
        }
    }
}

fn acp_database_dir(root: &Path) -> PathBuf {
    root.join("acp-messages")
}

/// state.vscdb 里以 uuid 为键的会话元数据；文件缺失或损坏时返回空表，
/// 摘要退回消息库自身的 meta 信息。
fn session_index(root: &Path) -> BTreeMap<String, Value> {
    let path = root.join("globalStorage").join("state.vscdb");
    let connection = match (
        path.is_file(),
        Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        ),
    ) {
        (true, Ok(connection)) => connection,
        _ => return BTreeMap::new(),
    };
    if connection.busy_timeout(Duration::from_secs(2)).is_err() {
        return BTreeMap::new();
    }
    // `acp/<connector>/<name>` → uuid 指针。
    let mut pointers = BTreeMap::new();
    if let Ok(mut statement) = connection.prepare(&format!(
        "select key, cast(value as text) from ItemTable \
         where key like '{MESSAGESTORE_PREFIX}%'"
    )) {
        if let Ok(mut rows) = statement.query([]) {
            while let Ok(Some(row)) = rows.next() {
                let key = row.get::<_, String>(0).unwrap_or_default();
                let value = row.get::<_, String>(1).unwrap_or_default();
                let uuid = serde_json::from_str::<Value>(&value)
                    .ok()
                    .and_then(|value| value["uuid"].as_str().map(str::to_string));
                if let (Some(session_key), Some(uuid)) =
                    (key.strip_prefix(MESSAGESTORE_PREFIX), uuid)
                {
                    pointers.insert(session_key.to_string(), uuid);
                }
            }
        }
    }
    let mut indexed = Vec::new();
    if let Ok(mut statement) = connection.prepare(&format!(
        "select key, cast(value as text) from ItemTable \
         where key like '{SESSIONINFO_PREFIX}%'"
    )) {
        if let Ok(mut rows) = statement.query([]) {
            while let Ok(Some(row)) = rows.next() {
                let key = row.get::<_, String>(0).unwrap_or_default();
                let value = row.get::<_, String>(1).unwrap_or_default();
                let Some(session_key) = key.strip_prefix(SESSIONINFO_PREFIX) else {
                    continue;
                };
                // 两种键：`acp/<connector>/<name>` 需要指针反解 uuid，
                // 裸 uuid 是旧版（cascade 时代）直接可用的键。
                let uuid = if session_key.starts_with("acp/") {
                    pointers.get(session_key).cloned()
                } else {
                    Some(session_key.to_string())
                };
                let Some(uuid) = uuid else { continue };
                let value = serde_json::from_str::<Value>(&value).unwrap_or(Value::Null);
                indexed.push((uuid, value));
            }
        }
    }
    // 同一 uuid 可能同时有新旧两版键；保留第一个（查询序不定，但字段等价）。
    let mut index = BTreeMap::new();
    for (uuid, value) in indexed {
        index.entry(uuid).or_insert(value);
    }
    index
}

fn open_database(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| format!("无法只读打开 Devin 消息库（{}）：{error}", path.display()))?;
    connection
        .busy_timeout(Duration::from_secs(2))
        .map_err(|error| format!("无法配置 Devin 消息库读取超时：{error}"))?;
    Ok(connection)
}

fn validate_tables(connection: &Connection) -> Result<(), String> {
    for table in ["meta", "messages"] {
        let count = connection
            .query_row(
                "select count(*) from sqlite_master where type = 'table' and name = ?1",
                [table],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| format!("无法检查 Devin 消息库结构：{error}"))?;
        if count != 1 {
            return Err("不是受支持的 Devin 消息库（缺少 meta/messages 表）".into());
        }
    }
    Ok(())
}

fn meta_rows(connection: &Connection) -> BTreeMap<String, Value> {
    let mut meta = BTreeMap::new();
    let Ok(mut statement) = connection.prepare("select key, value from meta") else {
        return meta;
    };
    let Ok(mut rows) = statement.query([]) else {
        return meta;
    };
    while let Ok(Some(row)) = rows.next() {
        let key = row.get::<_, String>(0).unwrap_or_default();
        let value = row.get::<_, String>(1).unwrap_or_default();
        let value = serde_json::from_str::<Value>(&value).unwrap_or(Value::Null);
        meta.insert(key, value);
    }
    meta
}

fn visit_messages(
    connection: &Connection,
    mut visitor: impl FnMut(&MessageRow),
) -> Result<(), String> {
    let mut statement = connection
        .prepare("select position, kind, payload from messages order by position")
        .map_err(|error| format!("Devin 消息库不是受支持的格式：{error}"))?;
    let mut rows = statement
        .query([])
        .map_err(|error| format!("无法查询 Devin 消息：{error}"))?;
    while let Some(row) = rows
        .next()
        .map_err(|error| format!("无法读取 Devin 消息：{error}"))?
    {
        visitor(&MessageRow::new(row));
    }
    Ok(())
}

fn chunk_timestamp(payload: &Value) -> String {
    payload["content"]
        .as_array()
        .into_iter()
        .flatten()
        .find_map(|chunk| chunk["_meta"]["cognition.ai/timestamp"].as_str())
        .unwrap_or_default()
        .to_string()
}

fn chunked_messages(row: &MessageRow, role: &str, subtype: &str, synthetic: bool) -> Vec<Value> {
    let Some(chunks) = row.payload["content"].as_array() else {
        return Vec::new();
    };
    let timestamp = chunk_timestamp(&row.payload);
    let mut texts = Vec::new();
    let mut images = 0usize;
    for chunk in chunks {
        match chunk["content"]["type"].as_str() {
            Some("text") => {
                if let Some(text) = chunk["content"]["text"].as_str() {
                    if !text.trim().is_empty() {
                        texts.push(text);
                    }
                }
            }
            Some("image") => images += 1,
            _ => {}
        }
    }
    let mut messages = Vec::new();
    if !texts.is_empty() {
        messages.push(message_value(
            role,
            &texts.join("\n\n"),
            &timestamp,
            "devin_chunk",
            subtype,
            synthetic,
        ));
    }
    for _ in 0..images {
        messages.push(message_value(
            role,
            "[image]",
            &timestamp,
            "devin_chunk",
            "image",
            true,
        ));
    }
    messages
}

fn readable_json(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(text) => text.clone(),
        _ => serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string()),
    }
}

fn tool_call_messages(row: &MessageRow) -> Vec<Value> {
    let content = &row.payload["content"];
    let title = content["title"].as_str().unwrap_or_default();
    let input = readable_json(&content["rawInput"]);
    let text = match (title.trim().is_empty(), input.trim().is_empty()) {
        (false, false) => format!("{title}\n{input}"),
        (false, true) => title.to_string(),
        (true, false) => input,
        (true, true) => return Vec::new(),
    };
    let timestamp = content["_meta"]["cognition.ai/timestamp"]
        .as_str()
        .unwrap_or_default();
    let status = content["status"].as_str().unwrap_or("unknown");
    let mut value = message_value("tool", &text, timestamp, "devin_tool", status, false);
    value["tool_name"] = Value::String(
        content["_meta"]["cognition.ai/inferenceToolName"]
            .as_str()
            .unwrap_or("tool")
            .to_string(),
    );
    value["tool_kind"] = Value::String(
        if status == "completed" {
            "tool_result"
        } else {
            "tool_call"
        }
        .into(),
    );
    if let Some(call_id) = content["toolCallId"].as_str() {
        value["tool_call_id"] = Value::String(call_id.to_string());
    }
    if status == "error" {
        value["is_error"] = Value::Bool(true);
    }
    vec![value]
}

fn plan_messages(row: &MessageRow) -> Vec<Value> {
    let Some(entries) = row.payload["content"]["entries"].as_array() else {
        return Vec::new();
    };
    let lines = entries
        .iter()
        .filter_map(|entry| {
            let text = entry["content"].as_str()?;
            Some(match entry["status"].as_str() {
                Some(status) if !status.is_empty() => format!("[{status}] {text}"),
                _ => text.to_string(),
            })
        })
        .collect::<Vec<_>>();
    if lines.is_empty() {
        return Vec::new();
    }
    vec![message_value(
        "assistant",
        &format!("[plan]\n{}", lines.join("\n")),
        "",
        "devin_plan",
        "plan",
        true,
    )]
}

fn message_messages(row: &MessageRow) -> (Vec<Value>, String) {
    if row.payload.is_null() {
        return (Vec::new(), String::new());
    }
    let timestamp = match row.kind.as_str() {
        "tool_call" => row.payload["content"]["_meta"]["cognition.ai/timestamp"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
        _ => chunk_timestamp(&row.payload),
    };
    let messages = match row.kind.as_str() {
        "user_message" => chunked_messages(row, "user", "text", false),
        "agent_message" => chunked_messages(row, "assistant", "text", false),
        "agent_thought" => chunked_messages(row, "assistant", "thinking", true),
        "tool_call" => tool_call_messages(row),
        "plan" => plan_messages(row),
        _ => Vec::new(),
    };
    (messages, timestamp)
}

fn model_from_config(info: &Value) -> Option<String> {
    info["configOptions"]
        .as_array()?
        .iter()
        .find(|option| option["id"].as_str() == Some("model"))?["currentValue"]
        .as_str()
        .map(str::to_string)
}

fn session_state(
    path: &Path,
    uuid: &str,
    index: &Value,
    meta: &BTreeMap<String, Value>,
) -> ParseState {
    let mut state = ParseState::new(path);
    state.id = uuid.to_string();
    // 桌面端镜像的 CLI 会话统一用 slug 作 id，与 CLI 库中的记录去重。
    if let Some(slug) = index["info"]["sessionId"]
        .as_str()
        .and_then(|value| value.strip_prefix("acp/devin-cli/"))
    {
        state.id = slug.to_string();
    }
    state.originator = "devin".into();
    state.provider = "unknown".into();
    if let (Some(created), Some(updated)) = (
        index["info"]["_meta"]["cognition.ai/createdAt"].as_str(),
        index["info"]["updatedAt"].as_str(),
    ) {
        state.timestamp = created.to_string();
        state.last_timestamp = updated.to_string();
    }
    if let Some(cwd) = index["info"]["cwd"].as_str() {
        state.cwd = cwd.to_string();
    }
    if let Some(model) = meta.get("info").and_then(model_from_config) {
        state.provider = model;
    }
    state
}

fn finish_summary(
    state: &ParseState,
    path: &Path,
    source: &Source,
    index: &Value,
    meta: &BTreeMap<String, Value>,
) -> (Value, String) {
    let mut summary = state.summary(path, source);
    let title = index["info"]["title"]
        .as_str()
        .map(str::to_string)
        .or_else(|| meta.get("info")?["title"].as_str().map(str::to_string))
        .filter(|title| !title.trim().is_empty())
        .unwrap_or_default();
    if !title.is_empty() {
        summary["title"] = Value::String(title);
    }
    summary["source_read_only"] = Value::Bool(true);
    let mut search_text = summary_search_text(&summary);
    append_limited(&mut search_text, &[&state.search_text], SEARCH_TEXT_LIMIT);
    (summary, search_text)
}

fn scan_session(
    path: &Path,
    index: &Value,
    source: &Source,
) -> Result<Option<ParsedSession>, (String, String)> {
    let uuid = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_string();
    let scan = || -> Result<Option<ParsedSession>, String> {
        let connection = open_database(path)?;
        validate_tables(&connection)?;
        let meta = meta_rows(&connection);
        let mut state = session_state(path, &uuid, index, &meta);
        // 索引里的 updatedAt 是权威更新时间；消息块时间戳格式不一（Z/偏移），
        // 跨格式字符串比较会误判先后，仅在索引缺失时作回退。
        let indexed_last = index["info"]["updatedAt"].as_str().unwrap_or_default();
        let mut content_hash = Sha256::new();
        visit_messages(&connection, |row| {
            // 内容指纹覆盖全部原始行，识别原地编辑与删除。
            content_hash.update(row.position.to_string().as_bytes());
            content_hash.update([0]);
            content_hash.update(row.kind.as_bytes());
            content_hash.update([0]);
            content_hash.update(row.raw.as_bytes());
            let (messages, timestamp) = message_messages(row);
            if state.timestamp.is_empty() && !timestamp.is_empty() {
                state.timestamp = timestamp.clone();
            }
            if indexed_last.is_empty() && !timestamp.is_empty() && timestamp > state.last_timestamp
            {
                state.last_timestamp = timestamp;
            }
            for message in messages {
                state.accept_message(message);
            }
        })?;
        // messages 为 0 的库是未发送草稿或云端会话的本地占位，排除。
        if state.message_count == 0 {
            return Ok(None);
        }
        let (summary, search_text) = finish_summary(&state, path, source, index, &meta);
        Ok(Some(ParsedSession {
            summary,
            search_text,
            path: path.to_path_buf(),
            detail_locator: DetailLocator {
                database_path: path.to_path_buf(),
                session_id: uuid.clone(),
                metadata: index.clone(),
                cli: false,
                content_fingerprint: content_hash
                    .finalize()
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect(),
            },
        }))
    };
    scan().map_err(|error| (uuid, error))
}

pub(super) fn parse_source(source: &Source) -> Result<ParsedSource, String> {
    let index = session_index(&source.root);
    let directory = acp_database_dir(&source.root);
    let mut sessions = Vec::new();
    let mut active_paths = BTreeSet::new();
    let mut errors = Vec::new();
    match fs::read_dir(&directory) {
        Ok(entries) => {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_file()
                    || path.extension().and_then(|value| value.to_str()) != Some("db")
                {
                    continue;
                }
                active_paths.insert(path.to_string_lossy().into_owned());
                let uuid = path
                    .file_stem()
                    .and_then(|value| value.to_str())
                    .unwrap_or_default()
                    .to_string();
                match scan_session(&path, index.get(&uuid).unwrap_or(&Value::Null), source) {
                    Ok(Some(session)) => sessions.push(session),
                    Ok(None) => {}
                    Err((id, error)) => errors.push((path, id, error)),
                }
            }
        }
        // 目录尚未创建（如刚安装 Devin）不算错误，留待后续刷新发现；
        // root 直接指向 sessions.db 文件时同理。
        Err(error) if matches!(error.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory) => {}
        Err(error) => {
            return Err(format!(
                "无法读取 Devin 会话目录（{}）：{error}",
                directory.display()
            ))
        }
    }
    let state_db = source.root.join("globalStorage").join("state.vscdb");
    if state_db.is_file() {
        active_paths.insert(state_db.to_string_lossy().into_owned());
    }
    for database in cli_databases(&source.root) {
        active_paths.insert(database.to_string_lossy().into_owned());
        match scan_cli(&database, source) {
            Ok((mut cli_sessions, mut cli_errors)) => {
                sessions.append(&mut cli_sessions);
                errors.append(&mut cli_errors);
            }
            Err(error) => errors.push((database, "sessions.db".into(), error)),
        }
    }
    Ok(ParsedSource {
        sessions,
        active_paths,
        errors,
    })
}

/// 监听规则：acp-messages 下的消息库、全局索引库与 CLI 聚合库；
/// -shm 变化不触发（只读连接也可能更新共享内存）。
pub(super) fn matches_path(root: &Path, path: &Path) -> bool {
    // CLI 库候选：root/sessions.db、root/cli/sessions.db、root 本身是库文件。
    for candidate in [
        root.join("sessions.db"),
        root.join("cli").join("sessions.db"),
    ] {
        if super::opencode_event_matches(&candidate, path) {
            return true;
        }
    }
    if root.file_name().and_then(|value| value.to_str()) == Some("sessions.db")
        && super::opencode_event_matches(root, path)
    {
        return true;
    }
    if !path.starts_with(root) {
        return false;
    }
    if path.starts_with(acp_database_dir(root)) {
        return path
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|name| name.ends_with(".db") || name.ends_with(".db-wal"));
    }
    super::opencode_event_matches(&root.join("globalStorage").join("state.vscdb"), path)
}

fn raw_payload(row: &MessageRow) -> Value {
    if row.payload.is_null() || row.raw.chars().count() > RAW_PAYLOAD_LIMIT {
        json!({
            "truncated": true,
            "original_chars": row.raw.chars().count(),
            "kind": row.kind,
        })
    } else {
        row.payload.clone()
    }
}

// ---------- Devin CLI（sessions.db 聚合库） ----------

/// root 可为 `devin/cli` 目录、`devin` 数据根或 `sessions.db` 文件本身。
fn cli_databases(root: &Path) -> Vec<PathBuf> {
    let mut candidates = vec![
        root.join("sessions.db"),
        root.join("cli").join("sessions.db"),
    ];
    if root.extension().and_then(|value| value.to_str()) == Some("db") {
        candidates.push(root.to_path_buf());
    }
    candidates
        .into_iter()
        .filter(|path| path.is_file())
        .collect()
}

fn validate_cli_tables(connection: &Connection) -> Result<(), String> {
    for table in ["sessions", "message_nodes"] {
        let count = connection
            .query_row(
                "select count(*) from sqlite_master where type = 'table' and name = ?1",
                [table],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| format!("无法检查 Devin CLI 会话库结构：{error}"))?;
        if count != 1 {
            return Err("不是受支持的 Devin CLI 会话库（缺少 sessions/message_nodes 表）".into());
        }
    }
    Ok(())
}

struct CliSessionRow {
    id: String,
    title: String,
    cwd: String,
    model: String,
    created_at: i64,
    last_activity_at: i64,
    main_chain_id: Option<i64>,
}

struct CliNode {
    node_id: i64,
    parent: Option<i64>,
    created_at: i64,
    raw: String,
    chat: Value,
}

const CLI_SESSION_COLUMNS: &str =
    "id, title, working_directory, model, created_at, last_activity_at, main_chain_id";

fn cli_session_row(row: &Row<'_>) -> rusqlite::Result<CliSessionRow> {
    Ok(CliSessionRow {
        id: row.get(0)?,
        title: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
        cwd: row.get(2)?,
        model: row.get(3)?,
        created_at: row.get(4)?,
        last_activity_at: row.get(5)?,
        main_chain_id: row.get(6)?,
    })
}

fn load_cli_sessions(connection: &Connection) -> Result<Vec<CliSessionRow>, String> {
    let mut statement = connection
        .prepare(&format!(
            "select {CLI_SESSION_COLUMNS} from sessions \
             where hidden = 0 order by last_activity_at desc, id"
        ))
        .map_err(|error| format!("Devin CLI 会话库不是受支持的格式：{error}"))?;
    let rows = statement
        .query_map([], cli_session_row)
        .map_err(|error| format!("无法查询 Devin CLI 会话：{error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法读取 Devin CLI 会话：{error}"))
}

fn load_cli_session(connection: &Connection, id: &str) -> Result<CliSessionRow, String> {
    connection
        .query_row(
            &format!(
                "select {CLI_SESSION_COLUMNS} from sessions \
                 where id = ?1 and hidden = 0"
            ),
            [id],
            cli_session_row,
        )
        .map_err(|error| format!("无法读取 Devin CLI 会话 {id}：{error}"))
}

fn load_cli_nodes(connection: &Connection, session_id: &str) -> Result<Vec<CliNode>, String> {
    let mut statement = connection
        .prepare(
            "select node_id, parent_node_id, created_at, chat_message \
             from message_nodes where session_id = ?1 order by node_id",
        )
        .map_err(|error| format!("Devin CLI 会话库不是受支持的格式：{error}"))?;
    let mut rows = statement
        .query([session_id])
        .map_err(|error| format!("无法查询 Devin CLI 消息：{error}"))?;
    let mut nodes = Vec::new();
    while let Some(row) = rows
        .next()
        .map_err(|error| format!("无法读取 Devin CLI 消息：{error}"))?
    {
        let raw = row.get::<_, String>(3).unwrap_or_default();
        nodes.push(CliNode {
            node_id: row.get::<_, i64>(0).unwrap_or_default(),
            parent: row.get::<_, Option<i64>>(1).unwrap_or_default(),
            created_at: row.get::<_, i64>(2).unwrap_or_default(),
            chat: serde_json::from_str::<Value>(&raw).unwrap_or(Value::Null),
            raw,
        });
    }
    Ok(nodes)
}

/// 当前会话链：从 main_chain_id 出发沿最深子节点延伸到最新末端
/// （会话进行中 main_chain_id 可能滞后于最新写入），再回溯到根；
/// 无 main_chain_id 时取最新节点回溯。废弃分支自然不在链上。
fn cli_chain(nodes: &[CliNode], main_chain_id: Option<i64>) -> Vec<usize> {
    if nodes.is_empty() {
        return Vec::new();
    }
    let by_id: HashMap<i64, usize> = nodes
        .iter()
        .enumerate()
        .map(|(index, node)| (node.node_id, index))
        .collect();
    let mut deepest_child: HashMap<i64, i64> = HashMap::new();
    for node in nodes {
        if let Some(parent) = node.parent {
            let entry = deepest_child.entry(parent).or_insert(node.node_id);
            if node.node_id > *entry {
                *entry = node.node_id;
            }
        }
    }
    let mut tip = main_chain_id
        .filter(|id| by_id.contains_key(id))
        .unwrap_or_else(|| nodes.last().map(|node| node.node_id).unwrap_or_default());
    while let Some(&next) = deepest_child.get(&tip) {
        tip = next;
    }
    let mut chain = Vec::new();
    let mut current = Some(tip);
    while let Some(id) = current {
        let Some(&index) = by_id.get(&id) else {
            break;
        };
        chain.push(index);
        current = nodes[index].parent;
    }
    chain.reverse();
    chain
}

fn cli_timestamp(seconds: i64) -> String {
    timestamp_from_millis(seconds.saturating_mul(1000)).unwrap_or_default()
}

fn cli_messages(node: &CliNode, tool_names: &mut HashMap<String, String>) -> Vec<Value> {
    let chat = &node.chat;
    let timestamp = cli_timestamp(node.created_at);
    let mut messages = Vec::new();
    match chat["role"].as_str() {
        Some("system") => {
            if let Some(text) = chat["content"]
                .as_str()
                .filter(|text| !text.trim().is_empty())
            {
                messages.push(message_value(
                    "system",
                    text,
                    &timestamp,
                    "devin_cli",
                    "context",
                    true,
                ));
            }
        }
        Some("user") => {
            // is_user_input 区分真实输入与注入的 user 角色上下文
            //（如 Lint 反馈、压缩摘要提示）。
            let input = chat["metadata"]["is_user_input"].as_bool() == Some(true);
            if let Some(text) = chat["content"]
                .as_str()
                .filter(|text| !text.trim().is_empty())
            {
                messages.push(message_value(
                    "user",
                    text,
                    &timestamp,
                    "devin_cli",
                    if input { "text" } else { "context" },
                    !input,
                ));
            }
        }
        Some("assistant") => {
            // thinking 是 JSON 字符串（{"thinking": "...", "signature": ...}）。
            let thinking = chat["thinking"].as_str().and_then(|raw| {
                serde_json::from_str::<Value>(raw)
                    .ok()
                    .and_then(|value| value["thinking"].as_str().map(str::to_string))
                    .or_else(|| Some(raw.to_string()))
            });
            if let Some(text) = thinking.as_deref().filter(|text| !text.trim().is_empty()) {
                messages.push(message_value(
                    "assistant",
                    text,
                    &timestamp,
                    "devin_cli",
                    "thinking",
                    true,
                ));
            }
            if let Some(text) = chat["content"]
                .as_str()
                .filter(|text| !text.trim().is_empty())
            {
                messages.push(message_value(
                    "assistant",
                    text,
                    &timestamp,
                    "devin_cli",
                    "text",
                    false,
                ));
            }
            for call in chat["tool_calls"].as_array().into_iter().flatten() {
                let name = call["name"].as_str().unwrap_or("tool");
                let call_id = call["id"].as_str().unwrap_or_default();
                let arguments = &call["arguments"];
                let text = if arguments.is_string() {
                    arguments.as_str().unwrap_or_default().to_string()
                } else {
                    readable_json(arguments)
                };
                let mut value =
                    message_value("tool", &text, &timestamp, "devin_cli", "tool_call", false);
                value["tool_name"] = Value::String(name.to_string());
                value["tool_kind"] = Value::String("tool_call".into());
                if !call_id.is_empty() {
                    value["tool_call_id"] = Value::String(call_id.to_string());
                    tool_names.insert(call_id.to_string(), name.to_string());
                }
                messages.push(value);
            }
        }
        Some("tool") => {
            let text = chat["content"].as_str().unwrap_or_default();
            if text.trim().is_empty() {
                return messages;
            }
            let mut value =
                message_value("tool", text, &timestamp, "devin_cli", "tool_result", false);
            value["tool_kind"] = Value::String("tool_result".into());
            if let Some(call_id) = chat["tool_call_id"].as_str() {
                value["tool_call_id"] = Value::String(call_id.to_string());
                if let Some(name) = tool_names.get(call_id) {
                    value["tool_name"] = Value::String(name.clone());
                }
            }
            let success =
                chat["metadata"]["extensions"]["chisel/tool_result_meta"]["success"].as_bool();
            if success == Some(false) {
                value["is_error"] = Value::Bool(true);
            }
            messages.push(value);
        }
        _ => {}
    }
    messages
}

fn cli_state(database: &Path, row: &CliSessionRow) -> ParseState {
    let mut state = ParseState::new(database);
    state.id = row.id.clone();
    state.originator = "devin".into();
    // CLI 直接记录模型名（如 swe-2-max），不推测 Provider。
    state.provider = if row.model.is_empty() {
        "unknown".into()
    } else {
        row.model.clone()
    };
    state.timestamp = cli_timestamp(row.created_at);
    state.last_timestamp = cli_timestamp(row.last_activity_at);
    state.cwd = row.cwd.clone();
    state
}

fn cli_summary(
    state: &ParseState,
    row: &CliSessionRow,
    database: &Path,
    source: &Source,
) -> (Value, String) {
    let mut summary = state.summary(database, source);
    if !row.title.trim().is_empty() {
        summary["title"] = Value::String(row.title.clone());
    }
    summary["source_read_only"] = Value::Bool(true);
    let mut search_text = summary_search_text(&summary);
    append_limited(&mut search_text, &[&state.search_text], SEARCH_TEXT_LIMIT);
    (summary, search_text)
}

fn scan_cli_session(
    connection: &Connection,
    database: &Path,
    row: &CliSessionRow,
    source: &Source,
) -> Result<Option<ParsedSession>, String> {
    let nodes = load_cli_nodes(connection, &row.id)?;
    let chain = cli_chain(&nodes, row.main_chain_id);
    if chain.is_empty() {
        return Ok(None);
    }
    let mut state = cli_state(database, row);
    let mut content_hash = Sha256::new();
    content_hash.update(
        json!([
            row.title,
            row.cwd,
            row.model,
            row.created_at,
            row.last_activity_at,
            row.main_chain_id
        ])
        .to_string()
        .as_bytes(),
    );
    let mut tool_names = HashMap::new();
    for &index in &chain {
        let node = &nodes[index];
        // 内容指纹覆盖链上全部原始节点，识别原地编辑与删除。
        content_hash.update(node.node_id.to_string().as_bytes());
        content_hash.update([0]);
        content_hash.update(
            node.parent
                .map(|parent| parent.to_string())
                .unwrap_or_default()
                .as_bytes(),
        );
        content_hash.update([0]);
        content_hash.update(node.raw.as_bytes());
        for message in cli_messages(node, &mut tool_names) {
            state.accept_message(message);
        }
    }
    if state.message_count == 0 {
        return Ok(None);
    }
    let (summary, search_text) = cli_summary(&state, row, database, source);
    Ok(Some(ParsedSession {
        summary,
        search_text,
        path: database.to_path_buf(),
        detail_locator: DetailLocator {
            database_path: database.to_path_buf(),
            session_id: row.id.clone(),
            metadata: Value::Null,
            cli: true,
            content_fingerprint: content_hash
                .finalize()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect(),
        },
    }))
}

fn scan_cli(
    database: &Path,
    source: &Source,
) -> Result<(Vec<ParsedSession>, Vec<(PathBuf, String, String)>), String> {
    let connection = open_database(database)?;
    validate_cli_tables(&connection)?;
    let mut sessions = Vec::new();
    let mut errors = Vec::new();
    for row in load_cli_sessions(&connection)? {
        match scan_cli_session(&connection, database, &row, source) {
            Ok(Some(session)) => sessions.push(session),
            Ok(None) => {}
            Err(error) => errors.push((database.to_path_buf(), row.id.clone(), error)),
        }
    }
    Ok((sessions, errors))
}

fn cli_raw_payload(node: &CliNode) -> Value {
    if node.chat.is_null() || node.raw.chars().count() > RAW_PAYLOAD_LIMIT {
        json!({
            "truncated": true,
            "original_chars": node.raw.chars().count(),
            "role": node.chat["role"],
        })
    } else {
        node.chat.clone()
    }
}

fn visit_cli_detail(
    source: &Source,
    locator: &DetailLocator,
    visitor: &mut dyn FnMut(&Value),
) -> Result<Value, String> {
    let connection = open_database(&locator.database_path)?;
    validate_cli_tables(&connection)?;
    let row = load_cli_session(&connection, &locator.session_id)?;
    let nodes = load_cli_nodes(&connection, &locator.session_id)?;
    let chain = cli_chain(&nodes, row.main_chain_id);
    let mut state = cli_state(&locator.database_path, &row);
    let mut messages = HeadTail::new(DETAIL_MESSAGE_LIMIT);
    let mut events = HeadTail::new(DETAIL_EVENT_LIMIT);
    let mut tool_names = HashMap::new();
    for &index in &chain {
        let node = &nodes[index];
        for mut value in cli_messages(node, &mut tool_names)
            .into_iter()
            .filter_map(|value| state.accept_message(value))
        {
            attach_message_key(
                &mut value,
                json!({
                    "source_kind": "devin",
                    "session_id": locator.session_id,
                    "node_id": node.node_id,
                }),
            );
            visitor(&value);
            truncate_message(&mut value);
            messages.push(value);
        }
        events.push(json!({
            "line_number": node.node_id,
            "timestamp": cli_timestamp(node.created_at),
            "type": node.chat["role"].as_str().unwrap_or("unknown"),
            "payload": cli_raw_payload(node),
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
    let (mut summary, _) = cli_summary(&state, &row, &locator.database_path, source);
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

pub(super) fn parse_detail(source: &Source, locator: &DetailLocator) -> Result<Value, String> {
    visit_detail(source, locator, &mut |_| {})
}

pub(super) fn visit_detail(
    source: &Source,
    locator: &DetailLocator,
    visitor: &mut dyn FnMut(&Value),
) -> Result<Value, String> {
    if locator.cli {
        return visit_cli_detail(source, locator, visitor);
    }
    let connection = open_database(&locator.database_path)?;
    validate_tables(&connection)?;
    let meta = meta_rows(&connection);
    let mut state = session_state(
        &locator.database_path,
        &locator.session_id,
        &locator.metadata,
        &meta,
    );
    let mut messages = HeadTail::new(DETAIL_MESSAGE_LIMIT);
    let mut events = HeadTail::new(DETAIL_EVENT_LIMIT);
    visit_messages(&connection, |row| {
        let (values, timestamp) = message_messages(row);
        for mut value in values
            .into_iter()
            .filter_map(|value| state.accept_message(value))
        {
            attach_message_key(
                &mut value,
                json!({
                    "source_kind": "devin",
                    "session_id": locator.session_id,
                    "position": row.position,
                }),
            );
            visitor(&value);
            truncate_message(&mut value);
            messages.push(value);
        }
        events.push(json!({
            "line_number": row.position,
            "timestamp": timestamp,
            "type": row.kind,
            "payload": raw_payload(row),
        }));
    })?;
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
    let (mut summary, _) = finish_summary(
        &state,
        &locator.database_path,
        source,
        &locator.metadata,
        &meta,
    );
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
    use std::path::{Path, PathBuf};

    use rusqlite::{params, Connection};
    use serde_json::{json, Value};
    use tempfile::tempdir;

    use super::{matches_path, parse_detail, parse_source};
    use crate::sessions::{Source, SourceFormat};

    fn source(root: &Path) -> Source {
        Source {
            kind: "devin",
            display_name: "Devin",
            root: root.to_path_buf(),
            format: SourceFormat::Devin,
            archived: false,
        }
    }

    /// 构造一个含 user/agent/thought/tool/plan 的消息库与全局索引。
    fn fixture(root: &Path) {
        std::fs::create_dir_all(root.join("acp-messages")).unwrap();
        std::fs::create_dir_all(root.join("globalStorage")).unwrap();
        let session = Connection::open(root.join("acp-messages").join("ses-main.db")).unwrap();
        session
            .execute_batch(
                "create table meta (key text primary key, value text not null);
                 create table messages (position integer primary key, kind text not null, payload text not null);",
            )
            .unwrap();
        session
            .execute("insert into meta values ('schema_version', '6')", [])
            .unwrap();
        session
            .execute(
                "insert into meta values ('info', ?1)",
                params![json!({
                    "title": "元数据标题",
                    "configOptions": [
                        {"id": "mode", "currentValue": "accept-edits"},
                        {"id": "model", "currentValue": "swe-2-high"}
                    ]
                })
                .to_string()],
            )
            .unwrap();
        let rows: [(i64, &str, Value); 5] = [
            (
                0,
                "user_message",
                json!({"kind":"user_message","content":[
                    {"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"请修复登录页"},"_meta":{"cognition.ai/timestamp":"2026-08-26T01:25:15.000Z"}},
                    {"sessionUpdate":"user_message_chunk","content":{"type":"image","data": format!("iVBORw0KGgo{}", "A".repeat(11_000))}}
                ]}),
            ),
            (
                1,
                "agent_thought",
                json!({"kind":"agent_thought","content":[
                    {"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"先复现问题"},"_meta":{"cognition.ai/timestamp":"2026-08-26T01:25:20.000Z"}}
                ]}),
            ),
            (
                2,
                "tool_call",
                json!({"kind":"tool_call","content":{"toolCallId":"toolu_01","title":"Read file","rawInput":{"path":"/work/a.ts"},"status":"completed","_meta":{"cognition.ai/inferenceToolName":"read","cognition.ai/timestamp":"2026-08-26T01:25:30.000Z"}}}),
            ),
            (
                3,
                "agent_message",
                json!({"kind":"agent_message","content":[
                    {"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"已修复。"},"_meta":{"cognition.ai/timestamp":"2026-08-26T01:26:00.000Z"}}
                ]}),
            ),
            (
                4,
                "plan",
                json!({"kind":"plan","content":{"sessionUpdate":"plan","entries":[
                    {"content":"后端：刷新索引","priority":"medium","status":"done"},
                    {"content":"前端：展示计划","priority":"medium","status":"in_progress"}
                ]}}),
            ),
        ];
        for (position, kind, payload) in rows {
            session
                .execute(
                    "insert into messages values (?1, ?2, ?3)",
                    params![position, kind, payload.to_string()],
                )
                .unwrap();
        }
        drop(session);
        // 空草稿库，应被排除。
        Connection::open(root.join("acp-messages").join("ses-draft.db"))
            .unwrap()
            .execute_batch(
                "create table meta (key text primary key, value text not null);
                 create table messages (position integer primary key, kind text not null, payload text not null);",
            )
            .unwrap();
        let index = Connection::open(root.join("globalStorage").join("state.vscdb")).unwrap();
        index
            .execute_batch("create table ItemTable (key text primary key, value blob);")
            .unwrap();
        index
            .execute(
                "insert into ItemTable values ('windsurf.acp.sessioninfo.session.acp/devin-cli/trusted-judo', ?1)",
                params![json!({
                    "providerId": "devin-cli",
                    "info": {
                        "sessionId": "acp/devin-cli/trusted-judo",
                        "title": "会话标题",
                        "updatedAt": "2026-08-26T01:26:00+00:00",
                        "cwd": "/work/project",
                        "_meta": {"cognition.ai/createdAt": "2026-08-26T01:24:35.664Z"}
                    }
                })
                .to_string()],
            )
            .unwrap();
        index
            .execute(
                "insert into ItemTable values ('windsurf.acp.messageStore.session.acp/devin-cli/trusted-judo', ?1)",
                params![json!({"uuid": "ses-main", "lastUpdated": 1789439848881_i64}).to_string()],
            )
            .unwrap();
        index
            .execute(
                "insert into ItemTable values ('windsurf.acp.sessioninfo.session.legacy-uuid', ?1)",
                params![json!({
                    "providerId": "cascade",
                    "info": {"sessionId": "legacy-uuid", "title": "旧版键", "updatedAt": "2026-06-02T05:27:17.098Z", "cwd": "/work/legacy", "_meta": {"cognition.ai/createdAt": "2026-06-02T02:53:20.938Z"}}
                })
                .to_string()],
            )
            .unwrap();
    }

    #[test]
    fn 聚合会话摘要并排除空草稿() {
        let directory = tempdir().unwrap();
        let root = directory.path();
        fixture(root);
        let parsed = parse_source(&source(root)).unwrap();
        assert_eq!(parsed.sessions.len(), 1);
        let session = &parsed.sessions[0];
        // 桌面端镜像的 CLI 会话统一用 slug 作 id，便于与 CLI 库去重。
        assert_eq!(session.summary["id"], "trusted-judo");
        // 索引元数据优先：title/cwd/时间来自 state.vscdb。
        assert_eq!(session.summary["title"], "会话标题");
        assert_eq!(session.summary["cwd"], "/work/project");
        assert_eq!(session.summary["timestamp"], "2026-08-26T01:24:35.664Z");
        assert_eq!(
            session.summary["last_timestamp"],
            "2026-08-26T01:26:00+00:00"
        );
        assert_eq!(session.summary["model_provider"], "swe-2-high");
        assert_eq!(session.summary["originator"], "devin");
        assert_eq!(session.summary["source_read_only"], true);
        assert!(session.search_text.contains("请修复登录页"));
        assert!(parsed.active_paths.contains(
            root.join("acp-messages").join("ses-main.db")
                .to_string_lossy()
                .as_ref()
        ));
    }

    #[test]
    fn 缺少索引时回退消息库元数据() {
        let directory = tempdir().unwrap();
        let root = directory.path();
        std::fs::create_dir_all(root.join("acp-messages")).unwrap();
        let session = Connection::open(root.join("acp-messages").join("orphan.db")).unwrap();
        session
            .execute_batch(
                "create table meta (key text primary key, value text not null);
                 create table messages (position integer primary key, kind text not null, payload text not null);
                 insert into meta values ('info', '{\"title\":\"库内标题\"}');",
            )
            .unwrap();
        session
            .execute(
                "insert into messages values (0, 'user_message', ?1)",
                params![json!({"kind":"user_message","content":[{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"孤儿会话"},"_meta":{"cognition.ai/timestamp":"2026-08-01T00:00:00.000Z"}}]}).to_string()],
            )
            .unwrap();
        drop(session);
        let parsed = parse_source(&source(root)).unwrap();
        assert_eq!(parsed.sessions.len(), 1);
        let summary = &parsed.sessions[0].summary;
        assert_eq!(summary["id"], "orphan");
        assert_eq!(summary["title"], "库内标题");
        assert_eq!(summary["timestamp"], "2026-08-01T00:00:00.000Z");
    }

    #[test]
    fn 详情映射消息_思考_工具与计划并截断大图() {
        let directory = tempdir().unwrap();
        let root = directory.path();
        fixture(root);
        let parsed = parse_source(&source(root)).unwrap();
        let session = parsed.sessions.into_iter().next().unwrap();
        let detail = parse_detail(&source(root), &session.detail_locator).unwrap();
        let messages = detail["conversation_messages"].as_array().unwrap();
        let find = |subtype: &str| {
            messages
                .iter()
                .find(|message| message["source_subtype"] == subtype)
                .unwrap()
                .clone()
        };
        let user = find("text");
        assert_eq!(user["role"], "user");
        assert_eq!(user["text"], "请修复登录页");
        assert_eq!(user["timestamp"], "2026-08-26T01:25:15.000Z");
        let thinking = find("thinking");
        assert_eq!(thinking["role"], "assistant");
        assert_eq!(thinking["synthetic_context"], true);
        let tool = messages
            .iter()
            .find(|message| message["role"] == "tool")
            .unwrap();
        assert_eq!(tool["tool_name"], "read");
        assert_eq!(tool["tool_kind"], "tool_result");
        assert_eq!(tool["tool_call_id"], "toolu_01");
        assert_eq!(tool["is_error"], Value::Null);
        let plan = find("plan");
        assert!(plan["text"]
            .as_str()
            .unwrap()
            .contains("[done] 后端：刷新索引"));
        // 图片以合成占位消息出现，不携带 base64。
        let image = find("image");
        assert_eq!(image["text"], "[image]");
        assert!(messages
            .iter()
            .all(|message| !message["text"].as_str().unwrap_or("").contains("iVBOR")));
        assert!(messages
            .iter()
            .all(|message| message["_message_key"].is_string()));
        // 原始事件包含全部行，图片行因超大被截断标记。
        let events = detail["raw_events"].as_array().unwrap();
        assert_eq!(events.len(), 5);
        assert_eq!(events[0]["type"], "user_message");
        assert_eq!(events[0]["payload"]["truncated"], true);
        assert!(events[0]["payload"]["original_chars"].as_u64().unwrap() > 10_000);
        assert_eq!(
            events[2]["payload"]["content"]["rawInput"]["path"],
            "/work/a.ts"
        );
    }

    #[test]
    fn 内容指纹识别正文变化() {
        let directory = tempdir().unwrap();
        let root = directory.path();
        fixture(root);
        let fingerprint = || {
            parse_source(&source(root))
                .unwrap()
                .sessions
                .into_iter()
                .next()
                .unwrap()
                .detail_locator
                .content_fingerprint
        };
        let before = fingerprint();
        let connection = Connection::open(root.join("acp-messages").join("ses-main.db")).unwrap();
        connection
            .execute(
                "update messages set payload = ?1 where position = 3",
                params![json!({"kind":"agent_message","content":[{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"内容已更新"},"_meta":{"cognition.ai/timestamp":"2026-08-26T01:27:00.000Z"}}]}).to_string()],
            )
            .unwrap();
        drop(connection);
        assert_ne!(before, fingerprint());
    }

    #[test]
    fn 非消息库文件计入错误且目录缺失不算错误() {
        let directory = tempdir().unwrap();
        let root = directory.path();
        // 根目录还没有 acp-messages：不算错误。
        let empty = parse_source(&source(root)).unwrap();
        assert!(empty.sessions.is_empty());
        assert!(empty.errors.is_empty());
        std::fs::create_dir_all(root.join("acp-messages")).unwrap();
        Connection::open(root.join("acp-messages").join("not-devin.db")).unwrap();
        let parsed = parse_source(&source(root)).unwrap();
        assert!(parsed.sessions.is_empty());
        assert_eq!(parsed.errors.len(), 1);
        assert!(parsed.errors[0].2.contains("不是受支持的 Devin 消息库"));
    }

    /// 构造 CLI 聚合库：主链含 system/user/assistant(thinking+tool_calls)/
    /// tool/注入 user；外加废弃分支、隐藏会话与空会话。
    fn cli_fixture(root: &Path) -> PathBuf {
        let directory = root.join("cli");
        std::fs::create_dir_all(&directory).unwrap();
        let database = directory.join("sessions.db");
        let connection = Connection::open(&database).unwrap();
        connection
            .execute_batch(
                "create table sessions (
                    id text primary key, working_directory text not null,
                    backend_type text not null, model text not null,
                    agent_mode text not null, created_at integer not null,
                    last_activity_at integer not null, title text,
                    main_chain_id integer, hidden integer not null default 0);
                 create table message_nodes (
                    row_id integer primary key autoincrement,
                    session_id text not null, node_id integer not null,
                    parent_node_id integer, chat_message text not null,
                    created_at integer not null, metadata text,
                    unique(session_id, node_id));",
            )
            .unwrap();
        connection
            .execute(
                "insert into sessions values ('brisk-otter','/work/cli','windsurf','swe-2-max','smart',1789450000,1789450100,'CLI 标题',3,0)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "insert into sessions values ('ghost-mode','/work/hidden','windsurf','swe-2-max','smart',1789450000,1789450100,'隐藏会话',null,1)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "insert into sessions values ('empty-deer','/work/empty','windsurf','swe-2-max','smart',1789450000,1789450100,'空会话',null,0)",
                [],
            )
            .unwrap();
        let nodes: [(i64, Option<i64>, i64, Value); 7] = [
            (
                0,
                None,
                1789450001,
                json!({"role":"system","content":"系统提示"}),
            ),
            (
                1,
                Some(0),
                1789450002,
                json!({"role":"user","content":"修复登录页","metadata":{"is_user_input":true}}),
            ),
            (
                2,
                Some(1),
                1789450003,
                json!({"role":"assistant","content":"先复现问题","thinking":"{\"thinking\":\"想一下\"}","tool_calls":[{"id":"call_1","name":"exec","arguments":{"command":"ls"}}]}),
            ),
            (
                3,
                Some(2),
                1789450004,
                json!({"role":"tool","content":"README.md","tool_call_id":"call_1","metadata":{"extensions":{"chisel/tool_result_meta":{"success":true}}}}),
            ),
            // 2 的废弃分支，不出现在主链。
            (
                4,
                Some(2),
                1789450005,
                json!({"role":"assistant","content":"废弃分支"}),
            ),
            (
                5,
                Some(3),
                1789450006,
                json!({"role":"user","content":"Lint errors detected.","metadata":{"is_user_input":null}}),
            ),
            (
                6,
                Some(5),
                1789450007,
                json!({"role":"assistant","content":"已修复"}),
            ),
        ];
        for (node_id, parent, created_at, chat) in nodes {
            connection
                .execute(
                    "insert into message_nodes (session_id, node_id, parent_node_id, chat_message, created_at) values ('brisk-otter', ?1, ?2, ?3, ?4)",
                    rusqlite::params![node_id, parent, chat.to_string(), created_at],
                )
                .unwrap();
        }
        // 隐藏会话有一条消息但仍应被排除。
        connection
            .execute(
                "insert into message_nodes (session_id, node_id, parent_node_id, chat_message, created_at) values ('ghost-mode', 0, null, ?1, 1789450001)",
                rusqlite::params![json!({"role":"user","content":"hi","metadata":{"is_user_input":true}}).to_string()],
            )
            .unwrap();
        drop(connection);
        database
    }

    #[test]
    fn cli_聚合会话摘要并排除隐藏与空会话() {
        let directory = tempdir().unwrap();
        let root = directory.path();
        cli_fixture(root);
        let parsed = parse_source(&source(root)).unwrap();
        assert_eq!(parsed.errors, Vec::new());
        assert_eq!(parsed.sessions.len(), 1);
        let session = &parsed.sessions[0];
        assert_eq!(session.summary["title"], "CLI 标题");
        assert_eq!(session.summary["cwd"], "/work/cli");
        assert_eq!(session.summary["model_provider"], "swe-2-max");
        assert_eq!(session.summary["originator"], "devin");
        assert_eq!(session.summary["source_read_only"], true);
        assert!(session.summary["timestamp"].is_string());
        assert!(session.search_text.contains("修复登录页"));
        assert!(parsed
            .active_paths
            .contains(root.join("cli").join("sessions.db").to_string_lossy().as_ref()));
    }

    #[test]
    fn cli_详情按主链重建消息并映射角色() {
        let directory = tempdir().unwrap();
        let root = directory.path();
        let database = cli_fixture(root);
        let parsed = parse_source(&source(root)).unwrap();
        let session = parsed.sessions.into_iter().next().unwrap();
        let detail = parse_detail(&source(root), &session.detail_locator).unwrap();
        let messages = detail["conversation_messages"].as_array().unwrap();
        let texts: Vec<&str> = messages
            .iter()
            .filter_map(|message| message["text"].as_str())
            .collect();
        // 废弃分支不进详情。
        assert!(!texts.contains(&"废弃分支"));
        assert!(texts.contains(&"已修复"));
        let user = messages
            .iter()
            .find(|message| message["text"] == "修复登录页")
            .unwrap();
        assert_eq!(user["role"], "user");
        assert_eq!(user["synthetic_context"], false);
        // 注入的 user 消息标记为合成上下文。
        let injected = messages
            .iter()
            .find(|message| message["text"] == "Lint errors detected.")
            .unwrap();
        assert_eq!(injected["synthetic_context"], true);
        let thinking = messages
            .iter()
            .find(|message| message["source_subtype"] == "thinking")
            .unwrap();
        assert_eq!(thinking["text"], "想一下");
        let call = messages
            .iter()
            .find(|message| message["tool_kind"] == "tool_call")
            .unwrap();
        assert_eq!(call["tool_name"], "exec");
        assert_eq!(call["tool_call_id"], "call_1");
        let result = messages
            .iter()
            .find(|message| message["tool_kind"] == "tool_result")
            .unwrap();
        assert_eq!(result["tool_name"], "exec");
        assert_eq!(result["is_error"], Value::Null);
        // 原始事件覆盖主链全部节点。
        let events = detail["raw_events"].as_array().unwrap();
        assert_eq!(events.len(), 6);
        assert_eq!(events[1]["type"], "user");
        assert_eq!(events[1]["payload"]["content"], "修复登录页");
        // sessions.db 文件本身也可直接作为来源根。
        let file_source = Source {
            root: database.clone(),
            ..source(root)
        };
        let reparsed = parse_source(&file_source).unwrap();
        assert_eq!(reparsed.sessions.len(), 1);
        assert_eq!(reparsed.sessions[0].summary["id"], "brisk-otter");
    }

    #[test]
    fn cli_内容指纹识别主链节点变化() {
        let directory = tempdir().unwrap();
        let root = directory.path();
        let database = cli_fixture(root);
        let fingerprint = |root: &Path| {
            parse_source(&source(root)).unwrap().sessions[0]
                .detail_locator
                .content_fingerprint
                .clone()
        };
        let before = fingerprint(root);
        let connection = Connection::open(&database).unwrap();
        connection
            .execute(
                "update message_nodes set chat_message = ?1 where session_id = 'brisk-otter' and node_id = 6",
                rusqlite::params![json!({"role":"assistant","content":"已重写"}).to_string()],
            )
            .unwrap();
        drop(connection);
        assert_ne!(fingerprint(root), before);
    }

    #[test]
    fn 监听规则覆盖消息库_索引库与_cli_库() {
        let root = Path::new("/data/Devin/User");
        assert!(matches_path(root, &root.join("acp-messages").join("a.db")));
        assert!(matches_path(root, &root.join("acp-messages").join("a.db-wal")));
        assert!(matches_path(root, &root.join("globalStorage").join("state.vscdb")));
        assert!(matches_path(
            root,
            &root.join("globalStorage").join("state.vscdb-wal")
        ));
        assert!(!matches_path(root, &root.join("acp-messages").join("a.db-shm")));
        assert!(!matches_path(root, &root.join("globalStorage").join("other.dbx")));
        assert!(!matches_path(
            root,
            Path::new("/data/Devin/User-other/a.db")
        ));
        let cli_root = Path::new("/data/devin/cli");
        assert!(matches_path(cli_root, &cli_root.join("sessions.db")));
        assert!(matches_path(cli_root, &cli_root.join("sessions.db-wal")));
        assert!(!matches_path(cli_root, &cli_root.join("sessions.db-shm")));
        let data_root = Path::new("/data/devin");
        assert!(matches_path(data_root, &data_root.join("cli").join("sessions.db")));
        assert!(matches_path(
            Path::new("/data/devin/cli/sessions.db"),
            Path::new("/data/devin/cli/sessions.db-wal")
        ));
    }

    #[test]
    #[ignore = "本机 Devin 只读验证，只输出数量"]
    fn 本机只读验证() {
        let home = dirs::home_dir().unwrap();
        let desktop = dirs::config_dir().unwrap().join("Devin").join("User");
        let cli = home.join(".local").join("share").join("devin").join("cli");
        let mut sessions = Vec::new();
        let mut errors = Vec::new();
        for root in [desktop, cli] {
            let parsed = parse_source(&source(&root)).unwrap();
            sessions.extend(parsed.sessions);
            errors.extend(parsed.errors);
        }
        eprintln!("Devin 可读会话 {}，诊断 {}", sessions.len(), errors.len());
        for session in &sessions {
            eprintln!(
                "  {} · {} · {} 条消息",
                session.summary["id"].as_str().unwrap_or_default(),
                session.summary["title"].as_str().unwrap_or_default(),
                session.summary["message_count"]
            );
        }
        for (path, id, error) in &errors {
            eprintln!("  错误 {} · {} · {}", path.display(), id, error);
        }
    }
}
