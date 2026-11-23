use std::fs::OpenOptions;

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;

use rusqlite::{
    OpenFlags, TransactionBehavior,
    backup::{Backup, StepResult},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::*;

const FORMAT: &str = "allsessions-workspace";
const VERSION: u64 = 1;
const MAX_BYTES: usize = 16 * 1024 * 1024;

#[derive(Deserialize, Serialize)]
pub(crate) struct WorkspaceTransfer {
    format: String,
    version: u64,
    exported_at: String,
    sessions: BTreeMap<String, SessionEntry>,
    saved_filters: Vec<SavedFilter>,
}

#[derive(Default, Deserialize, Serialize)]
struct SessionEntry {
    workspace: Option<SessionWorkspace>,
    removed_messages: BTreeSet<String>,
}

impl WorkspaceTransfer {
    pub(crate) fn parse(text: &str) -> Result<Self, String> {
        check_size(text)?;
        let value: Value = serde_json::from_str(text).map_err(|_| "工作台文件不是有效的 JSON")?;
        if value["format"].as_str() != Some(FORMAT) {
            return Err("请选择 AllSessions 导出的工作台文件".into());
        }
        if value["version"].as_u64() != Some(VERSION) {
            return Err("不支持此工作台文件版本".into());
        }
        let transfer: Self = serde_json::from_value(value).map_err(|_| "工作台文件结构无效")?;
        transfer.validate()?;
        Ok(transfer)
    }

    fn validate(&self) -> Result<(), String> {
        for (key, entry) in &self.sessions {
            validate_text(key, "会话标识", MAX_SESSION_KEY_CHARS)?;
            if let Some(workspace) = &entry.workspace {
                validate_length(&workspace.note, "备注", MAX_NOTE_CHARS)?;
                validate_length(&workspace.display_name, "会话名称", MAX_DISPLAY_NAME_CHARS)?;
                if workspace.tags.len() > MAX_TAGS {
                    return Err(format!("每个会话最多设置 {MAX_TAGS} 个标签"));
                }
                for tag in &workspace.tags {
                    validate_text(tag, "标签", MAX_TAG_CHARS)?;
                }
            } else if entry.removed_messages.is_empty() {
                return Err("工作台会话条目为空".into());
            }
            for key in &entry.removed_messages {
                validate_text(key, "消息标识", MAX_MESSAGE_KEY_CHARS)?;
            }
        }
        let mut ids = BTreeSet::new();
        for filter in &self.saved_filters {
            validate_text(&filter.id, "筛选标识", 80)?;
            validate_text(&filter.name, "筛选名称", MAX_FILTER_NAME_CHARS)?;
            if !ids.insert(&filter.id) {
                return Err("工作台文件包含重复的筛选标识".into());
            }
            if !filter.filter.is_object()
                || serde_json::to_string(&filter.filter)
                    .map_err(error_text)?
                    .len()
                    > MAX_FILTER_JSON_BYTES
                || [
                    "provider",
                    "source_kind",
                    "date",
                    "activity_from",
                    "activity_to",
                    "cwd",
                    "tag",
                    "q",
                    "exact_tool",
                    "command",
                ]
                .iter()
                .any(|key| {
                    filter
                        .filter
                        .get(key)
                        .is_some_and(|value| !value.is_string())
                })
            {
                return Err("工作台文件包含无效的筛选条件".into());
            }
            filter
                .updated_at
                .parse::<Timestamp>()
                .map_err(|_| "筛选更新时间无效")?;
        }
        Ok(())
    }

    pub(crate) fn session_keys(&self) -> impl Iterator<Item = &str> {
        self.sessions.keys().map(String::as_str)
    }

    fn plan<'a>(
        &'a self,
        local: &WorkspaceSnapshot,
        target_session: impl Fn(&str) -> Option<String>,
        replacements: &BTreeSet<String>,
    ) -> Result<ImportPlan<'a>, String> {
        let mut plan = ImportPlan::default();
        let mut hash = Sha256::new();
        hash.update(serde_json::to_vec(self).map_err(error_text)?);
        for (key, entry) in &self.sessions {
            let Some(target) = target_session(key) else {
                plan.unmatched.push(key);
                plan.record(Decision::Unmatched, false, &mut hash);
                continue;
            };
            hash.update((target.len() as u64).to_le_bytes());
            hash.update(target.as_bytes());
            let remapped = target != *key;
            if remapped {
                plan.remapped += 1;
                plan.skipped_messages += entry.removed_messages.len();
                if entry.workspace.is_none() {
                    plan.record(Decision::Skipped, false, &mut hash);
                    continue;
                }
            }
            let local_workspace = local.sessions.get(&target);
            let local_messages = local.removed_messages.get(&target);
            let decision = if local_workspace.is_none() && (remapped || local_messages.is_none()) {
                Decision::Import
            } else if (entry.workspace.is_none() || entry.workspace.as_ref() == local_workspace)
                && (remapped
                    || local_messages == Some(&entry.removed_messages)
                    || (local_messages.is_none() && entry.removed_messages.is_empty()))
            {
                Decision::Unchanged
            } else {
                let id = format!("session:{key}");
                let state = json!({
                    "workspace": local_workspace.filter(|_| entry.workspace.is_some()),
                    "removed_messages": local_messages.filter(|_| !remapped),
                });
                plan.conflict_items.push(json!({
                    "id": id, "kind": "session", "key": target,
                    "local": state,
                    "incoming": {
                        "workspace": entry.workspace,
                        "removed_messages": (!remapped).then_some(&entry.removed_messages),
                    },
                }));
                hash.update(serde_json::to_vec(&state).map_err(error_text)?);
                Decision::Conflict
            };
            let replace =
                decision == Decision::Conflict && replacements.contains(&format!("session:{key}"));
            if plan.record(decision, replace, &mut hash) {
                plan.sessions.push((target, entry, remapped, replace));
            }
        }
        let local_filters = local
            .saved_filters
            .iter()
            .map(|filter| (&filter.id, filter))
            .collect::<BTreeMap<_, _>>();
        for filter in &self.saved_filters {
            let decision = match local_filters.get(&filter.id) {
                None => Decision::Import,
                Some(local) if local.name == filter.name && local.filter == filter.filter => {
                    Decision::Unchanged
                }
                Some(local) => {
                    plan.conflict_items.push(json!({
                        "id": format!("filter:{}", filter.id), "kind": "filter", "key": filter.id,
                        "local": {"name": local.name, "filter": local.filter},
                        "incoming": {"name": filter.name, "filter": filter.filter},
                    }));
                    hash.update(serde_json::to_vec(local).map_err(error_text)?);
                    Decision::Conflict
                }
            };
            let replace = decision == Decision::Conflict
                && replacements.contains(&format!("filter:{}", filter.id));
            if plan.record(decision, replace, &mut hash) {
                plan.filters.push(filter);
            }
        }
        if plan.replaced != replacements.len() {
            return Err("导入冲突选项已变化，请重新预览".into());
        }
        plan.token = hash
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        Ok(plan)
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Decision {
    Import,
    Unmatched,
    Unchanged,
    Conflict,
    Skipped,
}

#[derive(Default)]
struct ImportPlan<'a> {
    sessions: Vec<(String, &'a SessionEntry, bool, bool)>,
    filters: Vec<&'a SavedFilter>,
    unmatched: Vec<&'a str>,
    remapped: usize,
    skipped_messages: usize,
    unchanged: usize,
    conflicts: usize,
    replaced: usize,
    conflict_items: Vec<Value>,
    token: String,
}

impl ImportPlan<'_> {
    fn record(&mut self, decision: Decision, replace: bool, hash: &mut Sha256) -> bool {
        hash.update([decision as u8, u8::from(replace)]);
        if replace {
            self.replaced += 1;
            return true;
        }
        match decision {
            Decision::Import => return true,
            Decision::Unmatched | Decision::Skipped => {}
            Decision::Unchanged => self.unchanged += 1,
            Decision::Conflict => self.conflicts += 1,
        }
        false
    }

    fn summary(&self) -> Value {
        json!({
            "sessions": self.sessions.len(),
            "filters": self.filters.len(),
            "unmatched": self.unmatched.len(),
            "unmatched_keys": self.unmatched,
            "remapped": self.remapped,
            "skipped_messages": self.skipped_messages,
            "unchanged": self.unchanged,
            "conflicts": self.conflicts,
            "replaced": self.replaced,
            "token": self.token,
        })
    }

    fn write(&self, transaction: &Transaction<'_>) -> Result<(), String> {
        let mut remove_message = transaction
            .prepare(
                "insert into message_workspace(session_key, message_key, removed, updated_at)
             values(?1, ?2, 1, ?3)",
            )
            .map_err(error_text)?;
        let updated_at = now();
        for (key, entry, remapped, replace) in &self.sessions {
            if let Some(state) = &entry.workspace {
                write_session_state(transaction, key, state)?;
                if *replace {
                    transaction
                        .execute("delete from session_tags where session_key = ?1", [key])
                        .map_err(error_text)?;
                }
                insert_session_tags(transaction, key, &state.tags)?;
            }
            // 新会话键下的消息标识可能指向不同消息。
            if *remapped {
                continue;
            }
            if *replace {
                transaction
                    .execute(
                        "delete from message_workspace where session_key = ?1",
                        [key],
                    )
                    .map_err(error_text)?;
            }
            for message in &entry.removed_messages {
                remove_message
                    .execute(params![key, message, updated_at])
                    .map_err(error_text)?;
            }
        }
        let mut insert_filter = transaction.prepare(
            "insert into saved_filters(id, name, filter_json, updated_at) values(?1, ?2, ?3, ?4)
             on conflict(id) do update set name = excluded.name, filter_json = excluded.filter_json,
                 updated_at = excluded.updated_at",
        ).map_err(error_text)?;
        for filter in &self.filters {
            insert_filter
                .execute(params![
                    filter.id,
                    filter.name,
                    filter.filter.to_string(),
                    filter.updated_at
                ])
                .map_err(error_text)?;
        }
        Ok(())
    }
}

impl WorkspaceStore {
    pub(crate) fn export_transfer(&self) -> Result<String, String> {
        let snapshot = self.snapshot()?;
        let mut sessions = BTreeMap::<_, SessionEntry>::new();
        for (key, workspace) in snapshot.sessions {
            sessions.entry(key).or_default().workspace = Some(workspace);
        }
        for (key, messages) in snapshot.removed_messages {
            sessions.entry(key).or_default().removed_messages = messages;
        }
        let transfer = WorkspaceTransfer {
            format: FORMAT.into(),
            version: VERSION,
            exported_at: now(),
            sessions,
            saved_filters: snapshot.saved_filters,
        };
        transfer.validate()?;
        let text = serde_json::to_string(&transfer).map_err(error_text)?;
        check_size(&text)?;
        Ok(text)
    }

    pub(crate) fn preview_transfer(
        &self,
        transfer: &WorkspaceTransfer,
        target_session: impl Fn(&str) -> Option<String>,
        replacements: &BTreeSet<String>,
        previous_token: Option<&str>,
    ) -> Result<Value, String> {
        let snapshot = self.snapshot()?;
        if !replacements.is_empty() {
            let previous = transfer.plan(&snapshot, &target_session, &BTreeSet::new())?;
            if previous_token != Some(previous.token.as_str()) {
                return Err("导入预览已变化，请重新选择文件并确认".into());
            }
        }
        let plan = transfer.plan(&snapshot, target_session, replacements)?;
        let mut summary = plan.summary();
        summary["conflict_items"] = json!(plan.conflict_items);
        Ok(summary)
    }

    pub(crate) fn import_transfer(
        &mut self,
        transfer: &WorkspaceTransfer,
        target_session: impl Fn(&str) -> Option<String>,
        replacements: &BTreeSet<String>,
        token: &str,
    ) -> Result<Value, String> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(error_text)?;
        let snapshot = Self::read_snapshot(&transaction, &self.path)?;
        let plan = transfer.plan(&snapshot, target_session, replacements)?;
        if token != plan.token {
            return Err("导入预览已变化，请重新选择文件并确认".into());
        }
        if plan.sessions.is_empty() && plan.filters.is_empty() {
            return Ok(plan.summary());
        }
        let backup = backup_before_import(&self.path)?;
        plan.write(&transaction)?;
        transaction.commit().map_err(error_text)?;
        let mut summary = plan.summary();
        summary["backup_path"] = json!(backup.to_string_lossy());
        Ok(summary)
    }
}

fn backup_before_import(path: &Path) -> Result<PathBuf, String> {
    let backup = path.with_file_name(format!("workspace-before-import-{}.sqlite", Uuid::new_v4()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    options
        .open(&backup)
        .map_err(|error| format!("创建工作台备份失败：{error}"))?;

    let copy = (|| -> Result<(), String> {
        // 同一数据库的只读连接用于备份事务开始前的已提交状态，包含 WAL 中的数据。
        let source = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(error_text)?;
        let mut destination = Connection::open(&backup).map_err(error_text)?;
        let handle = Backup::new(&source, &mut destination).map_err(error_text)?;
        match handle.step(-1).map_err(error_text)? {
            StepResult::Done => Ok(()),
            _ => Err("SQLite 备份未完成".into()),
        }
    })();
    if let Err(error) = copy {
        fs::remove_file(&backup)
            .map_err(|cleanup| format!("工作台备份失败：{error}。清理失败：{cleanup}"))?;
        return Err(format!("工作台备份失败：{error}"));
    }
    Ok(backup)
}

fn check_size(text: &str) -> Result<(), String> {
    if text.len() > MAX_BYTES {
        return Err("工作台文件不能超过 16 MB".into());
    }
    Ok(())
}

fn validate_text(value: &str, label: &str, limit: usize) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("{label}不能为空"));
    }
    validate_length(value, label, limit)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn 导出导入会话及筛选并保留本地冲突项() {
        let dir = tempdir().unwrap();
        let mut source = WorkspaceStore::open_at(&dir.path().join("source.sqlite")).unwrap();
        for key in ["codex:new", "codex:conflict", "missing:path"] {
            source
                .update_session(&json!({
                    "sessionKey": key, "favorite": true, "archived": true, "removed": true,
                    "display_name": "合成会话", "note": "合成备注", "tags": ["开发"]
                }))
                .unwrap();
            source
                .update_message(&json!({"sessionKey": key, "messageKey": "m1", "removed": true}))
                .unwrap();
        }
        source
            .update_message(
                &json!({"sessionKey": "codex:message-only", "messageKey": "m2", "removed": true}),
            )
            .unwrap();
        source
            .save_filter(&json!({"id": "new", "name": "收藏", "filter": {"favorite": true}}))
            .unwrap();
        source
            .save_filter(&json!({"id": "conflict", "name": "源筛选", "filter": {}}))
            .unwrap();

        let file = source.export_transfer().unwrap();
        assert!(!file.contains("source.sqlite"));
        let transfer = WorkspaceTransfer::parse(&file).unwrap();
        let mut target = WorkspaceStore::open_at(&dir.path().join("target.sqlite")).unwrap();
        target
            .update_session(&json!({"sessionKey": "codex:conflict", "note": "本地备注"}))
            .unwrap();
        target
            .save_filter(&json!({"id": "conflict", "name": "本地筛选", "filter": {}}))
            .unwrap();
        let before = target.snapshot().unwrap();
        let known = |key: &str| key.starts_with("codex:").then(|| key.to_owned());
        let preview = target
            .preview_transfer(&transfer, known, &BTreeSet::new(), None)
            .unwrap();
        assert_eq!(preview["sessions"], 2);
        assert_eq!(preview["filters"], 1);
        assert_eq!(preview["conflicts"], 2);
        assert_eq!(preview["unmatched"], 1);
        assert_eq!(preview["unmatched_keys"], json!(["missing:path"]));
        let result = target
            .import_transfer(
                &transfer,
                known,
                &BTreeSet::new(),
                preview["token"].as_str().unwrap(),
            )
            .unwrap();

        let after = target.snapshot().unwrap();
        let original = source.snapshot().unwrap();
        assert!(after.sessions["codex:new"] == original.sessions["codex:new"]);
        assert!(after.message_removed("codex:new", "m1"));
        assert!(after.message_removed("codex:message-only", "m2"));
        assert_eq!(after.sessions["codex:conflict"].note, "本地备注");
        assert!(!after.message_removed("codex:conflict", "m1"));
        assert!(!after.sessions.contains_key("missing:path"));
        assert!(
            after
                .saved_filters
                .iter()
                .any(|filter| filter.name == "收藏")
        );
        assert!(
            after
                .saved_filters
                .iter()
                .any(|filter| filter.name == "本地筛选")
        );

        let backup_path = Path::new(result["backup_path"].as_str().unwrap());
        #[cfg(unix)]
        assert_eq!(
            fs::metadata(backup_path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let backup = WorkspaceStore::open_at(backup_path)
            .unwrap()
            .snapshot()
            .unwrap();
        assert_eq!(backup.value()["sessions"], before.value()["sessions"]);
        assert_eq!(
            backup.value()["saved_filters"],
            before.value()["saved_filters"]
        );

        let repeated = target
            .preview_transfer(&transfer, known, &BTreeSet::new(), None)
            .unwrap();
        assert_eq!(repeated["unchanged"], 3);
        let repeated = target
            .import_transfer(
                &transfer,
                known,
                &BTreeSet::new(),
                repeated["token"].as_str().unwrap(),
            )
            .unwrap();
        assert!(repeated.get("backup_path").is_none());
    }

    #[test]
    fn 逐项覆盖冲突并拒绝过期预览() {
        let dir = tempdir().unwrap();
        let mut source = WorkspaceStore::open_at(&dir.path().join("source.sqlite")).unwrap();
        let mut target = WorkspaceStore::open_at(&dir.path().join("target.sqlite")).unwrap();
        for (store, value) in [(&mut source, "导入"), (&mut target, "本地")] {
            for key in ["replace", "keep", "remap"] {
                store
                    .update_session(&json!({
                        "sessionKey": key, "note": value, "tags": [value]
                    }))
                    .unwrap();
                store
                    .update_message(&json!({
                        "sessionKey": key, "messageKey": value, "removed": true
                    }))
                    .unwrap();
            }
            store
                .save_filter(&json!({
                    "id": "replace", "name": value, "filter": {"q": value}
                }))
                .unwrap();
        }
        let transfer = WorkspaceTransfer::parse(&source.export_transfer().unwrap()).unwrap();
        let matched = |key: &str| Some(if key == "remap" { "new" } else { key }.to_owned());
        target
            .update_session(&json!({"sessionKey": "new", "note": "原备注"}))
            .unwrap();
        target
            .update_message(&json!({
                "sessionKey": "new", "messageKey": "local", "removed": true
            }))
            .unwrap();
        let initial = target
            .preview_transfer(&transfer, matched, &BTreeSet::new(), None)
            .unwrap();
        assert_eq!(initial["conflict_items"].as_array().unwrap().len(), 4);
        let selected = ["session:replace", "session:remap", "filter:replace"]
            .map(str::to_owned)
            .into_iter()
            .collect();
        let review = |target: &WorkspaceStore, previous: &Value| {
            target.preview_transfer(&transfer, matched, &selected, previous["token"].as_str())
        };
        target
            .update_session(&json!({"sessionKey": "replace", "note": "预览后变更"}))
            .unwrap();
        assert!(review(&target, &initial).is_err());
        let initial = target
            .preview_transfer(&transfer, matched, &BTreeSet::new(), None)
            .unwrap();
        let preview = review(&target, &initial).unwrap();
        assert_eq!(preview["conflicts"], 1);
        assert_eq!(preview["replaced"], 3);
        let token = preview["token"].as_str().unwrap();
        assert!(
            target
                .import_transfer(&transfer, matched, &BTreeSet::new(), token)
                .is_err()
        );
        let result = target
            .import_transfer(&transfer, matched, &selected, token)
            .unwrap();
        let after = target.snapshot().unwrap();
        assert_eq!(
            after.sessions["replace"].tags,
            BTreeSet::from(["导入".into()])
        );
        assert!(after.message_removed("replace", "导入"));
        assert!(!after.message_removed("replace", "本地"));
        assert_eq!(after.sessions["keep"].note, "本地");
        assert_eq!(after.sessions["new"].note, "导入");
        assert!(after.message_removed("new", "local"));
        assert!(!after.message_removed("new", "导入"));
        assert_eq!(after.saved_filters[0].filter["q"], "导入");
        let backup = WorkspaceStore::open_at(Path::new(result["backup_path"].as_str().unwrap()))
            .unwrap()
            .snapshot()
            .unwrap();
        assert_eq!(backup.sessions["replace"].note, "预览后变更");
    }

    #[test]
    fn 匹配对象变化后即使数量相同也需要重新确认() {
        let dir = tempdir().unwrap();
        let mut store = WorkspaceStore::open_at(&dir.path().join("workspace.sqlite")).unwrap();
        let transfer = WorkspaceTransfer::parse(
            &json!({
                "format": FORMAT, "version": VERSION, "exported_at": now(),
                "sessions": {
                    "codex:first": {"workspace": null, "removed_messages": ["m1"]},
                    "codex:second": {"workspace": null, "removed_messages": ["m2"]}
                }, "saved_filters": []
            })
            .to_string(),
        )
        .unwrap();
        let preview = store
            .preview_transfer(
                &transfer,
                |key| (key == "codex:first").then(|| key.to_owned()),
                &BTreeSet::new(),
                None,
            )
            .unwrap();
        assert!(
            store
                .import_transfer(
                    &transfer,
                    |key| (key == "codex:second").then(|| key.to_owned()),
                    &BTreeSet::new(),
                    preview["token"].as_str().unwrap()
                )
                .is_err()
        );
        assert!(store.snapshot().unwrap().removed_messages.is_empty());
    }

    #[test]
    fn 跨键导入整理状态且跳过消息移除标记() {
        let dir = tempdir().unwrap();
        let mut source = WorkspaceStore::open_at(&dir.path().join("source.sqlite")).unwrap();
        source
            .update_session(&json!({"sessionKey": "old", "favorite": true, "note": "合成备注"}))
            .unwrap();
        source
            .update_message(&json!({"sessionKey": "old", "messageKey": "m1", "removed": true}))
            .unwrap();
        let transfer = WorkspaceTransfer::parse(&source.export_transfer().unwrap()).unwrap();
        let mut store = WorkspaceStore::open_at(&dir.path().join("target.sqlite")).unwrap();
        let matched = |_: &str| Some("new".into());
        let preview = store
            .preview_transfer(&transfer, matched, &BTreeSet::new(), None)
            .unwrap();
        assert_eq!(preview["remapped"], 1);
        assert_eq!(preview["skipped_messages"], 1);
        let token = preview["token"].as_str().unwrap();
        assert!(
            store
                .import_transfer(&transfer, |_| Some("other".into()), &BTreeSet::new(), token)
                .is_err()
        );
        store
            .import_transfer(&transfer, matched, &BTreeSet::new(), token)
            .unwrap();
        let snapshot = store.snapshot().unwrap();
        assert_eq!(snapshot.sessions["new"].note, "合成备注");
        assert!(snapshot.sessions["new"].favorite);
        assert!(!snapshot.message_removed("new", "m1"));
        assert!(!snapshot.sessions.contains_key("old"));
    }

    #[test]
    fn 导入拒绝无效文件并在写入失败时回滚整个事务() {
        assert!(
            WorkspaceTransfer::parse(&"x".repeat(MAX_BYTES + 1))
                .err()
                .unwrap()
                .contains("16 MB")
        );
        let mut file = json!({
            "format": FORMAT, "version": VERSION + 1, "exported_at": now(),
            "sessions": {}, "saved_filters": [{"id": "new", "name": "筛选", "filter": {"q": 42}, "updated_at": now()}]
        });
        assert!(
            WorkspaceTransfer::parse(&file.to_string())
                .err()
                .unwrap()
                .contains("版本")
        );
        file["version"] = json!(VERSION);
        assert!(
            WorkspaceTransfer::parse(&file.to_string())
                .err()
                .unwrap()
                .contains("筛选条件")
        );

        file["sessions"]["codex:new"] = json!({"workspace": null, "removed_messages": ["m1"]});
        file["saved_filters"][0]["filter"] = json!({"q": "合成"});
        let transfer = WorkspaceTransfer::parse(&file.to_string()).unwrap();
        let dir = tempdir().unwrap();
        let mut store = WorkspaceStore::open_at(&dir.path().join("workspace.sqlite")).unwrap();
        store
            .connection
            .execute_batch(
                "create trigger fail_import before insert on saved_filters begin
                 select raise(abort, '写入失败');
             end;",
            )
            .unwrap();
        let preview = store
            .preview_transfer(
                &transfer,
                |key| Some(key.to_owned()),
                &BTreeSet::new(),
                None,
            )
            .unwrap();
        let error = store
            .import_transfer(
                &transfer,
                |key| Some(key.to_owned()),
                &BTreeSet::new(),
                preview["token"].as_str().unwrap(),
            )
            .unwrap_err();
        assert!(error.contains("写入失败"));
        assert!(store.snapshot().unwrap().removed_messages.is_empty());
        assert!(store.snapshot().unwrap().saved_filters.is_empty());
    }
}
