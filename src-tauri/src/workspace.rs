use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

#[cfg(unix)]
use std::{ffi::OsString, os::unix::fs::PermissionsExt};

use chrono::{SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::{json, Map, Value};
use uuid::Uuid;

const MAX_SESSION_KEY_CHARS: usize = 512;
const MAX_MESSAGE_KEY_CHARS: usize = 512;
const MAX_NOTE_CHARS: usize = 10_000;
const MAX_TAGS: usize = 20;
const MAX_TAG_CHARS: usize = 40;
const MAX_FILTER_NAME_CHARS: usize = 60;
const MAX_FILTER_JSON_BYTES: usize = 8_192;

#[derive(Clone, Default)]
pub struct SessionWorkspace {
    pub archived: bool,
    pub removed: bool,
    pub favorite: bool,
    pub note: String,
    pub tags: BTreeSet<String>,
}

#[derive(Clone, Default)]
pub struct SavedFilter {
    id: String,
    name: String,
    filter: Value,
    updated_at: String,
}

#[derive(Clone, Default)]
pub struct WorkspaceSnapshot {
    pub sessions: BTreeMap<String, SessionWorkspace>,
    removed_messages: BTreeMap<String, BTreeSet<String>>,
    saved_filters: Vec<SavedFilter>,
    storage_path: Option<PathBuf>,
}

impl WorkspaceSnapshot {
    pub fn decorate_summary(&self, summary: &mut Value) {
        let Some(key) = summary["_key"].as_str() else {
            return;
        };
        let state = self.sessions.get(key).cloned().unwrap_or_default();
        summary["workspace"] = json!({
            "archived": state.archived,
            "removed": state.removed,
            "favorite": state.favorite,
            "note": state.note,
            "tags": state.tags,
        });
    }

    pub fn decorate_detail(&self, detail: &mut Value) {
        self.decorate_summary(&mut detail["summary"]);
        let Some(session_key) = detail["summary"]["_key"].as_str() else {
            return;
        };
        let removed = self.removed_messages.get(session_key);
        if let Some(messages) = detail["conversation_messages"].as_array_mut() {
            for message in messages {
                let is_removed = message["_message_key"]
                    .as_str()
                    .is_some_and(|key| removed.is_some_and(|keys| keys.contains(key)));
                message["_removed"] = Value::Bool(is_removed);
            }
        }
    }

    pub fn tags(&self) -> Vec<String> {
        self.sessions
            .values()
            .flat_map(|state| state.tags.iter().cloned())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect()
    }

    pub fn value(&self) -> Value {
        let sessions = self
            .sessions
            .iter()
            .map(|(key, state)| {
                (
                    key.clone(),
                    json!({
                        "archived": state.archived,
                        "removed": state.removed,
                        "favorite": state.favorite,
                        "note": state.note,
                        "tags": state.tags,
                    }),
                )
            })
            .collect::<Map<_, _>>();
        let messages = self
            .removed_messages
            .iter()
            .map(|(key, values)| (key.clone(), json!(values)))
            .collect::<Map<_, _>>();
        let saved_filters = self
            .saved_filters
            .iter()
            .map(|filter| {
                json!({
                    "id": filter.id,
                    "name": filter.name,
                    "filter": filter.filter,
                    "updated_at": filter.updated_at,
                })
            })
            .collect::<Vec<_>>();
        json!({
            "sessions": sessions,
            "removed_messages": messages,
            "saved_filters": saved_filters,
            "storage": {
                "enabled": self.storage_path.is_some(),
                "path": self.storage_path.as_ref().map(|path| path.to_string_lossy()),
                "session_count": self.sessions.len(),
                "saved_filter_count": self.saved_filters.len(),
            }
        })
    }
}

pub struct WorkspaceStore {
    connection: Connection,
    path: PathBuf,
}

impl WorkspaceStore {
    pub fn open() -> Result<Self, String> {
        let path = workspace_path().ok_or_else(|| "无法确定工作台数据目录".to_string())?;
        Self::open_at(&path)
    }

    fn open_at(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(error_text)?;
        }
        let connection = Connection::open(path).map_err(error_text)?;
        lock_down_database(path)?;
        connection
            .execute_batch(
                "pragma journal_mode = wal;
                 pragma foreign_keys = on;
                 create table if not exists session_workspace(
                   session_key text primary key,
                   archived integer not null default 0,
                   removed integer not null default 0,
                   favorite integer not null default 0,
                   note text not null default '',
                   updated_at text not null
                 );
                 create table if not exists message_workspace(
                   session_key text not null,
                   message_key text not null,
                   removed integer not null default 0,
                   updated_at text not null,
                   primary key(session_key, message_key)
                 );
                 create table if not exists session_tags(
                   session_key text not null,
                   tag text not null,
                   primary key(session_key, tag)
                 );
                 create table if not exists saved_filters(
                   id text primary key,
                   name text not null,
                   filter_json text not null,
                   updated_at text not null
                 );",
            )
            .map_err(error_text)?;
        lock_down_database(path)?;
        Ok(Self {
            connection,
            path: path.to_path_buf(),
        })
    }

    pub fn snapshot(&self) -> Result<WorkspaceSnapshot, String> {
        let mut snapshot = WorkspaceSnapshot {
            storage_path: Some(self.path.clone()),
            ..WorkspaceSnapshot::default()
        };
        {
            let mut statement = self
                .connection
                .prepare(
                    "select session_key, archived, removed, favorite, note
                     from session_workspace",
                )
                .map_err(error_text)?;
            let rows = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        SessionWorkspace {
                            archived: row.get::<_, i64>(1)? != 0,
                            removed: row.get::<_, i64>(2)? != 0,
                            favorite: row.get::<_, i64>(3)? != 0,
                            note: row.get(4)?,
                            tags: BTreeSet::new(),
                        },
                    ))
                })
                .map_err(error_text)?;
            for row in rows {
                let (key, state) = row.map_err(error_text)?;
                snapshot.sessions.insert(key, state);
            }
        }
        {
            let mut statement = self
                .connection
                .prepare("select session_key, tag from session_tags order by tag")
                .map_err(error_text)?;
            let rows = statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(error_text)?;
            for row in rows {
                let (key, tag) = row.map_err(error_text)?;
                snapshot.sessions.entry(key).or_default().tags.insert(tag);
            }
        }
        {
            let mut statement = self
                .connection
                .prepare(
                    "select session_key, message_key from message_workspace
                     where removed = 1 order by message_key",
                )
                .map_err(error_text)?;
            let rows = statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(error_text)?;
            for row in rows {
                let (session_key, message_key) = row.map_err(error_text)?;
                snapshot
                    .removed_messages
                    .entry(session_key)
                    .or_default()
                    .insert(message_key);
            }
        }
        {
            let mut statement = self
                .connection
                .prepare(
                    "select id, name, filter_json, updated_at
                     from saved_filters order by updated_at desc, name",
                )
                .map_err(error_text)?;
            let rows = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                })
                .map_err(error_text)?;
            for row in rows {
                let (id, name, filter_json, updated_at) = row.map_err(error_text)?;
                let filter = serde_json::from_str(&filter_json)
                    .map_err(|error| format!("常用筛选 {id} 数据损坏：{error}"))?;
                snapshot.saved_filters.push(SavedFilter {
                    id,
                    name,
                    filter,
                    updated_at,
                });
            }
        }
        Ok(snapshot)
    }

    pub fn update_session(&mut self, body: &Value) -> Result<Value, String> {
        let key = required_text(body, "sessionKey", MAX_SESSION_KEY_CHARS)?;
        let mut state = self.session_state(&key)?;
        if let Some(value) = optional_bool(body, "archived")? {
            state.archived = value;
        }
        if let Some(value) = optional_bool(body, "removed")? {
            state.removed = value;
        }
        if let Some(value) = optional_bool(body, "favorite")? {
            state.favorite = value;
        }
        if let Some(value) = body.get("note") {
            let note = value
                .as_str()
                .ok_or_else(|| "note 必须是字符串".to_string())?
                .trim();
            validate_length(note, "备注", MAX_NOTE_CHARS)?;
            state.note = note.to_string();
        }
        let tags = body.get("tags").map(parse_tags).transpose()?;
        let transaction = self.connection.transaction().map_err(error_text)?;
        write_session_state(&transaction, &key, &state)?;
        if let Some(tags) = tags {
            transaction
                .execute("delete from session_tags where session_key = ?1", [&key])
                .map_err(error_text)?;
            for tag in &tags {
                transaction
                    .execute(
                        "insert into session_tags(session_key, tag) values(?1, ?2)",
                        params![key, tag],
                    )
                    .map_err(error_text)?;
            }
            state.tags = tags;
        }
        transaction.commit().map_err(error_text)?;
        Ok(json!({
            "session_key": key,
            "workspace": {
                "archived": state.archived,
                "removed": state.removed,
                "favorite": state.favorite,
                "note": state.note,
                "tags": state.tags,
            }
        }))
    }

    pub fn update_message(&self, body: &Value) -> Result<Value, String> {
        let session_key = required_text(body, "sessionKey", MAX_SESSION_KEY_CHARS)?;
        let message_key = required_text(body, "messageKey", MAX_MESSAGE_KEY_CHARS)?;
        let removed = body
            .get("removed")
            .and_then(Value::as_bool)
            .ok_or_else(|| "removed 必须是布尔值".to_string())?;
        if removed {
            self.connection
                .execute(
                    "insert into message_workspace(session_key, message_key, removed, updated_at)
                     values(?1, ?2, 1, ?3)
                     on conflict(session_key, message_key) do update set removed = 1, updated_at = excluded.updated_at",
                    params![session_key, message_key, now()],
                )
                .map_err(error_text)?;
        } else {
            self.connection
                .execute(
                    "delete from message_workspace where session_key = ?1 and message_key = ?2",
                    params![session_key, message_key],
                )
                .map_err(error_text)?;
        }
        Ok(json!({ "ok": true, "removed": removed }))
    }

    pub fn save_filter(&self, body: &Value) -> Result<Value, String> {
        let name = required_text(body, "name", MAX_FILTER_NAME_CHARS)?;
        let filter = body
            .get("filter")
            .filter(|value| value.is_object())
            .ok_or_else(|| "filter 必须是对象".to_string())?;
        let filter_json = serde_json::to_string(filter).map_err(error_text)?;
        if filter_json.len() > MAX_FILTER_JSON_BYTES {
            return Err("筛选条件过大".into());
        }
        let id = body
            .get("id")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(str::trim)
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        validate_length(&id, "筛选标识", 80)?;
        let updated_at = now();
        self.connection
            .execute(
                "insert into saved_filters(id, name, filter_json, updated_at)
                 values(?1, ?2, ?3, ?4)
                 on conflict(id) do update set name = excluded.name, filter_json = excluded.filter_json, updated_at = excluded.updated_at",
                params![id, name, filter_json, updated_at],
            )
            .map_err(error_text)?;
        Ok(json!({ "id": id, "name": name, "filter": filter, "updated_at": updated_at }))
    }

    pub fn delete_filter(&self, body: &Value) -> Result<Value, String> {
        let id = required_text(body, "id", 80)?;
        self.connection
            .execute("delete from saved_filters where id = ?1", [&id])
            .map_err(error_text)?;
        Ok(json!({ "ok": true }))
    }

    pub fn migrate_legacy(&mut self, body: &Value) -> Result<Value, String> {
        let archived = string_array(body.get("archivedSessions"), MAX_SESSION_KEY_CHARS)?;
        let removed = string_array(body.get("removedSessions"), MAX_SESSION_KEY_CHARS)?;
        let removed_messages = match body.get("removedMessages") {
            Some(value) => value
                .as_object()
                .cloned()
                .ok_or_else(|| "removedMessages 必须是对象".to_string())?,
            None => Map::new(),
        };
        let transaction = self.connection.transaction().map_err(error_text)?;
        for key in archived {
            migrate_session_flag(&transaction, &key, "archived")?;
        }
        for key in removed {
            migrate_session_flag(&transaction, &key, "removed")?;
        }
        for (session_key, message_keys) in removed_messages {
            validate_length(&session_key, "会话标识", MAX_SESSION_KEY_CHARS)?;
            for message_key in string_array(Some(&message_keys), MAX_MESSAGE_KEY_CHARS)? {
                transaction
                    .execute(
                        "insert into message_workspace(session_key, message_key, removed, updated_at)
                         values(?1, ?2, 1, ?3)
                         on conflict(session_key, message_key) do update set removed = 1, updated_at = excluded.updated_at",
                        params![session_key, message_key, now()],
                    )
                    .map_err(error_text)?;
            }
        }
        transaction.commit().map_err(error_text)?;
        Ok(json!({ "ok": true }))
    }

    pub fn clear_session(&self, session_key: &str) -> Result<(), String> {
        validate_length(session_key, "会话标识", MAX_SESSION_KEY_CHARS)?;
        self.connection
            .execute_batch("begin immediate")
            .map_err(error_text)?;
        let result = (|| {
            self.connection
                .execute(
                    "delete from session_workspace where session_key = ?1",
                    [session_key],
                )
                .map_err(error_text)?;
            self.connection
                .execute(
                    "delete from session_tags where session_key = ?1",
                    [session_key],
                )
                .map_err(error_text)?;
            self.connection
                .execute(
                    "delete from message_workspace where session_key = ?1",
                    [session_key],
                )
                .map_err(error_text)?;
            Ok::<(), String>(())
        })();
        if result.is_ok() {
            self.connection
                .execute_batch("commit")
                .map_err(error_text)?;
        } else {
            let _ = self.connection.execute_batch("rollback");
        }
        result
    }

    pub fn clear_message(&self, session_key: &str, message_key: &str) -> Result<(), String> {
        validate_length(session_key, "会话标识", MAX_SESSION_KEY_CHARS)?;
        validate_length(message_key, "消息标识", MAX_MESSAGE_KEY_CHARS)?;
        self.connection
            .execute(
                "delete from message_workspace where session_key = ?1 and message_key = ?2",
                params![session_key, message_key],
            )
            .map_err(error_text)?;
        Ok(())
    }

    fn session_state(&self, key: &str) -> Result<SessionWorkspace, String> {
        let mut state = self
            .connection
            .query_row(
                "select archived, removed, favorite, note from session_workspace where session_key = ?1",
                [key],
                |row| {
                    Ok(SessionWorkspace {
                        archived: row.get::<_, i64>(0)? != 0,
                        removed: row.get::<_, i64>(1)? != 0,
                        favorite: row.get::<_, i64>(2)? != 0,
                        note: row.get(3)?,
                        tags: BTreeSet::new(),
                    })
                },
            )
            .optional()
            .map_err(error_text)
            .map(|value| value.unwrap_or_default())?;
        let mut statement = self
            .connection
            .prepare("select tag from session_tags where session_key = ?1 order by tag")
            .map_err(error_text)?;
        let tags = statement
            .query_map([key], |row| row.get::<_, String>(0))
            .map_err(error_text)?;
        for tag in tags {
            state.tags.insert(tag.map_err(error_text)?);
        }
        Ok(state)
    }
}

fn write_session_state(
    transaction: &Transaction<'_>,
    key: &str,
    state: &SessionWorkspace,
) -> Result<(), String> {
    transaction
        .execute(
            "insert into session_workspace(session_key, archived, removed, favorite, note, updated_at)
             values(?1, ?2, ?3, ?4, ?5, ?6)
             on conflict(session_key) do update set archived = excluded.archived, removed = excluded.removed,
               favorite = excluded.favorite, note = excluded.note, updated_at = excluded.updated_at",
            params![
                key,
                i64::from(state.archived),
                i64::from(state.removed),
                i64::from(state.favorite),
                state.note,
                now(),
            ],
        )
        .map_err(error_text)?;
    Ok(())
}

fn migrate_session_flag(
    transaction: &Transaction<'_>,
    key: &str,
    column: &str,
) -> Result<(), String> {
    validate_length(key, "会话标识", MAX_SESSION_KEY_CHARS)?;
    let sql = match column {
        "archived" => {
            "insert into session_workspace(session_key, archived, updated_at) values(?1, 1, ?2)
             on conflict(session_key) do update set archived = 1, updated_at = excluded.updated_at"
        }
        "removed" => {
            "insert into session_workspace(session_key, removed, updated_at) values(?1, 1, ?2)
             on conflict(session_key) do update set removed = 1, updated_at = excluded.updated_at"
        }
        _ => return Err("不支持的迁移字段".into()),
    };
    transaction
        .execute(sql, params![key, now()])
        .map_err(error_text)?;
    Ok(())
}

fn workspace_path() -> Option<PathBuf> {
    std::env::var_os("ALLSESSIONS_WORKSPACE_DB")
        .map(PathBuf::from)
        .or_else(|| {
            dirs::data_local_dir().map(|root| root.join("AllSessions").join("workspace.sqlite"))
        })
}

fn required_text(body: &Value, key: &str, max_chars: usize) -> Result<String, String> {
    let value = body
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("缺少 {key}"))?;
    validate_length(value, key, max_chars)?;
    Ok(value.to_string())
}

fn validate_length(value: &str, label: &str, max_chars: usize) -> Result<(), String> {
    if value.chars().count() > max_chars {
        return Err(format!("{label}不能超过 {max_chars} 个字符"));
    }
    Ok(())
}

fn optional_bool(body: &Value, key: &str) -> Result<Option<bool>, String> {
    match body.get(key) {
        Some(value) => value
            .as_bool()
            .map(Some)
            .ok_or_else(|| format!("{key} 必须是布尔值")),
        None => Ok(None),
    }
}

fn parse_tags(value: &Value) -> Result<BTreeSet<String>, String> {
    let values = value
        .as_array()
        .ok_or_else(|| "tags 必须是数组".to_string())?;
    if values.len() > MAX_TAGS {
        return Err(format!("每个会话最多设置 {MAX_TAGS} 个标签"));
    }
    let mut tags = BTreeSet::new();
    for value in values {
        let tag = value
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "标签不能为空".to_string())?;
        validate_length(tag, "标签", MAX_TAG_CHARS)?;
        tags.insert(tag.to_string());
    }
    Ok(tags)
}

fn string_array(value: Option<&Value>, max_chars: usize) -> Result<Vec<String>, String> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let values = value
        .as_array()
        .ok_or_else(|| "迁移数据必须是数组".to_string())?;
    if values.len() > 20_000 {
        return Err("迁移数据条目过多".into());
    }
    values
        .iter()
        .map(|value| {
            let value = value
                .as_str()
                .ok_or_else(|| "迁移数据必须是字符串数组".to_string())?;
            validate_length(value, "迁移标识", max_chars)?;
            Ok(value.to_string())
        })
        .collect()
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(unix)]
fn lock_down_database(path: &Path) -> Result<(), String> {
    for suffix in ["", "-wal", "-shm"] {
        let mut target = OsString::from(path.as_os_str());
        target.push(suffix);
        match fs::set_permissions(&target, fs::Permissions::from_mode(0o600)) {
            Ok(()) => {}
            Err(error) if !suffix.is_empty() && error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error_text(error)),
        }
    }
    Ok(())
}

#[cfg(not(unix))]
fn lock_down_database(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn error_text(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use tempfile::tempdir;

    use super::WorkspaceStore;

    #[cfg(unix)]
    #[test]
    fn 工作台数据库及日志文件仅限当前用户访问() {
        use std::{ffi::OsString, os::unix::fs::PermissionsExt};

        let directory = tempdir().unwrap();
        let path = directory.path().join("workspace.sqlite");
        let _store = WorkspaceStore::open_at(&path).unwrap();

        for suffix in ["", "-wal", "-shm"] {
            let mut target = OsString::from(path.as_os_str());
            target.push(suffix);
            let permissions = std::fs::metadata(target).unwrap().permissions().mode() & 0o777;
            assert_eq!(permissions, 0o600, "{suffix} 权限应为 0600");
        }
    }

    #[test]
    fn 工作台状态会持久化并装饰会话详情() {
        let directory = tempdir().unwrap();
        let mut store =
            WorkspaceStore::open_at(&directory.path().join("workspace.sqlite")).unwrap();
        store
            .update_session(&json!({
                "sessionKey": "codex:s1",
                "archived": true,
                "favorite": true,
                "note": "后续继续",
                "tags": ["工作", "重要"]
            }))
            .unwrap();
        store
            .update_message(&json!({
                "sessionKey": "codex:s1",
                "messageKey": "m1",
                "removed": true
            }))
            .unwrap();
        let updated = store
            .update_session(&json!({ "sessionKey": "codex:s1", "favorite": false }))
            .unwrap();
        assert_eq!(updated["workspace"]["tags"][0], "工作");
        let snapshot = store.snapshot().unwrap();
        let mut detail = json!({
            "summary": { "_key": "codex:s1" },
            "conversation_messages": [{ "_message_key": "m1" }, { "_message_key": "m2" }]
        });
        snapshot.decorate_detail(&mut detail);

        assert_eq!(detail["summary"]["workspace"]["favorite"], false);
        assert_eq!(detail["summary"]["workspace"]["tags"][0], "工作");
        assert_eq!(detail["conversation_messages"][0]["_removed"], true);
        assert_eq!(detail["conversation_messages"][1]["_removed"], false);
    }

    #[test]
    fn 旧版浏览器状态迁移会合并而不是覆盖() {
        let directory = tempdir().unwrap();
        let mut store =
            WorkspaceStore::open_at(&directory.path().join("workspace.sqlite")).unwrap();
        store
            .update_session(&json!({ "sessionKey": "codex:s1", "favorite": true }))
            .unwrap();
        store
            .migrate_legacy(&json!({
                "archivedSessions": ["codex:s1"],
                "removedSessions": ["codex:s2"],
                "removedMessages": { "codex:s1": ["m1"] }
            }))
            .unwrap();
        let snapshot = store.snapshot().unwrap();

        assert!(snapshot.sessions["codex:s1"].favorite);
        assert!(snapshot.sessions["codex:s1"].archived);
        assert!(snapshot.sessions["codex:s2"].removed);
        assert!(snapshot.removed_messages["codex:s1"].contains("m1"));
    }

    #[test]
    fn 常用筛选可以保存和删除() {
        let directory = tempdir().unwrap();
        let store = WorkspaceStore::open_at(&directory.path().join("workspace.sqlite")).unwrap();
        let saved = store
            .save_filter(&json!({ "name": "收藏的 Codex", "filter": { "favorite": true, "source_kind": "codex" } }))
            .unwrap();
        let snapshot = store.snapshot().unwrap();
        assert_eq!(snapshot.saved_filters.len(), 1);
        assert_eq!(snapshot.saved_filters[0].name, "收藏的 Codex");

        store.delete_filter(&json!({ "id": saved["id"] })).unwrap();
        assert!(store.snapshot().unwrap().saved_filters.is_empty());
    }
}
