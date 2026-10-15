use std::{
    collections::BTreeSet,
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    sync::Arc,
    time::UNIX_EPOCH,
};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

/// 摘要缓存格式版本。当 parse_summary 的字段、隐藏规则或消息解析逻辑发生变化时
/// 必须递增：版本不匹配的旧缓存会在打开时被整体清空，避免历史文件复用过期摘要。
/// 版本 4 同时清除此前可能因读取失败而写入的不完整整源缓存。
const CACHE_VERSION: i32 = 4;

pub struct IndexCache {
    /// Arc 共享的全文索引：搜索在会话锁之外克隆句柄执行查询。
    pub search: Arc<crate::search::SearchIndex>,
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
            search: Arc::new(crate::search::SearchIndex::open(None).unwrap()),
            connection: None,
            path: None,
        }
    }

    #[cfg(test)]
    pub fn open_at(path: &Path) -> Self {
        match open_database(path) {
            Ok(connection) => Self {
                search: Arc::new(crate::search::SearchIndex::open(Some(path)).unwrap()),
                connection: Some(connection),
                path: Some(path.to_path_buf()),
            },
            Err(error) => {
                eprintln!("打开测试缓存失败：{error}");
                Self {
                    search: Arc::new(crate::search::SearchIndex::open(None).unwrap()),
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
                search: Arc::new(crate::search::SearchIndex::open(None)?),
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
        let search = Arc::new(crate::search::SearchIndex::open(path.as_deref())?);
        Ok(Self {
            connection,
            path,
            search,
        })
    }

    pub fn clear(&self) {
        if let Err(error) = self.search.prune(&BTreeSet::new()) {
            eprintln!("清空搜索索引失败：{error}");
        }
        if let Some(connection) = &self.connection {
            if let Err(error) = connection.execute("delete from sessions", []) {
                eprintln!("清空会话索引缓存失败：{error}");
            }
            // 整源缓存一并清空：清缓存通常是想强制重建，留着会继续命中。
            if let Err(error) = connection.execute("delete from source_cache_v1", []) {
                eprintln!("清空来源缓存失败：{error}");
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
        let (size, modified) = fingerprint(metadata)?;
        self.get_stamped(path, kind, &(size, modified))
    }

    pub fn get_stamped(
        &self,
        path: &Path,
        kind: &str,
        stamp: &(i64, i64),
    ) -> Option<CachedSummary> {
        let connection = self.connection.as_ref()?;
        let value = match connection.query_row(
            "select summary_json, search_text from sessions where path = ?1 and kind = ?2 and size = ?3 and modified_ns = ?4",
            params![path.to_string_lossy(), kind, stamp.0, stamp.1],
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
        let Some((size, modified)) = fingerprint(metadata) else {
            return;
        };
        self.put_stamped(path, kind, &(size, modified), summary, search_text);
    }

    /// 按显式指纹写入。命中未变的条目重复写入只会推高 WAL，调用方
    /// 应仅在缓存未命中或内容变化时调用。
    pub fn put_stamped(
        &self,
        path: &Path,
        kind: &str,
        stamp: &(i64, i64),
        summary: &Value,
        search_text: &str,
    ) {
        let Some(connection) = &self.connection else {
            return;
        };
        let Ok(summary_json) = serde_json::to_string(summary) else {
            return;
        };
        if let Err(error) = connection.execute(
            "insert into sessions(path, kind, size, modified_ns, summary_json, search_text) values(?1, ?2, ?3, ?4, ?5, ?6)
             on conflict(path) do update set kind=excluded.kind, size=excluded.size, modified_ns=excluded.modified_ns, summary_json=excluded.summary_json, search_text=excluded.search_text",
            params![path.to_string_lossy(), kind, stamp.0, stamp.1, summary_json, search_text],
        ) { eprintln!("写入会话索引缓存失败：{error}"); }
    }

    /// 截断 WAL。写入只发生在指纹变化后，WAL 仍会随会话编辑缓慢增长；
    /// 在扫描收尾时主动 checkpoint，避免下次启动背着数 GB 的 WAL 打开。
    pub fn checkpoint(&self) {
        let Some(connection) = &self.connection else {
            return;
        };
        if let Err(error) = connection.execute_batch("pragma wal_checkpoint(truncate)") {
            eprintln!("压缩索引缓存 WAL 失败：{error}");
        }
    }

    /// 装载全部缓存行，用于热启动：窗口出现即可展示上次扫描的会话列表，
    /// 后台扫描完成后再整体替换。无法解析的行直接跳过。
    pub fn load_cached_rows(&self) -> Vec<(String, String, Value, String)> {
        let Some(connection) = &self.connection else {
            return Vec::new();
        };
        let Ok(mut statement) =
            connection.prepare("select kind, path, summary_json, search_text from sessions")
        else {
            return Vec::new();
        };
        let Ok(rows) = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        }) else {
            return Vec::new();
        };
        rows.filter_map(Result::ok)
            .filter_map(|(kind, path, summary_json, search_text)| {
                Some((
                    kind,
                    path,
                    serde_json::from_str(&summary_json).ok()?,
                    search_text,
                ))
            })
            .collect()
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

    /// DB 型来源（OpenCode/Cursor/Devin 等）不走逐文件摘要缓存，整个
    /// 来源的解析结果以一个 blob 存储：指纹未变时直接反序列化，跳过
    /// 全库重读。stamp 由各解析模块按其读取的全部文件计算。
    pub fn get_source(&self, kind: &str, path: &Path, stamp: &str) -> Option<Value> {
        let connection = self.connection.as_ref()?;
        let value = match connection
            .query_row(
                "select payload from source_cache_v1 where kind = ?1 and path = ?2 and stamp = ?3",
                params![kind, path.to_string_lossy(), stamp],
                |row| row.get::<_, String>(0),
            )
            .optional()
        {
            Ok(value) => value?,
            Err(error) => {
                eprintln!("读取来源缓存失败：{error}");
                return None;
            }
        };
        serde_json::from_str(&value).ok()
    }

    pub fn put_source(&self, kind: &str, path: &Path, stamp: &str, payload: &Value) {
        let Some(connection) = &self.connection else {
            return;
        };
        let Ok(payload_json) = serde_json::to_string(payload) else {
            return;
        };
        if let Err(error) = connection.execute(
            "insert into source_cache_v1(kind, path, stamp, payload) values(?1, ?2, ?3, ?4)
             on conflict(kind, path) do update set stamp=excluded.stamp, payload=excluded.payload",
            params![kind, path.to_string_lossy(), stamp, payload_json],
        ) {
            eprintln!("写入来源缓存失败：{error}");
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

    /// 清理不再活跃的整源缓存。来源根目录被重定向或对应工具卸载后，
    /// 旧 blob（整个来源的全量会话负载）没有其他失效路径，靠这里回收。
    pub fn prune_sources(&self, active: &BTreeSet<(String, String)>) {
        let Some(connection) = &self.connection else {
            return;
        };
        let Ok(mut statement) =
            connection.prepare("select kind, path from source_cache_v1")
        else {
            return;
        };
        let Ok(rows) = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        }) else {
            return;
        };
        let stale = rows
            .filter_map(Result::ok)
            .filter(|key| !active.contains(key))
            .collect::<Vec<_>>();
        drop(statement);
        for (kind, path) in stale {
            let _ = connection.execute(
                "delete from source_cache_v1 where kind = ?1 and path = ?2",
                [kind, path],
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
             pragma journal_size_limit = 52428800;
             create table if not exists sessions(
               path text primary key,
               kind text not null,
               size integer not null,
               modified_ns integer not null,
               summary_json text not null,
               search_text text not null
             );
             create table if not exists source_cache_v1(
               kind text not null,
               path text not null,
               stamp text not null,
               payload text not null,
               primary key(kind, path)
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
        // 整源缓存的负载同样由解析器产出，摘要规则变化后必须一并丢弃，
        // 否则 DB 型来源会继续命中旧解析结果。
        connection
            .execute("delete from source_cache_v1", [])
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
    use std::collections::BTreeSet;
    use std::io::Write;

    use rusqlite::Connection;
    use serde_json::json;
    use tempfile::tempdir;

    use super::{modified_millis, open_database, IndexCache, CACHE_VERSION};

    #[test]
    fn source_blob_roundtrip_and_invalidation() {
        let directory = tempdir().unwrap();
        let cache_path = directory.path().join("cache.sqlite");
        drop(open_database(&cache_path).unwrap());
        let cache = IndexCache::open_at(&cache_path);
        let database = directory.path().join("opencode.db");
        std::fs::write(&database, "x").unwrap();

        assert!(cache.get_source("opencode", &database, "s1").is_none());
        cache.put_source("opencode", &database, "s1", &json!({"a": 1}));
        assert_eq!(
            cache.get_source("opencode", &database, "s1"),
            Some(json!({"a": 1}))
        );
        // 指纹不同或来源不同都视为未命中。
        assert!(cache.get_source("opencode", &database, "s2").is_none());
        assert!(cache.get_source("kilo", &database, "s1").is_none());

        cache.put_source("opencode", &database, "s2", &json!({"a": 2}));
        assert_eq!(
            cache.get_source("opencode", &database, "s2"),
            Some(json!({"a": 2}))
        );
        assert!(cache.get_source("opencode", &database, "s1").is_none());
    }

    #[test]
    fn prune_sources_removes_rows_of_unconfigured_roots() {
        let directory = tempdir().unwrap();
        let cache_path = directory.path().join("cache.sqlite");
        drop(open_database(&cache_path).unwrap());
        let cache = IndexCache::open_at(&cache_path);
        let keep = directory.path().join("opencode.db");
        let stale = directory.path().join("moved").join("opencode.db");
        std::fs::write(&keep, "x").unwrap();
        std::fs::create_dir_all(stale.parent().unwrap()).unwrap();
        std::fs::write(&stale, "y").unwrap();
        cache.put_source("opencode", &keep, "s", &json!({"keep": true}));
        cache.put_source("opencode", &stale, "s", &json!({"keep": false}));

        let mut active = BTreeSet::new();
        active.insert(("opencode".to_string(), keep.to_string_lossy().into_owned()));
        cache.prune_sources(&active);

        assert!(cache.get_source("opencode", &keep, "s").is_some());
        assert!(cache.get_source("opencode", &stale, "s").is_none());
    }

    #[test]
    fn stamped_summary_roundtrip() {
        let directory = tempdir().unwrap();
        let cache_path = directory.path().join("cache.sqlite");
        drop(open_database(&cache_path).unwrap());
        let cache = IndexCache::open_at(&cache_path);
        let file = directory.path().join("wire.jsonl");
        std::fs::write(&file, "x").unwrap();

        assert!(cache.get_stamped(&file, "kimi", &(1, 1)).is_none());
        cache.put_stamped(&file, "kimi", &(1, 1), &json!({"id": "k"}), "text");
        let cached = cache
            .get_stamped(&file, "kimi", &(1, 1))
            .expect("复合指纹一致应命中");
        assert_eq!(cached.summary, json!({"id": "k"}));
        assert_eq!(cached.search_text, "text");
        assert!(cache.get_stamped(&file, "kimi", &(2, 1)).is_none());
    }

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
                     insert into sessions values('/old', 'codex', 1, 1, '{}', '');
                     create table source_cache_v1(
                       kind text not null,
                       path text not null,
                       stamp text not null,
                       payload text not null,
                       primary key(kind, path)
                     );
                     insert into source_cache_v1 values('hermes', '/old', 'stamp', '{}');",
                )
                .unwrap();
        }
        let connection = open_database(&db_path).unwrap();
        let count: i64 = connection
            .query_row("select count(*) from sessions", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
        let source_count: i64 = connection
            .query_row("select count(*) from source_cache_v1", [], |row| row.get(0))
            .unwrap();
        assert_eq!(source_count, 0);
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
