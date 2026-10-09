//! 永久删除与安全写回:原子替换、按行删除、备份路径与删除类 Store 方法。
use std::collections::{BTreeSet, HashMap};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use uuid::Uuid;

use crate::error::ApiError;

use super::helpers::{error_text, read_only_source_error};
use super::parse::{json_fingerprint, parse_summary, ParseState};
use super::{gemini, DetailLocator, SessionStore, SourceFormat, StoredSession};

impl SessionStore {
    pub fn delete_session(&mut self, key: &str) -> Result<Value, ApiError> {
        let (resolved, record) = self.resolve_writable_record(key)?;
        let current_summary = if record.detail_locator.is_none() {
            let (summary, _) = parse_summary(&record.path, &record.source)?;
            if summary["_key"].as_str() != Some(resolved.as_str()) {
                return Err(ApiError::new(
                    ApiError::FILE_CHANGED,
                    "原始文件已经变化；请刷新列表后重试",
                ));
            }
            Some(summary)
        } else {
            None
        };
        let backup_paths = if let Some(locator) = &record.detail_locator {
            match locator {
                DetailLocator::Gemini(locator) => {
                    gemini::session_backup_paths(&record.source, locator)?
                }
                DetailLocator::OpenCode(_) => return Err(read_only_source_error()),
                DetailLocator::ZCode(_)
                | DetailLocator::Cursor(_)
                | DetailLocator::Devin(_)
                | DetailLocator::Hermes(_) => return Err(read_only_source_error()),
            }
        } else {
            session_backup_paths(&record.path)
        };
        let session_id = record.summary["id"].as_str().unwrap_or_default();
        let backup = crate::deletion_backup::create(
            "delete_session",
            record.source.kind,
            session_id,
            &backup_paths,
        )?;
        let deleted_files = if let Some(locator) = &record.detail_locator {
            match locator {
                DetailLocator::Gemini(locator) => gemini::delete_session(&record.source, locator)?,
                DetailLocator::OpenCode(_) => return Err(read_only_source_error()),
                DetailLocator::ZCode(_)
                | DetailLocator::Cursor(_)
                | DetailLocator::Devin(_)
                | DetailLocator::Hermes(_) => return Err(read_only_source_error()),
            }
        } else {
            if record.path.extension().and_then(|value| value.to_str()) == Some("json") {
                delete_legacy_session(
                    &record.path,
                    current_summary
                        .as_ref()
                        .and_then(|summary| summary["id"].as_str())
                        .unwrap_or_default(),
                )?
            } else {
                fs::remove_file(&record.path).map_err(|error| {
                    format!("无法删除会话文件（{}）：{error}", record.path.display())
                })?;
                1
            }
        };
        self.index_cache.remove(&record.path);
        self.refresh_after_mutation(&record, backup_paths)?;
        Ok(json!({ "ok": true, "deleted_files": deleted_files, "backup": backup }))
    }

    /// 删除/编辑后只重扫受影响的文件；跨文件来源（Gemini/Claude 等）
    /// 由 `refresh_paths` 自行回退到全量刷新。
    pub(crate) fn refresh_after_mutation(
        &mut self,
        record: &StoredSession,
        mut paths: Vec<PathBuf>,
    ) -> Result<(), String> {
        paths.push(record.path.clone());
        let paths = paths.into_iter().collect::<BTreeSet<_>>();
        if !self.refresh_paths(&paths)? {
            self.scan_diagnostics.touch();
            self.rebuild_summaries()?;
        }
        Ok(())
    }

    /// 解析会话键并拒绝只读来源，供删除类操作复用。
    fn resolve_writable_record(&self, key: &str) -> Result<(String, StoredSession), ApiError> {
        let resolved = self
            .resolve_record_key(key)
            .ok_or_else(|| ApiError::new(ApiError::SESSION_NOT_FOUND, "会话不存在或标识不唯一"))?;
        let record = self
            .records
            .get(&resolved)
            .cloned()
            .ok_or_else(|| ApiError::new(ApiError::SESSION_NOT_FOUND, "会话不存在"))?;
        if matches!(
            record.source.format,
            SourceFormat::Pi
                | SourceFormat::Grok
                | SourceFormat::Kimi
                | SourceFormat::OpenCode
                | SourceFormat::Kilo
                | SourceFormat::ZCode
                | SourceFormat::Cursor
                | SourceFormat::Devin
                | SourceFormat::Copilot
                | SourceFormat::Hermes
        ) {
            return Err(read_only_source_error());
        }
        Ok((resolved, record))
    }

    pub fn delete_message(&mut self, key: &str, message_key: &str) -> Result<Value, ApiError> {
        let (resolved, record) = self.resolve_writable_record(key)?;
        if matches!(
            record.source.format,
            SourceFormat::Pi
                | SourceFormat::Grok
                | SourceFormat::Kimi
                | SourceFormat::OpenCode
                | SourceFormat::Kilo
                | SourceFormat::ZCode
                | SourceFormat::Cursor
                | SourceFormat::Devin
                | SourceFormat::Copilot
                | SourceFormat::Hermes
        ) {
            return Err("该来源当前为只读模式；请在原 Agent 中删除消息".into());
        }
        let detail = self.detail(&resolved)?;
        let message = detail["conversation_messages"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|message| message["_message_key"].as_str() == Some(message_key))
            .ok_or_else(|| "消息不存在或当前详情未包含该消息".to_string())?;
        let delete_ref = message
            .get("_delete_ref")
            .cloned()
            .ok_or_else(|| ApiError::invalid("该消息不支持删除原始数据"))?;
        let backup_paths = if let Some(locator) = &record.detail_locator {
            match locator {
                DetailLocator::Gemini(locator) => {
                    gemini::message_backup_paths(&record.source, locator, &delete_ref)?
                }
                DetailLocator::OpenCode(_) => return Err(read_only_source_error()),
                DetailLocator::ZCode(_)
                | DetailLocator::Cursor(_)
                | DetailLocator::Devin(_)
                | DetailLocator::Hermes(_) => return Err(read_only_source_error()),
            }
        } else {
            message_backup_paths(&record.path, &delete_ref)?
        };
        let session_id = record.summary["id"].as_str().unwrap_or_default();
        let backup = crate::deletion_backup::create(
            "delete_message",
            record.source.kind,
            session_id,
            &backup_paths,
        )?;
        if let Some(locator) = &record.detail_locator {
            match locator {
                DetailLocator::Gemini(locator) => {
                    gemini::delete_message(&record.source, locator, &delete_ref)?;
                }
                DetailLocator::OpenCode(_) => return Err(read_only_source_error()),
                DetailLocator::ZCode(_)
                | DetailLocator::Cursor(_)
                | DetailLocator::Devin(_)
                | DetailLocator::Hermes(_) => return Err(read_only_source_error()),
            }
        } else if record.path.extension().and_then(|value| value.to_str()) == Some("json") {
            delete_legacy_message(&record.path, &delete_ref)?;
        } else {
            delete_jsonl_message(&record.path, &delete_ref)?;
        }
        self.index_cache.remove(&record.path);
        self.refresh_after_mutation(&record, backup_paths)?;
        Ok(json!({ "ok": true, "backup": backup }))
    }
}

pub(crate) fn replacement_path(path: &Path, suffix: &str) -> Result<PathBuf, String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("文件缺少父目录：{}", path.display()))?;
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| format!("文件名无效：{}", path.display()))?;
    Ok(parent.join(format!(".{name}.allsessions-{}.{suffix}", Uuid::new_v4())))
}

pub(crate) fn replace_file_contents(
    path: &Path,
    write_contents: impl FnOnce(&mut BufWriter<File>) -> Result<(), String>,
) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(error_text)?;
    if metadata.file_type().is_symlink() {
        return Err(format!("拒绝修改符号链接文件：{}", path.display()));
    }
    let temporary = replacement_path(path, "tmp")?;
    let result = (|| {
        let file = File::create(&temporary)
            .map_err(|error| format!("无法创建临时文件（{}）：{error}", temporary.display()))?;
        let mut writer = BufWriter::new(file);
        write_contents(&mut writer)?;
        writer.flush().map_err(error_text)?;
        writer.get_ref().sync_all().map_err(error_text)?;
        fs::set_permissions(&temporary, metadata.permissions()).map_err(error_text)?;

        #[cfg(not(windows))]
        {
            fs::rename(&temporary, path).map_err(|error| {
                format!(
                    "无法替换原始文件（{} → {}）：{error}",
                    temporary.display(),
                    path.display()
                )
            })?;
        }
        #[cfg(windows)]
        {
            let backup = replacement_path(path, "bak")?;
            fs::rename(path, &backup).map_err(error_text)?;
            if let Err(error) = fs::rename(&temporary, path) {
                let restore_error = fs::rename(&backup, path).err();
                return Err(match restore_error {
                    Some(restore_error) => {
                        format!("无法替换原始文件：{error}；恢复备份也失败：{restore_error}")
                    }
                    None => format!("无法替换原始文件，已恢复原文件：{error}"),
                });
            }
            fs::remove_file(&backup).map_err(|error| {
                format!(
                    "原文件已更新，但无法删除临时备份（{}）：{error}",
                    backup.display()
                )
            })?;
        }
        Ok(())
    })();
    if result.is_err() && temporary.exists() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

pub(crate) fn rewrite_jsonl_without_lines(
    path: &Path,
    removed_lines: &BTreeSet<usize>,
) -> Result<(), String> {
    replace_file_contents(path, |writer| {
        for (index, line) in BufReader::new(File::open(path).map_err(error_text)?)
            .lines()
            .enumerate()
        {
            let line = line.map_err(error_text)?;
            if removed_lines.contains(&(index + 1)) {
                continue;
            }
            writer.write_all(line.as_bytes()).map_err(error_text)?;
            writer.write_all(b"\n").map_err(error_text)?;
        }
        Ok(())
    })
}

pub(crate) fn delete_jsonl_message(path: &Path, delete_ref: &Value) -> Result<(), String> {
    if delete_ref["kind"].as_str() != Some("jsonl_record") {
        return Err("消息删除标识与会话格式不匹配".into());
    }
    let target_line = delete_ref["line_number"]
        .as_u64()
        .and_then(|value| usize::try_from(value).ok())
        .ok_or_else(|| "消息删除标识缺少有效行号".to_string())?;
    let target_index = delete_ref["message_index"]
        .as_u64()
        .and_then(|value| usize::try_from(value).ok())
        .ok_or_else(|| "消息删除标识缺少有效消息序号".to_string())?;
    let mut state = ParseState::new(path);
    let mut target_found = false;
    let mut target_tool_calls = BTreeSet::new();
    let mut tool_lines = HashMap::<String, BTreeSet<usize>>::new();
    for (index, line) in BufReader::new(File::open(path).map_err(error_text)?)
        .lines()
        .enumerate()
    {
        let line_number = index + 1;
        let line = line.map_err(error_text)?;
        let Ok(record) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let messages = state.accept(&record);
        let record_tool_calls = messages
            .iter()
            .filter(|message| message["role"].as_str() == Some("tool"))
            .filter_map(|message| message["tool_call_id"].as_str().map(ToOwned::to_owned))
            .collect::<BTreeSet<_>>();
        for (message_index, message) in messages.iter().enumerate() {
            if message["role"].as_str() == Some("tool") {
                if let Some(tool_call_id) = message["tool_call_id"].as_str() {
                    tool_lines
                        .entry(tool_call_id.to_string())
                        .or_default()
                        .insert(line_number);
                }
            }
            if line_number == target_line && message_index == target_index {
                let fingerprint = json_fingerprint(&record);
                if delete_ref["record_fingerprint"].as_str() != Some(fingerprint.as_str()) {
                    return Err("原始文件已经变化；请刷新详情后重试".into());
                }
                target_found = true;
                target_tool_calls.extend(record_tool_calls.iter().cloned());
            }
        }
    }
    if !target_found {
        return Err("原始文件已经变化，未找到要删除的消息；请刷新后重试".into());
    }
    let mut removed_lines = BTreeSet::from([target_line]);
    for tool_call_id in target_tool_calls {
        if let Some(lines) = tool_lines.get(&tool_call_id) {
            removed_lines.extend(lines);
        }
    }
    rewrite_jsonl_without_lines(path, &removed_lines)
}

pub(crate) fn delete_legacy_message(path: &Path, delete_ref: &Value) -> Result<(), String> {
    match delete_ref["kind"].as_str() {
        Some("legacy_entry") => {
            let entry_index = delete_ref["entry_index"]
                .as_u64()
                .and_then(|value| usize::try_from(value).ok())
                .ok_or_else(|| "消息删除标识缺少有效条目序号".to_string())?;
            let mut value: Value = serde_json::from_reader(File::open(path).map_err(error_text)?)
                .map_err(error_text)?;
            let entries = value["entries"]
                .as_array_mut()
                .ok_or_else(|| "旧版 Claude 会话不再包含 entries".to_string())?;
            if entry_index >= entries.len() {
                return Err("原始文件已经变化，未找到要删除的消息；请刷新后重试".into());
            }
            let fingerprint = json_fingerprint(&entries[entry_index]);
            if delete_ref["record_fingerprint"].as_str() != Some(fingerprint.as_str()) {
                return Err("原始文件已经变化；请刷新详情后重试".into());
            }
            entries.remove(entry_index);
            replace_file_contents(path, |writer| {
                serde_json::to_writer_pretty(&mut *writer, &value).map_err(error_text)?;
                writer.write_all(b"\n").map_err(error_text)
            })
        }
        Some("legacy_prompt") => {
            let mut value: Value = serde_json::from_reader(File::open(path).map_err(error_text)?)
                .map_err(error_text)?;
            let object = value
                .as_object_mut()
                .ok_or_else(|| "旧版 Claude 会话格式无效".to_string())?;
            let removed = if let Some(value) = object.remove("prompt") {
                value
            } else {
                object.remove("message").unwrap_or(Value::Null)
            };
            if removed.is_null() {
                return Err("原始文件已经变化，未找到要删除的消息；请刷新后重试".into());
            }
            let fingerprint = json_fingerprint(&removed);
            if delete_ref["record_fingerprint"].as_str() != Some(fingerprint.as_str()) {
                return Err("原始文件已经变化；请刷新详情后重试".into());
            }
            replace_file_contents(path, |writer| {
                serde_json::to_writer_pretty(&mut *writer, &value).map_err(error_text)?;
                writer.write_all(b"\n").map_err(error_text)
            })
        }
        Some("legacy_history") => {
            let line_number = delete_ref["line_number"]
                .as_u64()
                .and_then(|value| usize::try_from(value).ok())
                .ok_or_else(|| "消息删除标识缺少有效行号".to_string())?;
            let history_path = path
                .parent()
                .and_then(Path::parent)
                .map(|root| root.join("history.jsonl"))
                .ok_or_else(|| "无法确定旧版 Claude history 路径".to_string())?;
            let current_line = BufReader::new(File::open(&history_path).map_err(error_text)?)
                .lines()
                .nth(line_number.saturating_sub(1))
                .transpose()
                .map_err(error_text)?
                .ok_or_else(|| "原始文件已经变化，未找到要删除的消息".to_string())?;
            let current_record: Value = serde_json::from_str(&current_line).map_err(error_text)?;
            let fingerprint = json_fingerprint(&current_record);
            if delete_ref["record_fingerprint"].as_str() != Some(fingerprint.as_str()) {
                return Err("原始文件已经变化；请刷新详情后重试".into());
            }
            rewrite_jsonl_without_lines(&history_path, &BTreeSet::from([line_number]))
        }
        _ => Err("消息删除标识与旧版 Claude 格式不匹配".into()),
    }
}

pub(crate) fn legacy_history_path(path: &Path) -> Option<PathBuf> {
    path.parent()
        .and_then(Path::parent)
        .map(|root| root.join("history.jsonl"))
}

pub(crate) fn session_backup_paths(path: &Path) -> Vec<PathBuf> {
    let mut paths = vec![path.to_path_buf()];
    if path.extension().and_then(|value| value.to_str()) == Some("json") {
        if let Some(history) = legacy_history_path(path).filter(|value| value.is_file()) {
            paths.push(history);
        }
    }
    paths
}

pub(crate) fn message_backup_paths(
    path: &Path,
    delete_ref: &Value,
) -> Result<Vec<PathBuf>, String> {
    if delete_ref["kind"].as_str() == Some("legacy_history") {
        return legacy_history_path(path)
            .filter(|value| value.is_file())
            .map(|value| vec![value])
            .ok_or_else(|| "无法确定旧版 Claude history 路径".to_string());
    }
    Ok(vec![path.to_path_buf()])
}

pub(crate) fn delete_legacy_session(path: &Path, session_id: &str) -> Result<usize, String> {
    let history_path = legacy_history_path(path);
    let mut deleted_files = 1_usize;
    if let Some(history_path) = history_path.filter(|path| path.is_file()) {
        let mut removed_lines = BTreeSet::new();
        for (index, line) in BufReader::new(File::open(&history_path).map_err(error_text)?)
            .lines()
            .enumerate()
        {
            let line = line.map_err(error_text)?;
            let Ok(record) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if record
                .get("sessionId")
                .or_else(|| record.get("session_id"))
                .and_then(Value::as_str)
                == Some(session_id)
            {
                removed_lines.insert(index + 1);
            }
        }
        if !removed_lines.is_empty() {
            rewrite_jsonl_without_lines(&history_path, &removed_lines)?;
            deleted_files += 1;
        }
    }
    fs::remove_file(path)
        .map_err(|error| format!("无法删除会话文件（{}）：{error}", path.display()))?;
    Ok(deleted_files)
}
