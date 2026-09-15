use super::{
    attach_message_key, json_fingerprint, message_value, timestamp_from_millis, truncate_message,
    HeadTail, ParseState, Source, StoredSession, DETAIL_MESSAGE_LIMIT,
};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs::File,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Clone)]
pub(super) struct DetailLocator {
    path: PathBuf,
    id: String,
    metadata: Value,
    transcript: bool,
    pub content_fingerprint: String,
}

fn database(path: &Path) -> Result<Connection, String> {
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| e.to_string())?;
    db.busy_timeout(Duration::from_secs(2))
        .map_err(|e| e.to_string())?;
    Ok(db)
}

pub(super) fn matches_path(root: &Path, path: &Path) -> bool {
    if root.is_file() || root.extension().is_some_and(|ext| ext == "vscdb") {
        return super::opencode_event_matches(root, path);
    }
    if !path.starts_with(root) {
        return false;
    }
    super::opencode_event_matches(&root.join("globalStorage/state.vscdb"), path)
        || path.starts_with(root.join("workspaceStorage"))
            && matches!(
                path.file_name().and_then(|n| n.to_str()),
                Some("state.vscdb" | "state.vscdb-wal" | "workspace.json")
            )
        || path
            .components()
            .any(|c| c.as_os_str() == "agent-transcripts")
            && path.extension().is_some_and(|e| e == "jsonl")
}

fn workspace_metadata(root: &Path, metadata: &mut BTreeMap<String, Value>) -> Result<(), String> {
    let workspace = root.join("workspaceStorage");
    if !workspace.is_dir() {
        return Ok(());
    }
    for entry in std::fs::read_dir(workspace).map_err(|e| e.to_string())? {
        let directory = entry.map_err(|e| e.to_string())?.path();
        let db_path = directory.join("state.vscdb");
        let workspace_path = directory.join("workspace.json");
        if !db_path.is_file() || !workspace_path.is_file() {
            continue;
        }
        let info: Value =
            serde_json::from_reader(File::open(workspace_path).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        let folder = info["folder"]
            .as_str()
            .and_then(|v| url::Url::parse(v).ok())
            .and_then(|v| v.to_file_path().ok());
        let Some(folder) = folder else {
            continue;
        };
        let db = database(&db_path)?;
        let raw: Option<Option<String>> = db
            .query_row(
                "select cast(value as text) from ItemTable where key='composer.composerData'",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some(raw) = raw.flatten() {
            let info: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
            if let Some(headers) = info["allComposers"].as_array() {
                for header in headers {
                    if let Some(m) = header["composerId"]
                        .as_str()
                        .and_then(|id| metadata.get_mut(id))
                        .and_then(Value::as_object_mut)
                    {
                        m.entry("workspaceIdentifier")
                            .or_insert_with(|| json!({"uri":{"fsPath":folder.to_string_lossy()}}));
                        if let Some(name) = header["name"].as_str() {
                            m.entry("name").or_insert(json!(name));
                        }
                    }
                }
            }
        }
    }
    Ok(())
}

fn value(db: &Connection, key: &str) -> Result<Option<Value>, String> {
    let raw: Option<Option<Vec<u8>>> = db
        .query_row(
            "select cast(value as blob) from cursorDiskKV where key=?1",
            [key],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    raw.flatten()
        .map(|raw| serde_json::from_slice(&raw).map_err(|e| format!("Cursor 记录 JSON 无效：{e}")))
        .transpose()
}

fn visit(locator: &DetailLocator, visitor: &mut dyn FnMut(Value)) -> Result<(), String> {
    if locator.transcript {
        let reader = BufReader::new(File::open(&locator.path).map_err(|e| e.to_string())?);
        for (line, text) in reader.lines().enumerate() {
            let text = text.map_err(|e| e.to_string())?;
            if text.trim().is_empty() {
                continue;
            }
            let row: Value = serde_json::from_str(&text)
                .map_err(|e| format!("Cursor transcript 第 {} 行无效：{e}", line + 1))?;
            let Some(role) = row["role"].as_str() else {
                continue;
            };
            if !["user", "assistant", "system", "tool"].contains(&role) {
                continue;
            }
            if let Some(text) = row["message"]["content"].as_str() {
                emit(
                    locator,
                    &format!("line:{line}:0"),
                    role,
                    text,
                    "",
                    "text",
                    visitor,
                );
            } else if let Some(parts) = row["message"]["content"].as_array() {
                for (part, block) in parts.iter().enumerate() {
                    let (role, text, subtype) = match block["type"].as_str() {
                        Some("text") => (
                            role,
                            block["text"].as_str().unwrap_or_default().to_string(),
                            "text",
                        ),
                        Some("tool_use") => (
                            "tool",
                            format!(
                                "{}\n{}",
                                block["name"].as_str().unwrap_or("tool"),
                                block["input"]
                            ),
                            "tool_call",
                        ),
                        Some("tool_result") => (
                            "tool",
                            block["content"]
                                .as_str()
                                .map(str::to_owned)
                                .unwrap_or_else(|| block["content"].to_string()),
                            "tool_result",
                        ),
                        _ => continue,
                    };
                    emit(
                        locator,
                        &format!("line:{line}:{part}"),
                        role,
                        &text,
                        "",
                        subtype,
                        visitor,
                    );
                }
            }
        }
        return Ok(());
    }
    let db = database(&locator.path)?;
    let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
    let metadata =
        value(&tx, &format!("composerData:{}", locator.id))?.ok_or("Cursor 会话已不存在")?;
    if let Some(headers) = metadata["fullConversationHeadersOnly"]
        .as_array()
        .filter(|v| !v.is_empty())
    {
        for header in headers {
            let id = header["bubbleId"]
                .as_str()
                .ok_or("Cursor 消息缺少 bubbleId")?;
            let bubble = value(&tx, &format!("bubbleId:{}:{id}", locator.id))?
                .ok_or("Cursor 会话缺少引用的消息")?;
            bubble_message(locator, id, &bubble, visitor);
        }
    } else if let Some(messages) = metadata["conversation"]
        .as_array()
        .filter(|v| !v.is_empty())
    {
        for (i, bubble) in messages.iter().enumerate() {
            bubble_message(
                locator,
                bubble["bubbleId"].as_str().unwrap_or(&i.to_string()),
                bubble,
                visitor,
            );
        }
    } else if locator.id == "empty-state-draft" {
        // 仅跳过没有正文的内置草稿；有正文时仍走上面的消息分支。
        return Ok(());
    } else if metadata["conversationState"]
        .as_str()
        .is_some_and(|v| !v.is_empty())
    {
        return Err(UNSUPPORTED_AGENTKV.to_string());
    }
    Ok(())
}

fn bubble_message(
    locator: &DetailLocator,
    id: &str,
    bubble: &Value,
    visitor: &mut dyn FnMut(Value),
) {
    let role = match bubble["type"].as_i64() {
        Some(1) => "user",
        Some(2) => "assistant",
        _ => "unknown",
    };
    let timestamp = bubble["createdAt"]
        .as_i64()
        .and_then(timestamp_from_millis)
        .unwrap_or_default();
    emit(
        locator,
        id,
        role,
        bubble["text"].as_str().unwrap_or_default(),
        &timestamp,
        "text",
        visitor,
    );
    if let Some(text) = bubble["thinking"].as_str() {
        emit(
            locator,
            &format!("{id}:thinking"),
            "assistant",
            text,
            &timestamp,
            "thinking",
            visitor,
        );
    }
    if bubble["toolFormerData"].is_object() {
        emit(
            locator,
            &format!("{id}:tool"),
            "tool",
            &bubble["toolFormerData"].to_string(),
            &timestamp,
            "tool_call",
            visitor,
        );
    }
}

fn emit(
    locator: &DetailLocator,
    id: &str,
    role: &str,
    text: &str,
    time: &str,
    subtype: &str,
    visitor: &mut dyn FnMut(Value),
) {
    if text.is_empty() {
        return;
    }
    let mut message = message_value(role, text, time, "cursor", subtype, false);
    attach_message_key(
        &mut message,
        json!({"source_kind":"cursor","session_id":locator.id,"message_id":id}),
    );
    visitor(message);
}

pub(super) fn visit_detail(
    source: &Source,
    locator: &DetailLocator,
    visitor: &mut dyn FnMut(&Value),
) -> Result<Value, String> {
    let mut state = ParseState::new(&locator.path);
    state.id = locator.id.clone();
    state.cwd = locator
        .metadata
        .pointer("/workspaceIdentifier/uri/fsPath")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .into();
    state.timestamp = locator.metadata["createdAt"]
        .as_i64()
        .and_then(timestamp_from_millis)
        .unwrap_or_default();
    state.last_timestamp = locator.metadata["lastUpdatedAt"]
        .as_i64()
        .and_then(timestamp_from_millis)
        .unwrap_or_else(|| state.timestamp.clone());
    state.originator = "cursor".into();
    let mut messages = HeadTail::new(DETAIL_MESSAGE_LIMIT);
    visit(locator, &mut |message| {
        if let Some(mut message) = state.accept_message(message) {
            visitor(&message);
            truncate_message(&mut message);
            messages.push(message);
        }
    })?;
    let mut summary = state.summary(&locator.path, source);
    if let Some(title) = locator.metadata["name"].as_str().filter(|v| !v.is_empty()) {
        summary["title"] = json!(title);
    }
    summary["source"] = json!("ide");
    summary["model"] = locator.metadata["modelConfig"]["modelName"].clone();
    let (messages, omitted, total) =
        messages.finish(json!({"role":"system","text":"","is_truncation_marker":true}));
    Ok(
        json!({"summary":summary,"conversation_messages":messages,"raw_events":[],"truncation":{"truncated":omitted>0,"messages":{"omitted":omitted,"total":total},"raw_events":{"omitted":0}}}),
    )
}

/// 存在状态字段但没有可读正文时单独提示，不据此推断格式或数据完整性。
const UNSUPPORTED_AGENTKV: &str = "发现 Cursor 会话元数据，但未找到当前支持的正文；仅凭 conversationState 无法确定正文格式或完整性，如有对应 transcript 可读取";

pub(super) struct ParsedSource {
    pub records: Vec<StoredSession>,
    pub errors: Vec<(PathBuf, String, String)>,
    pub unsupported: Vec<(PathBuf, String, String)>,
}

pub(super) fn parse_source(source: &Source) -> Result<ParsedSource, String> {
    let mut locators = Vec::new();
    let mut errors = Vec::new();
    let mut unsupported = Vec::new();
    let path = if source.root.is_file() {
        source.root.clone()
    } else {
        source.root.join("globalStorage/state.vscdb")
    };
    if path.is_file() {
        let db = database(&path)?;
        let mut metadata = BTreeMap::new();
        let mut stmt=db.prepare("select key,cast(value as blob) from cursorDiskKV where key like 'composerData:%' and value is not null").map_err(|e|e.to_string())?;
        let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let key: String = row.get(0).map_err(|e| e.to_string())?;
            let raw: Vec<u8> = row.get(1).map_err(|e| e.to_string())?;
            match serde_json::from_slice::<Value>(&raw) {
                Ok(v) => {
                    metadata.insert(key.trim_start_matches("composerData:").to_string(), v);
                }
                Err(e) => errors.push((
                    path.clone(),
                    key.trim_start_matches("composerData:").to_string(),
                    format!("Cursor 会话元数据无效：{e}"),
                )),
            }
        }
        let has_headers:bool=db.query_row("select exists(select 1 from sqlite_master where name='composerHeaders' and type='table')",[],|r|r.get(0)).map_err(|e|e.to_string())?;
        if has_headers {
            let mut stmt = db
                .prepare("select composerId,value from composerHeaders")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
                })
                .map_err(|e| e.to_string())?;
            for row in rows {
                let (id, raw) = row.map_err(|e| e.to_string())?;
                let header: Value = match raw
                    .ok_or_else(|| "Cursor 会话头为空".to_string())
                    .and_then(|raw| serde_json::from_str(&raw).map_err(|e| e.to_string()))
                {
                    Ok(header) => header,
                    Err(error) => {
                        errors.push((path.clone(), id, error));
                        continue;
                    }
                };
                if let Some(m) = metadata.get_mut(&id).and_then(Value::as_object_mut) {
                    if let Some(h) = header.as_object() {
                        for (k, v) in h {
                            m.insert(k.clone(), v.clone());
                        }
                    }
                }
            }
        }
        if let Err(error) = workspace_metadata(&source.root, &mut metadata) {
            errors.push((
                source.root.clone(),
                String::new(),
                format!("Cursor 工作区元数据读取失败：{error}"),
            ));
        }
        for (id, metadata) in metadata {
            locators.push(DetailLocator {
                path: path.clone(),
                id,
                metadata,
                transcript: false,
                content_fingerprint: String::new(),
            });
        }
    } else if source.root.is_dir() {
        for entry in walkdir::WalkDir::new(&source.root) {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            if entry.file_type().is_file()
                && path.extension().is_some_and(|e| e == "jsonl")
                && path
                    .components()
                    .any(|c| c.as_os_str() == "agent-transcripts")
            {
                locators.push(DetailLocator {
                    path: path.to_path_buf(),
                    id: path.file_stem().unwrap().to_string_lossy().into_owned(),
                    metadata: json!({}),
                    transcript: true,
                    content_fingerprint: String::new(),
                });
            }
        }
    }
    let mut records = Vec::new();
    for mut locator in locators {
        let mut hash = sha2::Sha256::new();
        use sha2::Digest;
        let result = visit_detail(source, &locator, &mut |m| {
            hash.update(json_fingerprint(m).as_bytes())
        });
        match result {
            Ok(detail) => {
                let summary = detail["summary"].clone();
                if summary["message_count"].as_u64().unwrap_or(0) == 0 {
                    continue;
                }
                locator.content_fingerprint = format!(
                    "{}:{}",
                    json_fingerprint(&summary),
                    hash.finalize()
                        .iter()
                        .map(|v| format!("{v:02x}"))
                        .collect::<String>()
                );
                records.push(StoredSession {
                    search_text: super::summary_search_text(&summary),
                    summary,
                    source: source.clone(),
                    path: locator.path.clone(),
                    detail_locator: Some(super::DetailLocator::Cursor(locator)),
                });
            }
            Err(error) if error == UNSUPPORTED_AGENTKV => {
                unsupported.push((locator.path.clone(), locator.id.clone(), error))
            }
            Err(error) => errors.push((locator.path.clone(), locator.id.clone(), error)),
        }
    }
    Ok(ParsedSource {
        records,
        errors,
        unsupported,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn source(root: &Path) -> Source {
        Source {
            kind: "cursor",
            display_name: "Cursor",
            root: root.into(),
            format: super::super::SourceFormat::Cursor,
            archived: false,
        }
    }
    fn fixture(root: &Path) -> Connection {
        std::fs::create_dir_all(root.join("globalStorage")).unwrap();
        let db = Connection::open(root.join("globalStorage/state.vscdb")).unwrap();
        db.execute_batch("create table cursorDiskKV(key text primary key,value blob); create table composerHeaders(composerId text primary key,value text);").unwrap();
        db
    }
    fn put(db: &Connection, key: &str, value: Value) {
        db.execute(
            "insert or replace into cursorDiskKV values(?1,?2)",
            rusqlite::params![key, value.to_string()],
        )
        .unwrap();
    }

    #[test]
    fn 空草稿不计入诊断但有正文的草稿仍保留() {
        let directory = tempfile::tempdir().unwrap();
        let db = fixture(directory.path());
        put(
            &db,
            "composerData:empty-state-draft",
            json!({"conversationState":"~"}),
        );
        put(&db, "composerData:real", json!({"conversationState":"~"}));
        let parsed = parse_source(&source(directory.path())).unwrap();
        assert_eq!(parsed.unsupported.len(), 1);
        assert_eq!(parsed.unsupported[0].1, "real");
        put(
            &db,
            "composerData:empty-state-draft",
            json!({"conversation":[{"type":1,"text":"实际正文"}]}),
        );
        let parsed = parse_source(&source(directory.path())).unwrap();
        assert_eq!(parsed.records.len(), 1);
    }

    #[test]
    fn 损坏会话头不丢弃正文且诊断按会话区分() {
        let directory = tempfile::tempdir().unwrap();
        let db = fixture(directory.path());
        for id in ["first", "second"] {
            put(
                &db,
                &format!("composerData:{id}"),
                json!({"conversation":[{"type":1,"text":"保留正文"}]}),
            );
        }
        db.execute_batch("insert into composerHeaders values('first','{'); insert into composerHeaders values('second',NULL);").unwrap();
        let parsed = parse_source(&source(directory.path())).unwrap();
        assert_eq!(parsed.records.len(), 2);
        assert_eq!(parsed.errors.len(), 2);
        let mut diagnostics = super::super::ScanDiagnostics::default();
        for (path, id, error) in parsed.errors {
            diagnostics.record_session_error("cursor", &path, &id, &error);
        }
        for id in ["third", "fourth"] {
            put(
                &db,
                &format!("composerData:{id}"),
                json!({"conversationState":"encoded"}),
            );
        }
        for (path, id, reason) in parse_source(&source(directory.path())).unwrap().unsupported {
            diagnostics.record_unsupported("cursor", &path, &id, &reason);
        }
        let diagnostic = &diagnostics.sources["cursor"];
        assert_eq!(diagnostic.errors.len(), 2);
        assert_eq!(diagnostic.unsupported.len(), 2);
        let entries = super::super::diagnostic_entries(&diagnostic.errors);
        assert_eq!(entries[0]["session_id"], "first");
        assert_eq!(
            entries[0]["path"],
            directory
                .path()
                .join("globalStorage/state.vscdb")
                .to_string_lossy()
                .as_ref()
        );
    }

    #[test]
    fn 旧消息与引用消息按顺序读取且原始库不变() {
        let directory = tempfile::tempdir().unwrap();
        let db = fixture(directory.path());
        put(
            &db,
            "composerData:old",
            json!({"conversation":[{"type":1,"text":"旧问题"},{"type":2,"text":"旧回答"}]}),
        );
        put(
            &db,
            "composerData:new",
            json!({"fullConversationHeadersOnly":[{"bubbleId":"b"},{"bubbleId":"a"}]}),
        );
        put(&db, "bubbleId:new:a", json!({"type":2,"text":"回答"}));
        put(&db, "bubbleId:new:b", json!({"type":1,"text":"问题"}));
        db.execute(
            "insert into composerHeaders values('new',?1)",
            [
                json!({"name":"标题","workspaceIdentifier":{"uri":{"fsPath":"/project"}}})
                    .to_string(),
            ],
        )
        .unwrap();
        let before = std::fs::read(directory.path().join("globalStorage/state.vscdb")).unwrap();
        let parsed = parse_source(&source(directory.path())).unwrap();
        assert!(parsed.errors.is_empty());
        assert_eq!(parsed.records.len(), 2);
        let record = parsed
            .records
            .iter()
            .find(|r| r.summary["id"] == "new")
            .unwrap();
        assert_eq!(record.summary["cwd"], "/project");
        assert_eq!(record.summary["title"], "标题");
        let super::super::DetailLocator::Cursor(locator) = record.detail_locator.as_ref().unwrap()
        else {
            panic!()
        };
        let detail = visit_detail(&record.source, locator, &mut |_| {}).unwrap();
        assert_eq!(detail["conversation_messages"][0]["text"], "问题");
        assert_eq!(detail["conversation_messages"][1]["text"], "回答");
        assert!(detail["conversation_messages"][0]
            .get("_delete_ref")
            .is_none());
        assert_eq!(
            before,
            std::fs::read(directory.path().join("globalStorage/state.vscdb")).unwrap()
        );
    }

    #[test]
    fn 不支持的新格式和损坏记录不会吞掉有效会话() {
        let directory = tempfile::tempdir().unwrap();
        let db = fixture(directory.path());
        put(
            &db,
            "composerData:good",
            json!({"conversation":[{"type":1,"text":"保留"}]}),
        );
        put(
            &db,
            "composerData:new",
            json!({"conversationState":"encoded"}),
        );
        put(
            &db,
            "composerData:missing",
            json!({"fullConversationHeadersOnly":[{"bubbleId":"missing"}]}),
        );
        let parsed = parse_source(&source(directory.path())).unwrap();
        assert_eq!(parsed.records.len(), 1);
        // 未找到可读正文时单独统计，不推断格式或数据完整性。
        assert_eq!(parsed.unsupported.len(), 1);
        assert_eq!(parsed.unsupported[0].2, UNSUPPORTED_AGENTKV);
        assert_eq!(parsed.errors.len(), 1);
    }

    #[test]
    fn transcript解析消息工具并跳过状态事件() {
        let directory = tempfile::tempdir().unwrap();
        let folder = directory.path().join("project/agent-transcripts/session");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("session.jsonl"),format!("{}\n{}\n{}\n",
            json!({"role":"user","message":{"content":[{"type":"text","text":"问题"}]}}),
            json!({"role":"assistant","message":{"content":[{"type":"tool_use","name":"Shell","input":{"command":"pwd"}}]}}),
            json!({"type":"status","status":"completed"})
        )).unwrap();
        let parsed = parse_source(&source(directory.path())).unwrap();
        assert!(parsed.errors.is_empty());
        assert_eq!(parsed.records.len(), 1);
        assert_eq!(parsed.records[0].summary["id"], "session");
        assert_eq!(parsed.records[0].summary["message_count"], 2);
        assert_eq!(parsed.records[0].summary["tool_count"], 1);
        assert_eq!(parsed.records[0].summary["cwd"], "");
        assert!(matches_path(
            directory.path(),
            &folder.join("session.jsonl")
        ));
        assert!(!matches_path(
            directory.path(),
            &directory.path().join("History/file.json")
        ));
    }

    #[test]
    #[ignore = "本机 Cursor 只读验证，只输出数量"]
    fn 本机只读验证() {
        let home = dirs::home_dir().unwrap();
        for root in [
            dirs::config_dir().unwrap().join("Cursor/User"),
            home.join(".cursor/projects"),
        ] {
            let parsed = parse_source(&source(&root)).unwrap();
            eprintln!(
                "Cursor 可读会话 {}，诊断 {}",
                parsed.records.len(),
                parsed.errors.len()
            );
        }
    }

    #[test]
    fn 接入会话列表搜索并按会话编号去重() {
        use super::super as s;
        let directory = tempfile::tempdir().unwrap();
        let db = fixture(directory.path());
        put(
            &db,
            "composerData:shared",
            json!({"conversation":[{"type":1,"text":"数据库检索命中"}]}),
        );
        let projects = directory.path().join("projects");
        let transcripts = projects.join("project/agent-transcripts");
        std::fs::create_dir_all(&transcripts).unwrap();
        std::fs::write(
            transcripts.join("shared.jsonl"),
            json!({"role":"user","message":{"content":"重复副本"}}).to_string(),
        )
        .unwrap();
        let mut store = s::SessionStore {
            summaries: Vec::new(),
            records: Default::default(),
            sources: Vec::new(),
            sources_config: crate::config::SourceRoots {
                codex: Some(vec![]),
                codex_archived: Some(vec![]),
                claude: Some(vec![]),
                gemini: Some(vec![]),
                pi: Some(vec![]),
                kimi: Some(vec![]),
                opencode: Some(vec![]),
                zcode: Some(vec![]),
                cursor: Some(vec![
                    directory.path().to_string_lossy().into_owned(),
                    projects.to_string_lossy().into_owned(),
                ]),
                devin: Some(vec![]),
            },
            index_cache: crate::cache::IndexCache::disabled(),
            detail_cache: s::DetailCache::new(s::DETAIL_CACHE_BYTES),
            scan_diagnostics: Default::default(),
        };
        store.refresh().unwrap();
        assert_eq!(store.summaries.len(), 1);
        assert!(!store
            .refresh_paths(&std::collections::BTreeSet::from([directory
                .path()
                .join("globalStorage/state.vscdb-shm")]))
            .unwrap());
        let diagnostics = store.diagnostics();
        let cursor = &diagnostics["sources"]["cursor"];
        assert_eq!(cursor["indexed_sessions"], 1);
        assert_eq!(cursor["declared_roots"], 2);
        assert_eq!(cursor["available_roots"], 2);
        assert_eq!(cursor["enabled"], true);
        assert_eq!(diagnostics["sources"]["zcode"]["enabled"], false);
        let query = std::collections::HashMap::from([("q".to_string(), "检索".to_string())]);
        assert_eq!(
            store.search(&query, &Default::default()).unwrap()["total"],
            1
        );
        let detail = store.detail("cursor:shared").unwrap();
        assert_eq!(detail["conversation_messages"][0]["text"], "数据库检索命中");
        assert!(store
            .delete_message(
                "cursor:shared",
                detail["conversation_messages"][0]["_message_key"]
                    .as_str()
                    .unwrap()
            )
            .is_err());
        put(
            &db,
            "composerData:shared",
            json!({"conversation":[{"type":1,"text":"更新后的正文"}]}),
        );
        assert!(store
            .refresh_paths(&std::collections::BTreeSet::from([directory
                .path()
                .join("globalStorage/state.vscdb-wal")]))
            .unwrap());
        assert_eq!(
            store.search(&query, &Default::default()).unwrap()["total"],
            0
        );
        let database_path = directory.path().join("globalStorage/state.vscdb");
        store.sources_config.cursor = Some(vec![database_path.to_string_lossy().into_owned()]);
        store.refresh().unwrap();
        assert_eq!(store.summaries.len(), 1);
        drop(db);
        std::fs::remove_file(&database_path).unwrap();
        assert!(store
            .refresh_paths(&std::collections::BTreeSet::from([database_path]))
            .unwrap());
        assert!(store.summaries.is_empty());
    }
}
