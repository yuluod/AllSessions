use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    env, fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

use chrono::Utc;
use rusqlite::{backup::Backup, params, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;
use walkdir::WalkDir;

const MIGRATION_NAME: &str = "codex-history-provider-rebucket-v2";
const BUILTIN_PROVIDERS: &[&str] = &[
    "amazon-bedrock",
    "azure",
    "lmstudio",
    "ollama",
    "ollama-chat",
    "openai",
    "oss",
];

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderAssignment {
    line_number: usize,
    session_id: Option<String>,
    provider: String,
}

#[derive(Clone)]
struct JsonlPlan {
    path: PathBuf,
    hash: String,
    assignments: Vec<ProviderAssignment>,
}

#[derive(Clone, Serialize, Deserialize)]
struct ThreadAssignment {
    id: String,
    provider: String,
}

#[derive(Clone)]
struct DatabasePlan {
    path: PathBuf,
    rows: Vec<ThreadAssignment>,
    hash: String,
    valid: bool,
    reason: Option<String>,
}

struct MigrationPlan {
    summary: Value,
    codex_home: PathBuf,
    backup_root: PathBuf,
    target_provider: Option<String>,
    providers: Vec<String>,
    databases: Vec<DatabasePlan>,
    jsonl_files: Vec<JsonlPlan>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupMetadata {
    migration: String,
    version: u8,
    status: String,
    created_at: String,
    codex_home: PathBuf,
    target_provider: String,
    providers: Vec<String>,
    plan_id: String,
    databases: Vec<DatabaseBackup>,
    jsonl_files: Vec<JsonlBackup>,
}

#[derive(Serialize, Deserialize)]
struct DatabaseBackup {
    target: PathBuf,
    backup: PathBuf,
    hash: String,
    rows: Vec<ThreadAssignment>,
}

#[derive(Serialize, Deserialize)]
struct JsonlBackup {
    target: PathBuf,
    backup: PathBuf,
    hash: String,
    assignments: Vec<ProviderAssignment>,
}

pub fn preview(provider_query: Option<&str>, enabled: &AtomicBool) -> Result<Value, String> {
    let providers = provider_query.map(parse_providers).transpose()?;
    Ok(build_plan(providers, Some(enabled))?.summary)
}

pub fn apply(body: &Value) -> Result<Value, String> {
    require_closed_confirmation(body)?;
    assert_codex_closed()?;
    let plan_id = body
        .get("planId")
        .and_then(Value::as_str)
        .filter(|value| {
            value.len() == 64 && value.chars().all(|character| character.is_ascii_hexdigit())
        })
        .ok_or_else(|| "需要有效的预览计划 ID".to_string())?;
    let providers = body
        .get("providers")
        .and_then(Value::as_array)
        .ok_or_else(|| "需要选择来源 Provider".to_string())?
        .iter()
        .map(|value| {
            value
                .as_str()
                .ok_or_else(|| "Provider 必须是字符串".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?
        .join(",");
    let plan = build_plan(Some(parse_providers(&providers)?), None)?;
    if plan.summary["planId"].as_str() != Some(plan_id) {
        return Err("历史数据在预览后发生变化，请关闭 Codex 后重新预览".into());
    }
    if plan.summary["canApply"].as_bool() != Some(true) {
        return Err("当前修复计划存在阻断项".into());
    }
    if plan.summary["hasChanges"].as_bool() != Some(true) {
        let mut summary = plan.summary;
        summary["dryRun"] = Value::Bool(false);
        return Ok(summary);
    }

    assert_plan_unchanged(&plan)?;
    let (backup_dir, mut metadata) = create_backup(&plan, plan_id)?;
    let result = (|| {
        update_databases(&plan)?;
        update_jsonl_files(&plan)?;
        verify_applied(&plan)
    })();
    if let Err(error) = result {
        let rollback_result = restore_provider_fields(&backup_dir, &metadata);
        metadata.status = "auto_rolled_back".into();
        let _ = write_metadata(&backup_dir, &metadata);
        return match rollback_result {
            Ok(_) => Err(error),
            Err(rollback_error) => Err(format!("{error}；自动回滚失败：{rollback_error}")),
        };
    }
    metadata.status = "completed".into();
    write_metadata(&backup_dir, &metadata)?;
    let mut summary = plan.summary;
    summary["dryRun"] = Value::Bool(false);
    summary["backupDir"] = Value::String(backup_dir.to_string_lossy().into_owned());
    summary["verification"] =
        json!({ "ok": true, "remainingThreadMatches": 0, "remainingJsonlReplacements": 0 });
    Ok(summary)
}

pub fn rollback(body: &Value) -> Result<Value, String> {
    require_closed_confirmation(body)?;
    assert_codex_closed()?;
    let backup_dir = PathBuf::from(
        body.get("backupDir")
            .and_then(Value::as_str)
            .ok_or_else(|| "需要备份目录".to_string())?,
    );
    let codex_home = codex_home();
    let allowed_root = codex_home.join("backups").join(MIGRATION_NAME);
    assert_inside(&allowed_root, &backup_dir, "备份目录")?;
    let metadata = read_backup_metadata(&backup_dir)?;
    validate_metadata(&metadata, &codex_home)?;
    let (restored_sqlite, restored_jsonl) = restore_provider_fields(&backup_dir, &metadata)?;
    let mut updated = metadata;
    updated.status = "rolled_back".into();
    write_metadata(&backup_dir, &updated)?;
    Ok(json!({
        "backupDir": backup_dir,
        "codexHome": codex_home,
        "restoredSqlite": restored_sqlite,
        "restoredJsonl": restored_jsonl
    }))
}

fn build_plan(
    selected: Option<Vec<String>>,
    cancellation: Option<&AtomicBool>,
) -> Result<MigrationPlan, String> {
    let codex_home = codex_home();
    let backup_root = codex_home.join("backups");
    let config_path = codex_home.join("config.toml");
    let config_text = fs::read_to_string(&config_path).ok();
    let config_hash = config_text.as_deref().map(hash_bytes);
    let config = config_text
        .as_deref()
        .and_then(|text| toml::from_str::<toml::Value>(text).ok());
    let target_provider = config
        .as_ref()
        .and_then(|value| value.get("model_provider"))
        .and_then(toml::Value::as_str)
        .map(ToOwned::to_owned);
    let mut blockers = Vec::new();
    let mut warnings = Vec::new();
    let target_eligible = match target_provider.as_deref() {
        None if config_text.is_none() => {
            blockers.push(diagnostic(
                "codex_config_missing",
                format!("找不到 Codex 配置：{}", config_path.display()),
            ));
            false
        }
        None => {
            blockers.push(diagnostic(
                "active_provider_missing",
                "Codex 配置未指定 model_provider",
            ));
            false
        }
        Some(provider) if !valid_provider(provider) => {
            blockers.push(diagnostic(
                "active_provider_invalid",
                "当前 Provider ID 不受支持",
            ));
            false
        }
        Some(provider) if is_builtin(provider) => {
            blockers.push(diagnostic(
                "active_provider_builtin",
                format!("不能将第三方历史迁入内置 Provider {provider}"),
            ));
            false
        }
        Some(provider) if !config_defines_provider(config.as_ref(), provider) => {
            blockers.push(diagnostic(
                "active_provider_undefined",
                format!("Codex 配置未定义 model_providers.{provider}"),
            ));
            false
        }
        Some(provider) => {
            warnings.push(diagnostic(
                "current_provider_only",
                format!("修复仅对当前 Provider {provider} 生效"),
            ));
            true
        }
    };

    let mut databases = Vec::new();
    for path in state_database_candidates(&codex_home, config.as_ref()) {
        if path.is_file() {
            databases.push(read_database_plan(path)?);
        }
    }
    if databases.is_empty() {
        warnings.push(diagnostic(
            "codex_state_db_missing",
            "未找到 Codex state_5.sqlite",
        ));
    }
    for database in &databases {
        if !database.valid {
            blockers.push(diagnostic(
                "codex_state_schema_unsupported",
                format!(
                    "{}：{}",
                    database.path.display(),
                    database.reason.as_deref().unwrap_or("结构不受支持")
                ),
            ));
        }
    }
    let all_jsonl = scan_jsonl(&codex_home, cancellation)?;
    let mut counts = BTreeMap::<String, (usize, usize)>::new();
    for database in &databases {
        for row in &database.rows {
            counts.entry(row.provider.clone()).or_default().0 += 1;
        }
    }
    for file in &all_jsonl {
        for assignment in &file.assignments {
            counts.entry(assignment.provider.clone()).or_default().1 += 1;
        }
    }
    for provider in counts.keys().filter(|provider| !valid_provider(provider)) {
        blockers.push(diagnostic(
            "invalid_provider_id",
            format!("历史记录包含无效 Provider：{provider}"),
        ));
    }
    let candidates = if target_eligible {
        counts
            .keys()
            .filter(|provider| {
                valid_provider(provider)
                    && !is_protected(provider)
                    && Some(provider.as_str()) != target_provider.as_deref()
            })
            .cloned()
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let providers = if target_eligible {
        selected.unwrap_or_default()
    } else {
        Vec::new()
    };
    for provider in &providers {
        validate_source_provider(provider, target_provider.as_deref())?;
        if !counts.contains_key(provider) {
            blockers.push(diagnostic(
                "source_provider_not_found",
                format!("历史记录中找不到 Provider：{provider}"),
            ));
        }
    }
    if target_eligible && !candidates.is_empty() && providers.is_empty() {
        blockers.push(diagnostic(
            "source_provider_selection_required",
            "请选择一个或多个来源 Provider",
        ));
    }
    let provider_set = providers.iter().cloned().collect::<BTreeSet<_>>();
    let jsonl_files = all_jsonl
        .iter()
        .filter_map(|file| {
            let assignments = file
                .assignments
                .iter()
                .filter(|item| provider_set.contains(&item.provider))
                .cloned()
                .collect::<Vec<_>>();
            (!assignments.is_empty()).then(|| JsonlPlan {
                path: file.path.clone(),
                hash: file.hash.clone(),
                assignments,
            })
        })
        .collect::<Vec<_>>();
    let thread_matches = databases
        .iter()
        .flat_map(|database| &database.rows)
        .filter(|row| provider_set.contains(&row.provider))
        .count();
    let jsonl_replacements = jsonl_files
        .iter()
        .map(|file| file.assignments.len())
        .sum::<usize>();
    let mapping = |provider: &String| {
        let (threads, jsonl) = counts.get(provider).copied().unwrap_or_default();
        json!({ "source": provider, "target": target_provider, "threads": threads, "jsonl": jsonl })
    };
    let plan_fingerprint = json!({
        "migration": MIGRATION_NAME,
        "targetProvider": target_provider,
        "providers": providers,
        "configHash": config_hash,
        "databases": databases.iter().map(|database| json!({ "path": database.path, "hash": database.hash })).collect::<Vec<_>>(),
        "jsonl": all_jsonl.iter().map(|file| json!({ "path": file.path, "hash": file.hash })).collect::<Vec<_>>()
    });
    let plan_id = hash_bytes(&serde_json::to_string(&plan_fingerprint).map_err(error_text)?);
    let summary = json!({
        "dryRun": true,
        "migration": MIGRATION_NAME,
        "codexOnly": true,
        "targetProvider": target_provider,
        "codexHome": codex_home,
        "backupRoot": backup_root,
        "providers": providers,
        "candidateProviders": candidates,
        "candidateMappings": candidates.iter().map(mapping).collect::<Vec<_>>(),
        "mappings": providers.iter().map(mapping).collect::<Vec<_>>(),
        "providerCounts": counts.iter().map(|(provider, (threads, _))| json!({ "provider": provider, "count": threads })).collect::<Vec<_>>(),
        "threadMatches": thread_matches,
        "stateDatabases": databases.iter().map(|database| json!({ "path": database.path, "threadMatches": database.rows.iter().filter(|row| provider_set.contains(&row.provider)).count() })).collect::<Vec<_>>(),
        "jsonlFilesScanned": all_jsonl.len(),
        "jsonlFilesToChange": jsonl_files.len(),
        "jsonlSessionMetaReplacements": jsonl_replacements,
        "codexConfig": { "path": config_path, "status": if config_text.is_some() { "read_only" } else { "missing" }, "activeProvider": target_provider, "modified": false },
        "blockers": blockers,
        "warnings": warnings,
        "canApply": blockers.is_empty(),
        "hasChanges": thread_matches + jsonl_replacements > 0,
        "selectionRequired": target_eligible && !candidates.is_empty() && providers.is_empty(),
        "temporaryForCurrentProvider": true,
        "planId": plan_id,
        "backupDir": Value::Null
    });
    Ok(MigrationPlan {
        summary,
        codex_home,
        backup_root,
        target_provider,
        providers,
        databases,
        jsonl_files,
    })
}

fn read_database_plan(path: PathBuf) -> Result<DatabasePlan, String> {
    let connection =
        Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(error_text)?;
    let has_column = connection
        .prepare("pragma table_info(threads)")
        .and_then(|mut statement| {
            statement
                .query_map([], |row| row.get::<_, String>(1))
                .map(|rows| {
                    rows.filter_map(Result::ok)
                        .any(|name| name == "model_provider")
                })
        })
        .unwrap_or(false);
    if !has_column {
        return Ok(DatabasePlan {
            path,
            rows: Vec::new(),
            hash: String::new(),
            valid: false,
            reason: Some("缺少 threads.model_provider".into()),
        });
    }
    let mut statement = connection
        .prepare("select id, model_provider from threads order by id")
        .map_err(error_text)?;
    let rows = statement
        .query_map([], |row| {
            Ok(ThreadAssignment {
                id: row.get(0)?,
                provider: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
            })
        })
        .map_err(error_text)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(error_text)?;
    let hash = hash_bytes(&serde_json::to_string(&rows).map_err(error_text)?);
    Ok(DatabasePlan {
        path,
        rows,
        hash,
        valid: true,
        reason: None,
    })
}

fn scan_jsonl(
    codex_home: &Path,
    cancellation: Option<&AtomicBool>,
) -> Result<Vec<JsonlPlan>, String> {
    let mut files = Vec::new();
    for root in [
        codex_home.join("sessions"),
        codex_home.join("archived_sessions"),
    ] {
        if !root.exists() {
            continue;
        }
        for entry in WalkDir::new(root)
            .follow_links(false)
            .max_depth(16)
            .into_iter()
            .filter_map(Result::ok)
        {
            if cancellation.is_some_and(|enabled| !enabled.load(Ordering::SeqCst)) {
                return Err("维护预览已取消".into());
            }
            if !entry.file_type().is_file()
                || entry.path().extension().and_then(|value| value.to_str()) != Some("jsonl")
            {
                continue;
            }
            let mut reader = BufReader::new(fs::File::open(entry.path()).map_err(error_text)?);
            let mut assignments = Vec::new();
            let mut hash = Sha256::new();
            let mut line = Vec::new();
            let mut line_number = 0;
            loop {
                if cancellation.is_some_and(|enabled| !enabled.load(Ordering::Relaxed)) {
                    return Err("维护预览已取消".into());
                }
                line.clear();
                let read = reader.read_until(b'\n', &mut line).map_err(error_text)?;
                if read == 0 {
                    break;
                }
                line_number += 1;
                hash.update(&line);
                if let Some(assignment) = assignment_from_line(&line, line_number) {
                    assignments.push(assignment);
                }
            }
            files.push(JsonlPlan {
                path: entry.path().to_path_buf(),
                hash: encode_hex(hash.finalize()),
                assignments,
            });
        }
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(files)
}

fn assignment_from_line(line: &[u8], line_number: usize) -> Option<ProviderAssignment> {
    let record: Value = serde_json::from_slice(line).ok()?;
    if record.get("type").and_then(Value::as_str) != Some("session_meta") {
        return None;
    }
    let payload = record.get("payload")?;
    Some(ProviderAssignment {
        line_number,
        session_id: payload
            .get("id")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        provider: payload.get("model_provider")?.as_str()?.to_string(),
    })
}

fn create_backup(plan: &MigrationPlan, plan_id: &str) -> Result<(PathBuf, BackupMetadata), String> {
    let name = format!(
        "{}-{}",
        Utc::now().format("%Y-%m-%dT%H-%M-%SZ"),
        Uuid::new_v4().simple()
    );
    let backup_dir = plan.backup_root.join(MIGRATION_NAME).join(name);
    fs::create_dir_all(&backup_dir).map_err(error_text)?;
    let provider_set = plan.providers.iter().cloned().collect::<BTreeSet<_>>();
    let mut database_backups = Vec::new();
    for (index, database) in plan.databases.iter().enumerate() {
        let rows = database
            .rows
            .iter()
            .filter(|row| provider_set.contains(&row.provider))
            .cloned()
            .collect::<Vec<_>>();
        if rows.is_empty() {
            continue;
        }
        let relative = PathBuf::from(format!("sqlite/{index}-state_5.sqlite"));
        let backup_path = backup_dir.join(&relative);
        fs::create_dir_all(backup_path.parent().unwrap_or(&backup_dir)).map_err(error_text)?;
        backup_database(&database.path, &backup_path)?;
        database_backups.push(DatabaseBackup {
            target: database.path.clone(),
            backup: relative,
            hash: hash_file(&backup_path)?,
            rows,
        });
    }
    let mut jsonl_backups = Vec::new();
    for (index, file) in plan.jsonl_files.iter().enumerate() {
        assert_inside(&plan.codex_home, &file.path, "会话文件")?;
        let relative = PathBuf::from(format!("jsonl/{index}.jsonl"));
        let backup_path = backup_dir.join(&relative);
        fs::create_dir_all(backup_path.parent().unwrap_or(&backup_dir)).map_err(error_text)?;
        fs::copy(&file.path, &backup_path).map_err(error_text)?;
        jsonl_backups.push(JsonlBackup {
            target: file.path.clone(),
            backup: relative,
            hash: hash_file(&backup_path)?,
            assignments: file.assignments.clone(),
        });
    }
    let metadata = BackupMetadata {
        migration: MIGRATION_NAME.into(),
        version: 4,
        status: "prepared".into(),
        created_at: Utc::now().to_rfc3339(),
        codex_home: plan.codex_home.clone(),
        target_provider: plan
            .target_provider
            .clone()
            .ok_or_else(|| "缺少目标 Provider".to_string())?,
        providers: plan.providers.clone(),
        plan_id: plan_id.into(),
        databases: database_backups,
        jsonl_files: jsonl_backups,
    };
    write_metadata(&backup_dir, &metadata)?;
    Ok((backup_dir, metadata))
}

fn backup_database(source_path: &Path, backup_path: &Path) -> Result<(), String> {
    let source = Connection::open_with_flags(source_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(error_text)?;
    let mut destination = Connection::open(backup_path).map_err(error_text)?;
    let result = Backup::new(&source, &mut destination)
        .map_err(error_text)?
        .run_to_completion(16, Duration::from_millis(10), None)
        .map_err(error_text);
    result
}

fn update_databases(plan: &MigrationPlan) -> Result<(), String> {
    let target = plan
        .target_provider
        .as_deref()
        .ok_or_else(|| "缺少目标 Provider".to_string())?;
    let provider_set = plan.providers.iter().cloned().collect::<BTreeSet<_>>();
    for database in &plan.databases {
        let mut connection = Connection::open(&database.path).map_err(error_text)?;
        let transaction = connection.transaction().map_err(error_text)?;
        for row in database
            .rows
            .iter()
            .filter(|row| provider_set.contains(&row.provider))
        {
            let changed = transaction
                .execute(
                    "update threads set model_provider = ?1 where id = ?2 and model_provider = ?3",
                    params![target, row.id, row.provider],
                )
                .map_err(error_text)?;
            if changed != 1 {
                return Err(format!(
                    "数据库在写入期间发生变化：{}",
                    database.path.display()
                ));
            }
        }
        transaction.commit().map_err(error_text)?;
    }
    Ok(())
}

fn update_jsonl_files(plan: &MigrationPlan) -> Result<(), String> {
    let target = plan
        .target_provider
        .as_deref()
        .ok_or_else(|| "缺少目标 Provider".to_string())?;
    for file in &plan.jsonl_files {
        rewrite_jsonl(&file.path, &file.assignments, Some(target), |_, _| {
            target.to_string()
        })?;
    }
    Ok(())
}

fn rewrite_jsonl(
    path: &Path,
    assignments: &[ProviderAssignment],
    allowed_current: Option<&str>,
    provider_for: impl Fn(usize, &ProviderAssignment) -> String,
) -> Result<(), String> {
    let assignment_map = assignments
        .iter()
        .map(|item| (item.line_number, item))
        .collect::<BTreeMap<_, _>>();
    let parent = path
        .parent()
        .ok_or_else(|| "会话路径没有父目录".to_string())?;
    let temp = parent.join(format!(".allsessions-{}.tmp", Uuid::new_v4().simple()));
    let original_permissions = fs::metadata(path).map_err(error_text)?.permissions();
    let mut reader = BufReader::new(fs::File::open(path).map_err(error_text)?);
    let mut output = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temp)
        .map_err(error_text)?;
    let mut seen = BTreeSet::new();
    let mut line = Vec::new();
    let mut line_number = 0;
    let write_result = (|| -> Result<(), String> {
        loop {
            line.clear();
            if reader.read_until(b'\n', &mut line).map_err(error_text)? == 0 {
                break;
            }
            line_number += 1;
            if let Some(assignment) = assignment_map.get(&line_number) {
                let newline = if line.ends_with(b"\r\n") {
                    b"\r\n".as_slice()
                } else if line.ends_with(b"\n") {
                    b"\n".as_slice()
                } else {
                    b"".as_slice()
                };
                let content_end = line.len() - newline.len();
                let mut record: Value = serde_json::from_slice(&line[..content_end])
                    .map_err(|_| format!("会话元数据已变化：{}", path.display()))?;
                let payload = record
                    .get_mut("payload")
                    .and_then(Value::as_object_mut)
                    .ok_or_else(|| format!("会话元数据已变化：{}", path.display()))?;
                let current = payload
                    .get("model_provider")
                    .and_then(Value::as_str)
                    .ok_or_else(|| format!("会话元数据已变化：{}", path.display()))?;
                let next = provider_for(line_number, assignment);
                if current != assignment.provider && Some(current) != allowed_current {
                    return Err(format!("会话元数据已变化：{}", path.display()));
                }
                payload.insert("model_provider".into(), Value::String(next));
                serde_json::to_writer(&mut output, &record).map_err(error_text)?;
                output.write_all(newline).map_err(error_text)?;
                seen.insert(line_number);
            } else {
                output.write_all(&line).map_err(error_text)?;
            }
        }
        if seen.len() != assignments.len() {
            return Err(format!("会话元数据行已变化：{}", path.display()));
        }
        output
            .flush()
            .and_then(|_| output.sync_all())
            .map_err(error_text)?;
        Ok(())
    })();
    if let Err(error) = write_result {
        let _ = fs::remove_file(&temp);
        return Err(error);
    }
    fs::set_permissions(&temp, original_permissions).map_err(error_text)?;
    fs::rename(&temp, path).map_err(error_text)
}

fn restore_provider_fields(
    backup_dir: &Path,
    metadata: &BackupMetadata,
) -> Result<(usize, usize), String> {
    validate_metadata(metadata, &metadata.codex_home)?;
    for database in &metadata.databases {
        let backup = backup_dir.join(&database.backup);
        assert_inside(backup_dir, &backup, "数据库备份")?;
        if hash_file(&backup)? != database.hash {
            return Err("数据库备份校验失败".into());
        }
        let mut connection = Connection::open(&database.target).map_err(error_text)?;
        let transaction = connection.transaction().map_err(error_text)?;
        for row in &database.rows {
            let current: Option<String> = transaction
                .query_row(
                    "select model_provider from threads where id = ?1",
                    [&row.id],
                    |item| item.get(0),
                )
                .map_err(error_text)?;
            if current.as_deref() != Some(&metadata.target_provider)
                && current.as_deref() != Some(&row.provider)
            {
                return Err(format!("数据库线程在修复后又被修改：{}", row.id));
            }
            transaction
                .execute(
                    "update threads set model_provider = ?1 where id = ?2",
                    params![row.provider, row.id],
                )
                .map_err(error_text)?;
        }
        transaction.commit().map_err(error_text)?;
    }
    for file in &metadata.jsonl_files {
        let backup = backup_dir.join(&file.backup);
        assert_inside(backup_dir, &backup, "会话备份")?;
        if hash_file(&backup)? != file.hash {
            return Err("会话备份校验失败".into());
        }
        rewrite_jsonl(
            &file.target,
            &file.assignments,
            Some(&metadata.target_provider),
            |_, assignment| assignment.provider.clone(),
        )?;
    }
    Ok((metadata.databases.len(), metadata.jsonl_files.len()))
}

fn assert_plan_unchanged(plan: &MigrationPlan) -> Result<(), String> {
    for database in &plan.databases {
        if read_database_plan(database.path.clone())?.hash != database.hash {
            return Err(format!("数据库在预览后变化：{}", database.path.display()));
        }
    }
    for file in &plan.jsonl_files {
        if hash_file(&file.path)? != file.hash {
            return Err(format!("会话文件在预览后变化：{}", file.path.display()));
        }
    }
    Ok(())
}

fn verify_applied(plan: &MigrationPlan) -> Result<(), String> {
    let provider_set = plan.providers.iter().cloned().collect::<BTreeSet<_>>();
    for database in &plan.databases {
        if read_database_plan(database.path.clone())?
            .rows
            .iter()
            .any(|row| provider_set.contains(&row.provider))
        {
            return Err("数据库迁移验证失败".into());
        }
    }
    for file in scan_jsonl(&plan.codex_home, None)? {
        if file
            .assignments
            .iter()
            .any(|item| provider_set.contains(&item.provider))
        {
            return Err("JSONL 迁移验证失败".into());
        }
    }
    Ok(())
}

fn validate_metadata(metadata: &BackupMetadata, codex_home: &Path) -> Result<(), String> {
    if metadata.migration != MIGRATION_NAME
        || metadata.version != 4
        || metadata.codex_home != codex_home
    {
        return Err("备份不属于当前 Codex 数据目录或版本不受支持".into());
    }
    if !valid_provider(&metadata.target_provider)
        || is_builtin(&metadata.target_provider)
        || metadata.providers.is_empty()
    {
        return Err("备份中的 Provider 映射无效".into());
    }
    for provider in &metadata.providers {
        validate_source_provider(provider, Some(&metadata.target_provider))?;
    }
    let config = fs::read_to_string(codex_home.join("config.toml"))
        .ok()
        .and_then(|text| toml::from_str::<toml::Value>(&text).ok());
    for database in &metadata.databases {
        if !state_database_candidates(codex_home, config.as_ref()).contains(&database.target) {
            return Err("备份包含越界数据库目标".into());
        }
    }
    for file in &metadata.jsonl_files {
        assert_inside(&codex_home.join("sessions"), &file.target, "会话目标").or_else(|_| {
            assert_inside(
                &codex_home.join("archived_sessions"),
                &file.target,
                "归档会话目标",
            )
        })?;
    }
    Ok(())
}

fn read_backup_metadata(backup_dir: &Path) -> Result<BackupMetadata, String> {
    let metadata_value: Value = serde_json::from_reader(
        fs::File::open(backup_dir.join("metadata.json")).map_err(error_text)?,
    )
    .map_err(|error| format!("备份元数据无效：{error}"))?;
    if metadata_value.get("version").and_then(Value::as_u64) == Some(4) {
        return serde_json::from_value(metadata_value)
            .map_err(|error| format!("备份元数据无效：{error}"));
    }
    if metadata_value.get("version").and_then(Value::as_u64) != Some(3)
        || metadata_value.get("migration").and_then(Value::as_str) != Some(MIGRATION_NAME)
    {
        return Err("仅支持当前备份和旧版 v3 Provider 字段备份".into());
    }
    let manifest_relative = metadata_value
        .pointer("/manifest/backup")
        .and_then(Value::as_str)
        .unwrap_or("provider-manifest.json");
    let manifest_path = backup_dir.join(manifest_relative);
    assert_inside(backup_dir, &manifest_path, "Provider 清单")?;
    let manifest: Value =
        serde_json::from_reader(fs::File::open(&manifest_path).map_err(error_text)?)
            .map_err(|error| format!("旧版 Provider 清单无效：{error}"))?;
    if let Some(expected) = metadata_value
        .pointer("/manifest/hash")
        .and_then(Value::as_str)
    {
        if hash_file(&manifest_path)? != expected {
            return Err("旧版 Provider 清单校验失败".into());
        }
    }
    let mut rows_by_path = HashMap::new();
    for database in manifest
        .get("stateDatabases")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(path) = database.get("path").and_then(Value::as_str) else {
            continue;
        };
        let rows = serde_json::from_value::<Vec<ThreadAssignment>>(
            database
                .get("threads")
                .cloned()
                .unwrap_or_else(|| json!([])),
        )
        .map_err(|error| format!("旧版数据库 Provider 清单无效：{error}"))?;
        rows_by_path.insert(PathBuf::from(path), rows);
    }
    let mut databases = Vec::new();
    let mut jsonl_files = Vec::new();
    for asset in metadata_value
        .get("assets")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let kind = asset
            .get("kind")
            .and_then(Value::as_str)
            .ok_or_else(|| "旧版备份资源类型无效".to_string())?;
        let target = PathBuf::from(
            asset
                .get("target")
                .and_then(Value::as_str)
                .ok_or_else(|| "旧版备份目标无效".to_string())?,
        );
        let backup = PathBuf::from(
            asset
                .get("backup")
                .and_then(Value::as_str)
                .ok_or_else(|| "旧版备份路径无效".to_string())?,
        );
        let backup_path = backup_dir.join(&backup);
        assert_inside(backup_dir, &backup_path, "旧版备份资源")?;
        let hash = hash_file(&backup_path)?;
        match kind {
            "state_db" => databases.push(DatabaseBackup {
                rows: rows_by_path
                    .remove(&target)
                    .ok_or_else(|| "旧版数据库缺少 Provider 清单".to_string())?,
                target,
                backup,
                hash,
            }),
            "jsonl" => {
                let assignments = serde_json::from_value::<Vec<ProviderAssignment>>(
                    asset
                        .get("assignments")
                        .cloned()
                        .unwrap_or_else(|| json!([])),
                )
                .map_err(|error| format!("旧版 JSONL Provider 清单无效：{error}"))?;
                if assignments.is_empty() {
                    return Err("旧版 JSONL 备份缺少 Provider 清单".into());
                }
                jsonl_files.push(JsonlBackup {
                    target,
                    backup,
                    hash,
                    assignments,
                });
            }
            _ => return Err("旧版备份包含不支持的资源".into()),
        }
    }
    Ok(BackupMetadata {
        migration: MIGRATION_NAME.into(),
        version: 4,
        status: metadata_value
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("completed")
            .into(),
        created_at: metadata_value
            .get("createdAt")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .into(),
        codex_home: PathBuf::from(
            metadata_value
                .get("codexHome")
                .and_then(Value::as_str)
                .ok_or_else(|| "旧版备份缺少 Codex 目录".to_string())?,
        ),
        target_provider: metadata_value
            .get("targetProvider")
            .and_then(Value::as_str)
            .ok_or_else(|| "旧版备份缺少目标 Provider".to_string())?
            .into(),
        providers: serde_json::from_value(
            metadata_value
                .get("providers")
                .cloned()
                .unwrap_or_else(|| json!([])),
        )
        .map_err(error_text)?,
        plan_id: metadata_value
            .get("planId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .into(),
        databases,
        jsonl_files,
    })
}

fn write_metadata(backup_dir: &Path, metadata: &BackupMetadata) -> Result<(), String> {
    let content = serde_json::to_vec_pretty(metadata).map_err(error_text)?;
    atomic_write(&backup_dir.join("metadata.json"), &content)
}

fn atomic_write(path: &Path, content: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "目标路径没有父目录".to_string())?;
    fs::create_dir_all(parent).map_err(error_text)?;
    let temp = parent.join(format!(".allsessions-{}.tmp", Uuid::new_v4().simple()));
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temp)
        .map_err(error_text)?;
    file.write_all(content)
        .and_then(|_| file.sync_all())
        .map_err(error_text)?;
    fs::rename(&temp, path).map_err(error_text)
}

fn state_database_candidates(codex_home: &Path, config: Option<&toml::Value>) -> Vec<PathBuf> {
    let mut paths = vec![codex_home.join("state_5.sqlite")];
    let custom = config
        .and_then(|value| value.get("sqlite_home"))
        .and_then(toml::Value::as_str)
        .map(expand_user_path)
        .or_else(|| env::var_os("CODEX_SQLITE_HOME").map(PathBuf::from));
    if let Some(home) = custom {
        let path = home.join("state_5.sqlite");
        if !paths.contains(&path) {
            paths.push(path);
        }
    }
    paths
}

fn config_defines_provider(config: Option<&toml::Value>, provider: &str) -> bool {
    config
        .and_then(|value| value.get("model_providers"))
        .and_then(toml::Value::as_table)
        .is_some_and(|table| table.contains_key(provider))
}

fn require_closed_confirmation(body: &Value) -> Result<(), String> {
    if body.get("confirmedCodexAppClosed").and_then(Value::as_bool) == Some(true) {
        Ok(())
    } else {
        Err("必须确认 Codex App 已关闭".into())
    }
}

fn assert_codex_closed() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let output = Command::new("tasklist")
        .args(["/fo", "csv", "/nh"])
        .output()
        .map_err(error_text)?;
    #[cfg(not(target_os = "windows"))]
    let output = Command::new("ps")
        .args(["-axo", "comm="])
        .output()
        .map_err(error_text)?;
    let processes = String::from_utf8_lossy(&output.stdout);
    if contains_codex_process(&processes, cfg!(target_os = "windows")) {
        Err("检测到 Codex App 仍在运行，请完全退出后再执行".into())
    } else {
        Ok(())
    }
}

fn contains_codex_process(processes: &str, tasklist_csv: bool) -> bool {
    processes.lines().any(|line| {
        let name = if tasklist_csv {
            line.split(',')
                .next()
                .unwrap_or_default()
                .trim()
                .trim_matches('"')
        } else {
            Path::new(line.trim())
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
        };
        name.eq_ignore_ascii_case("codex") || name.eq_ignore_ascii_case("codex.exe")
    })
}

fn parse_providers(value: &str) -> Result<Vec<String>, String> {
    let providers = value
        .split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(ToOwned::to_owned)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    for provider in &providers {
        if !valid_provider(provider) {
            return Err(format!("Provider ID 无效：{provider}"));
        }
    }
    Ok(providers)
}

fn validate_source_provider(provider: &str, target: Option<&str>) -> Result<(), String> {
    if !valid_provider(provider) || is_protected(provider) || Some(provider) == target {
        Err(format!("拒绝迁移受保护的 Provider：{provider}"))
    } else {
        Ok(())
    }
}

fn valid_provider(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "_.:-".contains(character))
}

fn is_builtin(value: &str) -> bool {
    BUILTIN_PROVIDERS.contains(&value.to_ascii_lowercase().as_str())
}
fn is_protected(value: &str) -> bool {
    is_builtin(value) || value.eq_ignore_ascii_case("custom")
}
fn diagnostic(code: &str, message: impl Into<String>) -> Value {
    json!({ "code": code, "message": message.into() })
}
fn codex_home() -> PathBuf {
    env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .map(crate::sessions::expand_tilde)
        .or_else(|| dirs::home_dir().map(|home| home.join(".codex")))
        .unwrap_or_else(|| PathBuf::from(".codex"))
}
fn expand_user_path(value: &str) -> PathBuf {
    if value == "~" {
        dirs::home_dir().unwrap_or_default()
    } else if let Some(rest) = value.strip_prefix("~/") {
        dirs::home_dir().unwrap_or_default().join(rest)
    } else {
        PathBuf::from(value)
    }
}
fn hash_bytes(value: &str) -> String {
    hash_raw(value.as_bytes())
}
fn hash_raw(value: &[u8]) -> String {
    encode_hex(Sha256::digest(value))
}
fn hash_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(error_text)?;
    let mut hash = Sha256::new();
    std::io::copy(&mut file, &mut HashWriter(&mut hash)).map_err(error_text)?;
    Ok(encode_hex(hash.finalize()))
}
fn encode_hex(value: impl AsRef<[u8]>) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let bytes = value.as_ref();
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(DIGITS[(byte >> 4) as usize] as char);
        output.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    output
}
struct HashWriter<'a>(&'a mut Sha256);
impl Write for HashWriter<'_> {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        self.0.update(buffer);
        Ok(buffer.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
fn assert_inside(root: &Path, target: &Path, label: &str) -> Result<(), String> {
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let target = target
        .canonicalize()
        .unwrap_or_else(|_| target.to_path_buf());
    if target.starts_with(&root) && target != root {
        Ok(())
    } else {
        Err(format!("{label} 超出允许目录：{}", target.display()))
    }
}
fn error_text(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::{
        assignment_from_line, contains_codex_process, hash_raw, parse_providers, rewrite_jsonl,
        valid_provider, ProviderAssignment,
    };

    #[test]
    fn sha256_hash_remains_lowercase_hex() {
        assert_eq!(
            hash_raw(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn process_detection_parses_windows_tasklist_csv() {
        assert!(contains_codex_process(
            "\"Codex.exe\",\"1234\",\"Console\",\"1\",\"5,000 K\"",
            true
        ));
        assert!(!contains_codex_process(
            "\"Other.exe\",\"1234\",\"Console\",\"1\",\"5,000 K\"",
            true
        ));
        assert!(contains_codex_process(
            "/Applications/Codex.app/Contents/MacOS/Codex",
            false
        ));
    }

    #[test]
    fn provider_selection_is_unique_and_sorted() {
        assert_eq!(parse_providers("z,a,z").unwrap(), vec!["a", "z"]);
        assert!(valid_provider("openrouter:team.dev"));
        assert!(!valid_provider("bad provider"));
    }

    #[test]
    fn reads_only_codex_session_metadata() {
        let line = br#"{"type":"session_meta","payload":{"id":"s1","model_provider":"legacy"}}"#;
        let assignment = assignment_from_line(line, 3).unwrap();
        assert_eq!(assignment.line_number, 3);
        assert_eq!(assignment.provider, "legacy");
    }

    #[test]
    fn streaming_rewrite_changes_only_selected_metadata_line() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("session.jsonl");
        std::fs::write(&path, concat!(
            "{\"type\":\"session_meta\",\"payload\":{\"id\":\"s1\",\"model_provider\":\"legacy\"}}\n",
            "{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"keep me\"}}\n"
        )).unwrap();
        let assignments = vec![ProviderAssignment {
            line_number: 1,
            session_id: Some("s1".into()),
            provider: "legacy".into(),
        }];
        rewrite_jsonl(&path, &assignments, Some("current"), |_, _| {
            "current".into()
        })
        .unwrap();
        let updated = std::fs::read_to_string(&path).unwrap();
        assert!(updated
            .lines()
            .next()
            .unwrap()
            .contains("\"model_provider\":\"current\""));
        assert!(updated.contains("\"message\":\"keep me\""));
        rewrite_jsonl(&path, &assignments, Some("current"), |_, assignment| {
            assignment.provider.clone()
        })
        .unwrap();
        assert!(std::fs::read_to_string(&path)
            .unwrap()
            .contains("\"model_provider\":\"legacy\""));
    }
}
