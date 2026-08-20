use std::{
    collections::BTreeSet,
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

/// 摘要缓存格式版本。当 parse_summary 的字段、隐藏规则或消息解析逻辑发生变化时
/// 必须递增：版本不匹配的旧缓存会在打开时被整体清空，避免历史文件复用过期摘要。
const CACHE_VERSION: i32 = 1;

pub struct IndexCache {
    connection: Option<Connection>,
    path: Option<PathBuf>,
}

pub struct CachedSummary {
    pub summary: Value,
    pub search_text: String,
}

impl IndexCache {
    #[cfg(test)]
    pub fn disabled() -> Self {
        Self {
            connection: None,
            path: None,
        }
    }

    #[cfg(test)]
    pub fn open_at(path: &Path) -> Self {
        match open_database(path) {
            Ok(connection) => Self {
                connection: Some(connection),
                path: Some(path.to_path_buf()),
            },
            Err(error) => {
                eprintln!("打开测试缓存失败：{error}");
                Self {
                    connection: None,
                    path: None,
                }
            }
        }
    }

    pub fn open() -> Result<Self, String> {
        if std::env::var_os("SESSION_VIEWER_DISABLE_CACHE").as_deref()
            == Some(std::ffi::OsStr::new("1"))
        {
            return Ok(Self {
                connection: None,
                path: None,
            });
        }
        let (path, connection) = match cache_database_paths() {
            Some((path, legacy_paths)) => match open_database_with_legacy(&path, &legacy_paths) {
                Ok(connection) => (Some(path), Some(connection)),
                Err(error) => {
                    eprintln!("打开会话索引缓存失败，已禁用缓存：{error}");
                    (None, None)
                }
            },
            None => (None, None),
        };
        Ok(Self { connection, path })
    }

    pub fn clear(&self) {
        if let Some(connection) = &self.connection {
            if let Err(error) = connection.execute("delete from sessions", []) {
                eprintln!("清空会话索引缓存失败：{error}");
            }
        }
    }

    pub fn storage_info(&self) -> Value {
        let Some(path) = &self.path else {
            return serde_json::json!({ "enabled": false });
        };
        let mut bytes = 0_u64;
        for suffix in ["", "-wal", "-shm"] {
            let mut value = path.as_os_str().to_os_string();
            value.push(suffix);
            if let Ok(metadata) = fs::metadata(&value) {
                bytes += metadata.len();
            }
        }
        serde_json::json!({
            "enabled": true,
            "path": path.to_string_lossy(),
            "bytes": bytes,
        })
    }

    pub fn get(&self, path: &Path, kind: &str, metadata: &fs::Metadata) -> Option<CachedSummary> {
        let connection = self.connection.as_ref()?;
        let (size, modified) = fingerprint(metadata)?;
        let value = match connection.query_row(
            "select summary_json, search_text from sessions where path = ?1 and kind = ?2 and size = ?3 and modified_ns = ?4",
            params![path.to_string_lossy(), kind, size, modified],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        ).optional() {
            Ok(value) => value?,
            Err(error) => { eprintln!("读取会话索引缓存失败：{error}"); return None; }
        };
        Some(CachedSummary {
            summary: serde_json::from_str(&value.0).ok()?,
            search_text: value.1,
        })
    }

    pub fn put(
        &self,
        path: &Path,
        kind: &str,
        metadata: &fs::Metadata,
        summary: &Value,
        search_text: &str,
    ) {
        let Some(connection) = &self.connection else {
            return;
        };
        let Some((size, modified)) = fingerprint(metadata) else {
            return;
        };
        let Ok(summary_json) = serde_json::to_string(summary) else {
            return;
        };
        if let Err(error) = connection.execute(
            "insert into sessions(path, kind, size, modified_ns, summary_json, search_text) values(?1, ?2, ?3, ?4, ?5, ?6)
             on conflict(path) do update set kind=excluded.kind, size=excluded.size, modified_ns=excluded.modified_ns, summary_json=excluded.summary_json, search_text=excluded.search_text",
            params![path.to_string_lossy(), kind, size, modified, summary_json, search_text],
        ) { eprintln!("写入会话索引缓存失败：{error}"); }
    }

    pub fn prune(&self, active_paths: &BTreeSet<String>) {
        let Some(connection) = &self.connection else {
            return;
        };
        let Ok(mut statement) = connection.prepare("select path from sessions") else {
            return;
        };
        let Ok(rows) = statement.query_map([], |row| row.get::<_, String>(0)) else {
            return;
        };
        let stale = rows
            .filter_map(Result::ok)
            .filter(|path| !active_paths.contains(path))
            .collect::<Vec<_>>();
        drop(statement);
        for path in stale {
            let _ = connection.execute("delete from sessions where path = ?1", [path]);
        }
    }

    pub fn remove(&self, path: &Path) {
        if let Some(connection) = &self.connection {
            let _ = connection.execute(
                "delete from sessions where path = ?1",
                [path.to_string_lossy()],
            );
        }
    }
}

fn cache_database_paths() -> Option<(PathBuf, Vec<PathBuf>)> {
    if let Some(root) = std::env::var_os("SESSION_VIEWER_CACHE_DIR").map(PathBuf::from) {
        return Some((
            root.join("session-index.sqlite"),
            vec![root.join("session-index.json")],
        ));
    }

    let root = dirs::cache_dir()?;
    let current_root = root.join("AllSessions");
    let mut legacy_roots = vec![
        current_root.clone(),
        root.join("allsessions"),
        root.join("AllSessions").join("Cache"),
    ];
    legacy_roots.dedup();
    Some((
        current_root.join("session-index.sqlite"),
        legacy_roots
            .into_iter()
            .map(|path| path.join("session-index.json"))
            .collect(),
    ))
}

#[cfg(test)]
fn open_database(path: &Path) -> Result<Connection, String> {
    let legacy_path = path.with_file_name("session-index.json");
    open_database_with_legacy(path, &[legacy_path])
}

fn open_database_with_legacy(path: &Path, legacy_paths: &[PathBuf]) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    lock_down_cache_permissions(path)?;
    connection
        .execute_batch(
            "pragma journal_mode = wal;
         create table if not exists sessions(
           path text primary key,
           kind text not null,
           size integer not null,
           modified_ns integer not null,
           summary_json text not null,
           search_text text not null
         );",
        )
        .map_err(|error| error.to_string())?;
    let stored_version = connection
        .query_row("pragma user_version", [], |row| row.get::<_, i32>(0))
        .unwrap_or(0);
    let version_matches = stored_version == CACHE_VERSION;
    if !version_matches {
        // 解析器版本变化：整体丢弃旧缓存，未修改的历史文件也会重新解析。
        // 版本不匹配时同时跳过旧 JSON 索引迁移，避免清空后又被旧摘要回填。
        connection
            .execute("delete from sessions", [])
            .map_err(|error| error.to_string())?;
        connection
            .pragma_update(None, "user_version", CACHE_VERSION)
            .map_err(|error| error.to_string())?;
    }
    if version_matches {
        for legacy_path in legacy_paths {
            migrate_legacy_cache(&connection, legacy_path);
        }
    }
    lock_down_cache_permissions(path)?;
    Ok(connection)
}

#[cfg(unix)]
fn lock_down_cache_permissions(path: &Path) -> Result<(), String> {
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|error| error.to_string())?;
    for suffix in ["-wal", "-shm"] {
        let mut value = path.as_os_str().to_os_string();
        value.push(suffix);
        let auxiliary = PathBuf::from(value);
        if auxiliary.is_file() {
            fs::set_permissions(auxiliary, fs::Permissions::from_mode(0o600))
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

#[cfg(not(unix))]
fn lock_down_cache_permissions(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn migrate_legacy_cache(connection: &Connection, legacy_path: &Path) {
    let count = connection
        .query_row("select count(*) from sessions", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap_or(1);
    if count > 0 || !legacy_path.is_file() {
        return;
    }
    let Ok(file) = fs::File::open(legacy_path) else {
        return;
    };
    for line in BufReader::new(file).lines().skip(1).filter_map(Result::ok) {
        let Ok(record) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let Some(path) = record
            .get("file_path")
            .and_then(Value::as_str)
            .map(PathBuf::from)
        else {
            continue;
        };
        let Some(kind) = record.get("source_kind").and_then(Value::as_str) else {
            continue;
        };
        let Some(summary) = record.get("summary") else {
            continue;
        };
        let search_text = record
            .get("index_text")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let Ok(metadata) = fs::metadata(&path) else {
            continue;
        };
        if record.get("size").and_then(Value::as_u64) != Some(metadata.len())
            || record.get("mtime_ms").and_then(Value::as_i64) != modified_millis(&metadata)
        {
            continue;
        }
        let Some((size, modified)) = fingerprint(&metadata) else {
            continue;
        };
        let Ok(summary_json) = serde_json::to_string(summary) else {
            continue;
        };
        let _ = connection.execute(
            "insert or replace into sessions(path, kind, size, modified_ns, summary_json, search_text) values(?1, ?2, ?3, ?4, ?5, ?6)",
            params![path.to_string_lossy(), kind, size, modified, summary_json, search_text],
        );
    }
}

fn modified_millis(metadata: &fs::Metadata) -> Option<i64> {
    let modified = metadata
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis();
    i64::try_from(modified).ok()
}

fn fingerprint(metadata: &fs::Metadata) -> Option<(i64, i64)> {
    let size = i64::try_from(metadata.len()).ok()?;
    let modified = metadata
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_nanos();
    Some((size, i64::try_from(modified).unwrap_or(i64::MAX)))
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use rusqlite::Connection;
    use serde_json::json;
    use tempfile::tempdir;

    use super::{modified_millis, open_database, CACHE_VERSION};

    #[test]
    fn clears_stale_cache_when_parser_version_changes() {
        let directory = tempdir().unwrap();
        let db_path = directory.path().join("session-index.sqlite");
        {
            let connection = Connection::open(&db_path).unwrap();
            connection
                .execute_batch(
                    "create table sessions(
                       path text primary key,
                       kind text not null,
                       size integer not null,
                       modified_ns integer not null,
                       summary_json text not null,
                       search_text text not null
                     );
                     insert into sessions values('/old', 'codex', 1, 1, '{}', '');",
                )
                .unwrap();
        }
        let connection = open_database(&db_path).unwrap();
        let count: i64 = connection
            .query_row("select count(*) from sessions", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
        let version: i32 = connection
            .query_row("pragma user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, CACHE_VERSION);

        // 版本一致时再次打开不会清空
        connection
            .execute(
                "insert into sessions values('/new', 'codex', 1, 1, '{}', '')",
                [],
            )
            .unwrap();
        drop(connection);
        let reopened = open_database(&db_path).unwrap();
        let count: i64 = reopened
            .query_row("select count(*) from sessions", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn rejects_legacy_index_with_stale_mtime() {
        let directory = tempdir().unwrap();
        let source_path = directory.path().join("session.jsonl");
        std::fs::write(&source_path, "{}\n").unwrap();
        let metadata = std::fs::metadata(&source_path).unwrap();
        let legacy_path = directory.path().join("session-index.json");
        let mut legacy = std::fs::File::create(&legacy_path).unwrap();
        writeln!(legacy, "{{\"version\":7}}").unwrap();
        writeln!(legacy, "{}", json!({ "file_path": source_path, "source_kind": "codex", "size": metadata.len(), "mtime_ms": 0, "summary": { "id": "stale" }, "index_text": "stale" })).unwrap();
        let connection = open_database(&directory.path().join("session-index.sqlite")).unwrap();
        let count: i64 = connection
            .query_row("select count(*) from sessions", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn imports_the_previous_json_index_once() {
        let directory = tempdir().unwrap();
        let source_path = directory.path().join("session.jsonl");
        std::fs::write(&source_path, "{}\n").unwrap();
        let metadata = std::fs::metadata(&source_path).unwrap();
        let db_path = directory.path().join("session-index.sqlite");
        // 先以当前版本建立缓存库，旧 JSON 索引之后才出现时才会被搬入；
        // 版本不匹配的库不会导入旧索引，避免清空后被旧解析器的摘要回填。
        drop(open_database(&db_path).unwrap());
        let legacy_path = directory.path().join("session-index.json");
        let mut legacy = std::fs::File::create(&legacy_path).unwrap();
        writeln!(legacy, "{{\"version\":7}}").unwrap();
        writeln!(legacy, "{}", json!({ "file_path": source_path, "source_kind": "codex", "size": metadata.len(), "mtime_ms": modified_millis(&metadata).unwrap(), "summary": { "id": "one" }, "index_text": "searchable" })).unwrap();
        let connection = open_database(&db_path).unwrap();
        let count: i64 = connection
            .query_row("select count(*) from sessions", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }
}
