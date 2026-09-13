use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
    sync::{Mutex, MutexGuard},
};

/// 连接包一层内部互斥锁后可以放进 Arc 跨线程共享：
/// 搜索请求在会话锁之外拿 Arc 执行耗时的全文查询，
/// 与会话锁内的索引构建互不阻塞。
pub struct SearchIndex(Mutex<Connection>);

pub struct SearchSnapshot<'a>(&'a Connection);

struct Candidate {
    ordinal: i64,
    field: String,
    message_key: String,
    score: f64,
    id: i64,
}

#[derive(Debug)]
pub enum RefreshError {
    Source(String),
    Database(String),
}

impl SearchIndex {
    pub fn read_snapshot<T>(
        &self,
        read: impl FnOnce(&SearchSnapshot<'_>) -> Result<T, String>,
    ) -> Result<T, String> {
        let db = self.lock()?;
        let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
        let result = read(&SearchSnapshot(&tx))?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(result)
    }
    fn lock(&self) -> Result<MutexGuard<'_, Connection>, String> {
        self.0.lock().map_err(|_| "搜索索引状态已损坏".to_string())
    }

    pub fn open(path: Option<&Path>) -> Result<Self, String> {
        let db = match path {
            Some(path) => Connection::open(path),
            None => Connection::open_in_memory(),
        }
        .map_err(|e| e.to_string())?;
        db.execute_batch("create table if not exists search_sessions_v1(key text primary key, fingerprint text not null);
            create table if not exists search_messages_v1(id integer primary key, session_key text not null, ordinal integer not null, text text not null, payload text not null);
            create index if not exists search_messages_session_v1 on search_messages_v1(session_key, ordinal);
            create virtual table if not exists search_fts_v1 using fts5(text, content='search_messages_v1', content_rowid='id', tokenize='trigram');
            drop trigger if exists search_insert_v1;
            create trigger if not exists search_delete_v1 after delete on search_messages_v1 begin insert into search_fts_v1(search_fts_v1,rowid,text) values('delete',old.id,old.text); end;").map_err(|e| e.to_string())?;
        let has_metadata: bool = db.query_row("select exists(select 1 from pragma_table_info('search_messages_v1') where name='role')", [], |r| r.get(0)).map_err(|e|e.to_string())?;
        if !has_metadata {
            // 派生索引升级后重建，不迁移整份消息正文。
            db.execute_batch("begin; alter table search_messages_v1 add column role text not null default 'assistant'; alter table search_messages_v1 add column message_key text not null default ''; delete from search_messages_v1; delete from search_sessions_v1; commit;").map_err(|e|e.to_string())?;
        }
        db.execute_batch("create table if not exists search_short_v1(token text not null, message_id integer not null, primary key(token,message_id)) without rowid;
            create index if not exists search_short_message_v1 on search_short_v1(message_id);
            create table if not exists search_short_ready_v1(session_key text primary key);
            create trigger if not exists search_short_delete_v1 after delete on search_messages_v1 begin delete from search_short_v1 where message_id=old.id; delete from search_short_ready_v1 where session_key=old.session_key; end;
            create trigger if not exists search_short_session_delete_v1 after delete on search_sessions_v1 begin delete from search_short_ready_v1 where session_key=old.key; end;").map_err(|e| e.to_string())?;
        Ok(Self(Mutex::new(db)))
    }

    pub fn refresh(
        &self,
        key: &str,
        fingerprint: &str,
        parse: impl FnOnce(&mut dyn FnMut(&Value)) -> Result<(), String>,
    ) -> Result<(), RefreshError> {
        let db = self.lock().map_err(RefreshError::Database)?;
        let old: Option<String> = db
            .query_row(
                "select fingerprint from search_sessions_v1 where key=?1",
                [key],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| RefreshError::Database(e.to_string()))?;
        if old.as_deref() == Some(fingerprint) {
            // 旧缓存直接补齐短词索引，不再次解析来源文件。
            let tx = db
                .unchecked_transaction()
                .map_err(|e| RefreshError::Database(e.to_string()))?;
            backfill_short(&tx, key).map_err(RefreshError::Database)?;
            tx.commit()
                .map_err(|e| RefreshError::Database(e.to_string()))?;
            return Ok(());
        }
        let tx = db
            .unchecked_transaction()
            .map_err(|e| RefreshError::Database(e.to_string()))?;
        tx.execute(
            "delete from search_short_ready_v1 where session_key=?1",
            [key],
        )
        .map_err(|e| RefreshError::Database(e.to_string()))?;
        tx.execute("delete from search_messages_v1 where session_key=?1", [key])
            .map_err(|e| RefreshError::Database(e.to_string()))?;
        let mut ordinal = 0;
        let mut failure = None;
        let mut insert = tx.prepare("insert into search_messages_v1(session_key,ordinal,text,payload,role,message_key) values(?1,?2,?3,?4,?5,?6)").map_err(|e|RefreshError::Database(e.to_string()))?;
        let parsed = parse(&mut |message| {
            if failure.is_some() {
                return;
            }
            let text = message["text"].as_str().unwrap_or_default();
            let mut payload = message.clone();
            payload.as_object_mut().map(|o| o.remove("_delete_ref"));
            if message["synthetic_context"] != true && !text.is_empty() {
                if let Err(error) = insert.execute(params![
                    key,
                    ordinal,
                    text.to_lowercase(),
                    payload.to_string(),
                    message["role"].as_str().unwrap_or("assistant"),
                    message["_message_key"].as_str().unwrap_or_default()
                ]) {
                    failure = Some(error.to_string());
                }
            }
            ordinal += 1;
        });
        drop(insert);
        if let Some(error) = failure {
            return Err(RefreshError::Database(error));
        }
        parsed.map_err(RefreshError::Source)?;
        // 一条批量语句写入全文索引，避免每条消息触发 FTS 保存点和刷盘。
        tx.execute("insert into search_fts_v1(rowid,text) select id,text from search_messages_v1 where session_key=?1",[key]).map_err(|e|RefreshError::Database(e.to_string()))?;
        tx.execute("insert into search_sessions_v1 values(?1,?2) on conflict(key) do update set fingerprint=excluded.fingerprint", params![key,fingerprint]).map_err(|e| RefreshError::Database(e.to_string()))?;
        backfill_short(&tx, key).map_err(RefreshError::Database)?;
        tx.commit()
            .map_err(|e| RefreshError::Database(e.to_string()))
    }

    pub fn invalidate(&self, key: &str) -> Result<(), String> {
        let db = self.lock()?;
        let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
        tx.execute("delete from search_messages_v1 where session_key=?1", [key])
            .map_err(|e| e.to_string())?;
        tx.execute("delete from search_sessions_v1 where key=?1", [key])
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }

    pub fn prune(&self, active: &BTreeSet<String>) -> Result<(), String> {
        let db = self.lock()?;
        let mut stmt = db
            .prepare("select key from search_sessions_v1")
            .map_err(|e| e.to_string())?;
        let keys = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        drop(stmt);
        let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
        for key in keys.into_iter().filter(|key| !active.contains(key)) {
            tx.execute(
                "delete from search_messages_v1 where session_key=?1",
                [&key],
            )
            .map_err(|e| e.to_string())?;
            tx.execute("delete from search_sessions_v1 where key=?1", [&key])
                .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())
    }

    #[cfg(test)]
    fn hits(&self, query: &str) -> Result<BTreeMap<String, Vec<Value>>, String> {
        self.query_hits(query, |_, _| true)
    }

    #[cfg(test)]
    fn query_hits(
        &self,
        query: &str,
        include: impl Fn(&str, &str) -> bool,
    ) -> Result<BTreeMap<String, Vec<Value>>, String> {
        self.read_snapshot(|snapshot| snapshot.query_hits(query, include))
    }

    #[cfg(test)]
    fn hydrate_hit(&self, hit: &mut Value) -> Result<(), String> {
        self.read_snapshot(|snapshot| snapshot.hydrate_hit(hit))
    }
}

fn is_han(ch: char) -> bool {
    matches!(ch as u32, 0x3400..=0x4dbf | 0x4e00..=0x9fff | 0xf900..=0xfaff | 0x20000..=0x2ffff | 0x30000..=0x323af)
}

fn short_tokens(text: &str) -> BTreeSet<String> {
    let mut tokens = BTreeSet::new();
    let mut previous = None;
    for ch in text.chars() {
        if is_han(ch) {
            tokens.insert(ch.to_string());
            if let Some(before) = previous {
                tokens.insert(format!("{before}{ch}"));
            }
            previous = Some(ch);
        } else {
            previous = None;
        }
    }
    tokens
}

fn backfill_short(db: &Connection, key: &str) -> Result<(), String> {
    let ready: bool = db
        .query_row(
            "select exists(select 1 from search_short_ready_v1 where session_key=?1)",
            [key],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if ready {
        return Ok(());
    }
    let mut read = db
        .prepare("select id,text from search_messages_v1 where session_key=?1")
        .map_err(|e| e.to_string())?;
    let mut insert = db
        .prepare("insert or ignore into search_short_v1(token,message_id) values(?1,?2)")
        .map_err(|e| e.to_string())?;
    let mut rows = read.query([key]).map_err(|e| e.to_string())?;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let id: i64 = row.get(0).map_err(|e| e.to_string())?;
        let text: String = row.get(1).map_err(|e| e.to_string())?;
        for token in short_tokens(&text) {
            insert
                .execute(params![token, id])
                .map_err(|e| e.to_string())?;
        }
    }
    db.execute("insert into search_short_ready_v1 values(?1)", [key])
        .map_err(|e| e.to_string())?;
    Ok(())
}

impl SearchSnapshot<'_> {
    pub fn query_hits(
        &self,
        query: &str,
        include: impl Fn(&str, &str) -> bool,
    ) -> Result<BTreeMap<String, Vec<Value>>, String> {
        let db = self.0;
        let mut hits: BTreeMap<String, Vec<Value>> = BTreeMap::new();
        for term in terms(query) {
            let mut candidates: BTreeMap<String, Vec<Candidate>> = BTreeMap::new();
            let indexed = term.chars().count() >= 3;
            let short_indexed = !indexed && term.chars().all(is_han);
            let sql = if indexed {
                "select m.session_key,m.ordinal,m.role,m.message_key,-bm25(search_fts_v1),m.id from search_fts_v1 join search_messages_v1 m on m.id=search_fts_v1.rowid where search_fts_v1 match ?1"
            } else if short_indexed {
                // 未补齐的会话仍查正文；已补齐的只查倒排表，同一快照内不会漏读。
                "select session_key,ordinal,role,message_key,0.0,id from search_messages_v1 where id in (select message_id from search_short_v1 where token=?1) union all select m.session_key,m.ordinal,m.role,m.message_key,0.0,m.id from search_messages_v1 m where m.session_key in (select key from search_sessions_v1 where key not in (select session_key from search_short_ready_v1)) and instr(m.text,?1)>0 order by id"
            } else {
                "select session_key,ordinal,role,message_key,0.0,id from search_messages_v1 where instr(text,?1)>0"
            };
            let parameter = if indexed {
                format!("\"{}\"", term.replace('"', "\"\""))
            } else {
                term.clone()
            };
            let mut stmt = db.prepare_cached(sql).map_err(|e| e.to_string())?;
            let mut rows = stmt.query([parameter]).map_err(|e| e.to_string())?;
            while let Some(row) = rows.next().map_err(|e| e.to_string())? {
                let key = row
                    .get_ref(0)
                    .map_err(|e| e.to_string())?
                    .as_str()
                    .map_err(|e| e.to_string())?;
                let field = row
                    .get_ref(2)
                    .map_err(|e| e.to_string())?
                    .as_str()
                    .map_err(|e| e.to_string())?;
                let message_key = row
                    .get_ref(3)
                    .map_err(|e| e.to_string())?
                    .as_str()
                    .map_err(|e| e.to_string())?;
                if !include(key, message_key) {
                    continue;
                }
                let score: f64 = row.get(4).map_err(|e| e.to_string())?;
                let score = score
                    + if field == "user" {
                        2.0
                    } else if field == "tool" {
                        0.0
                    } else {
                        1.0
                    };
                // 大多数高频命中会被丢弃；筛选通过前借用 SQLite 字段，避免逐行分配。
                if candidates
                    .get(key)
                    .is_some_and(|best| best.len() == 2 && best[1].score >= score)
                {
                    continue;
                }
                let best = candidates.entry(key.to_owned()).or_default();
                best.push(Candidate {
                    ordinal: row.get(1).map_err(|e| e.to_string())?,
                    field: field.to_owned(),
                    message_key: message_key.to_owned(),
                    score,
                    id: row.get(5).map_err(|e| e.to_string())?,
                });
                best.sort_by(|a, b| b.score.total_cmp(&a.score));
                best.truncate(2);
            }
            for (key, best) in candidates {
                hits.entry(key).or_default().extend(best.into_iter().map(|hit| {
                    json!({"field":hit.field,"ordinal":hit.ordinal,"message_key":hit.message_key,"term":term,"score":hit.score,"_rowid":hit.id})
                }));
            }
        }
        Ok(hits)
    }

    pub fn hydrate_hit(&self, hit: &mut Value) -> Result<(), String> {
        let Some(id) = hit.get("_rowid").and_then(Value::as_i64) else {
            return Ok(());
        };
        let db = self.0;
        let payload: String = db
            .query_row(
                "select payload from search_messages_v1 where id=?1",
                [id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        let message: Value = serde_json::from_str(&payload).map_err(|e| e.to_string())?;
        hit["snippet"] = json!(snippet(
            message["text"].as_str().unwrap_or_default(),
            hit["term"].as_str().unwrap_or_default()
        ));
        hit.as_object_mut().unwrap().remove("_rowid");
        Ok(())
    }
}

impl SearchIndex {
    pub fn context(&self, key: &str, ordinal: i64, query: &str) -> Result<Vec<Value>, String> {
        let db = self.lock()?;
        let mut stmt = db.prepare("select payload,ordinal from search_messages_v1 where session_key=?1 and ordinal between ?2 and ?3 order by ordinal").map_err(|e|e.to_string())?;
        let rows = stmt
            .query_map(
                params![key, ordinal.saturating_sub(2), ordinal.saturating_add(2)],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )
            .map_err(|e| e.to_string())?;
        rows.map(|row| {
            let (payload, index) = row.map_err(|e| e.to_string())?;
            let mut value: Value = serde_json::from_str(&payload).map_err(|e| e.to_string())?;
            value["search_ordinal"] = json!(index);
            if let Some(text) = value["text"].as_str() {
                if text.chars().count() > 64_000 {
                    value["text"] = json!(text_window(text, query, 64_000));
                    value["text_truncated"] = json!(true);
                }
            }
            Ok(value)
        })
        .collect()
    }
}

pub fn terms(query: &str) -> BTreeSet<String> {
    query
        .to_lowercase()
        .split_whitespace()
        .map(str::to_owned)
        .collect()
}

pub fn snippet(text: &str, query: &str) -> String {
    text_window(text, query, 180)
}

fn text_window(text: &str, query: &str, limit: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    let needle = query.to_lowercase();
    let mut lowered = String::new();
    let mut original = Vec::new();
    for (index, ch) in chars.iter().enumerate() {
        for lower in ch.to_lowercase() {
            let start = lowered.len();
            lowered.push(lower);
            original.resize(lowered.len(), index);
            debug_assert!(lowered.len() > start);
        }
    }
    let offset = lowered.find(&needle).map(|i| original[i]).unwrap_or(0);
    let start = offset.saturating_sub(45);
    let end = (start + limit).min(chars.len());
    format!(
        "{}{}{}",
        if start > 0 { "…" } else { "" },
        chars[start..end].iter().collect::<String>(),
        if end < chars.len() { "…" } else { "" }
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 短词补齐前后结果一致且缓存命中不重解析() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("short.sqlite");
        let index = SearchIndex::open(Some(&path)).unwrap();
        for key in ["a", "b", "empty"] {
            index
                .refresh(key, "1", |visit| {
                    if key != "empty" {
                        for text in ["修复修复搜索", "修 复", "𠮷修复", "error 修复"]
                        {
                            visit(&json!({"text":text,"role":"user"}));
                        }
                    }
                    Ok(())
                })
                .unwrap();
        }
        let expected = index.hits("修复 修 𠮷").unwrap();
        index
            .lock()
            .unwrap()
            .execute_batch("delete from search_short_v1; delete from search_short_ready_v1;")
            .unwrap();
        assert_eq!(expected, index.hits("修复 修 𠮷").unwrap());
        index.refresh("a", "1", |_| panic!("不得重解析")).unwrap();
        assert_eq!(expected, index.hits("修复 修 𠮷").unwrap());
        index.refresh("b", "1", |_| panic!("不得重解析")).unwrap();
        assert_eq!(expected, index.hits("修复 修 𠮷").unwrap());
        assert!(index
            .refresh("a", "broken", |v| {
                v(&json!({"text":"不应保存"}));
                Err("模拟解析失败".into())
            })
            .is_err());
        assert_eq!(expected, index.hits("修复 修 𠮷").unwrap());
        drop(index);
        let index = SearchIndex::open(Some(&path)).unwrap();
        assert_eq!(expected, index.hits("修复 修 𠮷").unwrap());
        index
            .refresh("empty", "2", |v| {
                v(&json!({"text":"新增"}));
                Ok(())
            })
            .unwrap();
        assert!(index.hits("新增").unwrap().contains_key("empty"));
        index.invalidate("a").unwrap();
        assert!(!index.hits("修复").unwrap().contains_key("a"));
        index.prune(&BTreeSet::new()).unwrap();
        assert!(index.hits("修复").unwrap().is_empty());
        assert_eq!(
            index
                .lock()
                .unwrap()
                .query_row("select count(*) from search_short_v1", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn 短词按相邻汉字去重不跨标点() {
        let tokens = short_tokens("修复修复，搜 索");
        assert!(tokens.contains("修复"));
        assert!(!tokens.contains("搜索"));
        assert!(!tokens.contains("复搜"));
        assert_eq!(tokens.len(), 6);
    }

    #[test]
    #[ignore = "真实数据样本复制到临时库，测量短词索引"]
    fn 短词真实样本对照() {
        let path = std::env::var("ALLSESSIONS_BENCH_INDEX").unwrap();
        let source =
            Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let directory = tempfile::tempdir().unwrap();
        let index = SearchIndex::open(Some(&directory.path().join("sample.sqlite"))).unwrap();
        {
            let db = index.lock().unwrap();
            let tx = db.unchecked_transaction().unwrap();
            let mut stmt = source.prepare("select id,session_key,ordinal,text,role,message_key from search_messages_v1 order by id limit 10000").unwrap();
            let mut rows = stmt.query([]).unwrap();
            let mut insert = tx.prepare("insert into search_messages_v1(id,session_key,ordinal,text,payload,role,message_key) values(?1,?2,?3,?4,'{}',?5,?6)").unwrap();
            while let Some(row) = rows.next().unwrap() {
                insert
                    .execute(params![
                        row.get::<_, i64>(0).unwrap(),
                        row.get::<_, String>(1).unwrap(),
                        row.get::<_, i64>(2).unwrap(),
                        row.get::<_, String>(3).unwrap(),
                        row.get::<_, String>(4).unwrap(),
                        row.get::<_, String>(5).unwrap()
                    ])
                    .unwrap();
            }
            drop(insert);
            tx.execute("insert into search_sessions_v1 select distinct session_key,'1' from search_messages_v1", []).unwrap();
            tx.commit().unwrap();
        }
        let mut expected = Vec::new();
        for term in ["修复", "的"] {
            for _ in 0..3 {
                let start = std::time::Instant::now();
                let hits = index.hits(term).unwrap();
                eprintln!("补齐前 {term}：{:?}", start.elapsed());
                if expected.len() < 2 && !expected.iter().any(|(t, _)| *t == term) {
                    expected.push((term, hits));
                }
            }
        }
        let before = std::fs::metadata(directory.path().join("sample.sqlite"))
            .unwrap()
            .len();
        let start = std::time::Instant::now();
        {
            let db = index.lock().unwrap();
            let keys = db
                .prepare("select key from search_sessions_v1")
                .unwrap()
                .query_map([], |r| r.get::<_, String>(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            for key in keys {
                let tx = db.unchecked_transaction().unwrap();
                backfill_short(&tx, &key).unwrap();
                tx.commit().unwrap();
            }
        }
        let after = std::fs::metadata(directory.path().join("sample.sqlite"))
            .unwrap()
            .len();
        eprintln!(
            "补齐耗时 {:?}，新增字节 {}",
            start.elapsed(),
            after - before
        );
        for (term, expected) in expected {
            for _ in 0..3 {
                let start = std::time::Instant::now();
                let hits = index.hits(term).unwrap();
                eprintln!("补齐后 {term}：{:?}", start.elapsed());
                assert_eq!(hits, expected);
            }
        }
    }

    #[test]
    #[ignore = "需指定真实索引路径，只读测量，不修改索引"]
    fn 真实索引只读检索基线() {
        let path =
            std::env::var("ALLSESSIONS_BENCH_INDEX").expect("需指定 ALLSESSIONS_BENCH_INDEX");
        let db =
            Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let index = SearchIndex(Mutex::new(db));
        for term in ["error", "修复", "的", "allsessions", "error 修复"] {
            for run in 1..=3 {
                let started = std::time::Instant::now();
                let hits = index.hits(term).unwrap();
                eprintln!(
                    "检索 {term} 第{run}轮：{}ms，{}个会话",
                    started.elapsed().as_millis(),
                    hits.len()
                );
            }
        }
    }

    #[test]
    #[ignore = "手动性能测量，不以耗时作为通过条件"]
    fn 索引性能基线() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("benchmark.sqlite");
        let index = SearchIndex::open(Some(&path)).unwrap();
        let started = std::time::Instant::now();
        for session in 0..100 {
            index.refresh(&session.to_string(), "1", |visit| {
                for message in 0..100 {
                    visit(&json!({"role":"user", "_message_key":message.to_string(), "text":"error 修复搜索性能 ".repeat(30)}));
                }
                Ok(())
            }).unwrap();
        }
        eprintln!("首次索引（100 会话 / 10000 消息）：{:?}", started.elapsed());
        drop(index);
        let started = std::time::Instant::now();
        let index = SearchIndex::open(Some(&path)).unwrap();
        for session in 0..100 {
            index
                .refresh(&session.to_string(), "1", |_| {
                    panic!("缓存命中不应解析正文")
                })
                .unwrap();
        }
        eprintln!("重开并复用索引：{:?}", started.elapsed());
        let started = std::time::Instant::now();
        index.refresh("0", "2", |visit| {
            for message in 0..101 {
                visit(&json!({"role":"user", "_message_key":message.to_string(), "text":"error 修复搜索性能 ".repeat(30)}));
            }
            Ok(())
        }).unwrap();
        eprintln!("单会话更新：{:?}", started.elapsed());
        for term in ["error", "修复"] {
            let started = std::time::Instant::now();
            assert_eq!(index.hits(term).unwrap().len(), 100);
            eprintln!("查询 {term}：{:?}", started.elapsed());
        }
    }

    #[test]
    fn 后台复用行号时搜索快照仍返回原始片段() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("search.sqlite");
        let reader = SearchIndex::open(Some(&path)).unwrap();
        reader
            .lock()
            .unwrap()
            .execute_batch("pragma journal_mode=wal")
            .unwrap();
        let writer = SearchIndex::open(Some(&path)).unwrap();
        writer
            .refresh("s", "1", |v| {
                v(&json!({"text":"old match","_message_key":"old"}));
                Ok(())
            })
            .unwrap();
        reader
            .read_snapshot(|snapshot| {
                let mut hits = snapshot.query_hits("match", |_, _| true)?;
                writer
                    .refresh("s", "2", |v| {
                        v(&json!({"text":"new content","_message_key":"new"}));
                        Ok(())
                    })
                    .unwrap();
                let hit = &mut hits.get_mut("s").unwrap()[0];
                snapshot.hydrate_hit(hit)?;
                assert_eq!(hit["snippet"], "old match");
                Ok(())
            })
            .unwrap();
        assert!(reader.hits("match").unwrap().is_empty());
        assert_eq!(
            reader.hits("content").unwrap()["s"][0]["message_key"],
            "new"
        );
    }

    #[test]
    fn 高频查询只保留有界候选且不加载正文() {
        let index = SearchIndex::open(None).unwrap();
        index.refresh("s", "1", |visit| {
            for i in 0..2000 {
                visit(&json!({"text":"error 正文".repeat(200),"role":"user","_message_key":format!("m{i}")}));
            }
            Ok(())
        }).unwrap();
        let start = std::time::Instant::now();
        let hits = index.hits("error").unwrap();
        eprintln!("查询耗时：{:?}", start.elapsed());
        assert!(hits["s"].len() <= 2);
        assert!(hits["s"][0].get("snippet").is_none());
    }

    #[test]
    fn 轻量候选保持角色排序同分顺序和删除过滤() {
        let index = SearchIndex::open(None).unwrap();
        index
            .refresh("s", "1", |visit| {
                for (key, role) in [
                    ("tool", "tool"),
                    ("assistant", "assistant"),
                    ("removed", "user"),
                    ("first", "user"),
                    ("second", "user"),
                    ("third", "user"),
                ] {
                    visit(&json!({"text":"修复 error", "role":role, "_message_key":key}));
                }
                Ok(())
            })
            .unwrap();
        for term in ["修复", "error"] {
            let hits = index.query_hits(term, |_, key| key != "removed").unwrap();
            assert_eq!(
                hits["s"]
                    .iter()
                    .map(|hit| hit["message_key"].as_str().unwrap())
                    .collect::<Vec<_>>(),
                vec!["first", "second"]
            );
        }
    }

    #[test]
    fn 候选截取前排除已移除消息且保留每个词() {
        let index = SearchIndex::open(None).unwrap();
        index.refresh("s", "1", |visit| {
            for i in 0..20 {
                visit(&json!({"text":if i==19 {"error 稀有词"}else{"error"},"role":"user","_message_key":format!("m{i}")}));
            }
            Ok(())
        }).unwrap();
        let hits = index
            .query_hits("error 稀有词", |key, message| {
                key == "s" && message == "m19"
            })
            .unwrap();
        assert_eq!(hits["s"].len(), 2);
        assert!(hits["s"].iter().all(|hit| hit["message_key"] == "m19"));
        assert!(index.query_hits("error", |_, _| false).unwrap().is_empty());
    }

    #[test]
    fn 数据库错误不应被归为单会话解析错误() {
        let index = SearchIndex::open(None).unwrap();
        index
            .lock()
            .unwrap()
            .execute_batch("pragma query_only=on")
            .unwrap();
        assert!(matches!(
            index.refresh("s", "1", |_| Ok(())),
            Err(RefreshError::Database(_))
        ));
    }

    #[test]
    fn 旧索引升级清除派生数据后可重建() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("search.sqlite");
        {
            let index = SearchIndex::open(Some(&path)).unwrap();
            index
                .refresh("s", "1", |v| {
                    v(&json!({"text":"old"}));
                    Ok(())
                })
                .unwrap();
            index.lock().unwrap().execute_batch("alter table search_messages_v1 drop column role; alter table search_messages_v1 drop column message_key;").unwrap();
        }
        let index = SearchIndex::open(Some(&path)).unwrap();
        assert!(index.hits("old").unwrap().is_empty());
        index
            .refresh("s", "1", |v| {
                v(&json!({"text":"new"}));
                Ok(())
            })
            .unwrap();
        assert_eq!(index.hits("new").unwrap()["s"].len(), 1);
    }

    #[test]
    fn 超长消息只加载命中附近且索引可重新打开() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("search.sqlite");
        {
            let index = SearchIndex::open(Some(&path)).unwrap();
            index.refresh("s", "1", |visit| {
                visit(&json!({"text":format!("{}target{}", "前".repeat(100_000), "后".repeat(100_000))}));
                Ok(())
            }).unwrap();
        }
        let index = SearchIndex::open(Some(&path)).unwrap();
        assert_eq!(index.hits("target").unwrap()["s"].len(), 1);
        let messages = index.context("s", 0, "target").unwrap();
        let text = messages[0]["text"].as_str().unwrap();
        assert!(text.contains("target"));
        assert!(text.chars().count() <= 64_002);
        assert_eq!(messages[0]["text_truncated"], true);
    }

    #[test]
    fn 中文短词代码和大小写均可检索并定位() {
        let index = SearchIndex::open(None).unwrap();
        index.refresh("session", "1", |visit| {
            for i in 0..1200 {
                visit(&json!({"text":if i==650 {"修复更新 useEffect( HTTP_404".to_string()}else{"普通消息".repeat(50)},"role":"user","_message_key":format!("m{i}")}));
            }
            Ok(())
        }).unwrap();
        for query in ["更新", "修", "useEffect(", "http_404", "修复更新"] {
            let mut hits = index.hits(query).unwrap();
            assert_eq!(hits["session"][0]["ordinal"], 650);
            index
                .hydrate_hit(&mut hits.get_mut("session").unwrap()[0])
                .unwrap();
            assert!(hits["session"][0]["snippet"]
                .as_str()
                .unwrap()
                .contains("HTTP_404"));
        }
        assert_eq!(index.context("session", 650, "更新").unwrap().len(), 5);
        assert!(index.hits("\" OR *").is_ok());
    }

    #[test]
    fn 增量更新回滚和清理不会留下旧命中() {
        let index = SearchIndex::open(None).unwrap();
        index
            .refresh("s", "1", |v| {
                v(&json!({"text":"before","role":"user"}));
                Ok(())
            })
            .unwrap();
        index
            .refresh("s", "1", |_| panic!("指纹未变不应重读来源"))
            .unwrap();
        assert!(index
            .refresh("s", "2", |v| {
                v(&json!({"text":"broken"}));
                Err("解析失败".into())
            })
            .is_err());
        assert!(!index.hits("before").unwrap().is_empty());
        index
            .refresh("s", "2", |v| {
                v(&json!({"text":"after","role":"assistant"}));
                Ok(())
            })
            .unwrap();
        assert!(index.hits("before").unwrap().is_empty());
        assert!(!index.hits("after").unwrap().is_empty());
        index.prune(&BTreeSet::new()).unwrap();
        assert!(index.hits("after").unwrap().is_empty());
    }

    #[test]
    fn 摘要保留原文并处理小写展开字符() {
        let text = format!("{}İ MyComponent HTTP 404 更新", "前文".repeat(60));
        let result = snippet(&text, "mycomponent");
        assert!(result.contains("MyComponent HTTP 404"));
        assert!(result.starts_with('…'));
    }
}
