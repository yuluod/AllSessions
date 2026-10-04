//! 跨模块共享的小工具:文本截断、筛选、分页、统计聚合与错误构造。
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::PathBuf;

use chrono::{SecondsFormat, Utc};
use serde_json::{json, Value};

use crate::error::ApiError;

use super::json_fingerprint;
use super::{Source, SourceFormat, PAGE_LIMIT};

/// 诊断逐条原因的展示上限；剩余条数由前端按 error_count 差值提示。
const DIAGNOSTIC_ENTRY_LIMIT: usize = 20;

pub(crate) fn diagnostic_entries(errors: &BTreeMap<(PathBuf, String), String>) -> Value {
    errors
        .iter()
        .take(DIAGNOSTIC_ENTRY_LIMIT)
        .map(|((path, id), message)| json!({ "path": path.to_string_lossy(), "session_id": id, "message": message }))
        .collect::<Vec<_>>()
        .into()
}
pub(crate) fn search_fingerprint(
    summary: &Value,
    search_text: &str,
    stamps: &[String],
    content_fingerprint: Option<&str>,
) -> String {
    // 普通文件来源保留旧格式，避免追加 null 导致已有索引全部失效。
    match content_fingerprint {
        Some(content) => json_fingerprint(&json!([summary, search_text, stamps, content])),
        None => json_fingerprint(&json!([summary, search_text, stamps])),
    }
}
pub(crate) fn compact_title(text: &str, limit: usize) -> String {
    let line = text
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or_default()
        .trim()
        .trim_start_matches('#')
        .trim_start_matches('>')
        .trim();
    compact(line, limit)
}
pub(crate) fn compact(text: &str, limit: usize) -> String {
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.chars().count() <= limit {
        normalized
    } else {
        normalized
            .chars()
            .take(limit.saturating_sub(3))
            .collect::<String>()
            + "..."
    }
}
pub(crate) fn is_synthetic_context(text: &str) -> bool {
    let value = text.trim_start().to_lowercase();
    [
        "<recommended_plugins",
        "<permissions instructions",
        "<app-context",
        "<collaboration_mode",
        "<environment_context",
        "<skills_instructions",
        "<apps_instructions",
        "<plugins_instructions",
        "# agents.md instructions",
        "# files mentioned by the user:",
    ]
    .iter()
    .any(|prefix| value.starts_with(prefix))
}
pub(crate) fn string_at(value: &Value, path: &[&str]) -> Option<String> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    current.as_str().map(ToOwned::to_owned)
}
pub(crate) fn nullable_string(value: &str) -> Value {
    if value.is_empty() {
        Value::Null
    } else {
        Value::String(value.into())
    }
}
pub(crate) fn timestamp_of(summary: &Value) -> &str {
    summary["last_timestamp"]
        .as_str()
        .or_else(|| summary["timestamp"].as_str())
        .unwrap_or_default()
}
/// 时间戳的本地日期键（YYYY-MM-DD），与前端 localDateKey 使用同一规则，
/// 避免带 Z/偏移的 UTC 时间戳在非 UTC 时区被拆到错误的日期。
/// 无法按 RFC3339 解析时回退到字符串前 10 位。
pub(crate) fn local_date_key(timestamp: &str) -> Option<String> {
    chrono::DateTime::parse_from_rfc3339(timestamp)
        .ok()
        .map(|parsed| {
            parsed
                .with_timezone(&chrono::Local)
                .format("%Y-%m-%d")
                .to_string()
        })
        .or_else(|| timestamp.get(..10).map(ToOwned::to_owned))
}
pub(crate) fn matches_filters(summary: &Value, query: &HashMap<String, String>) -> bool {
    for (name, field) in [
        ("provider", "model_provider"),
        ("source_kind", "source_kind"),
        ("cwd", "cwd"),
    ] {
        if let Some(expected) = query.get(name).filter(|value| !value.is_empty()) {
            if summary[field].as_str() != Some(expected) {
                return false;
            }
        }
    }
    if let Some(date) = query.get("date").filter(|value| !value.is_empty()) {
        let Some(key) = local_date_key(timestamp_of(summary)) else {
            return false;
        };
        if !key.starts_with(date.as_str()) {
            return false;
        }
    }
    if summary["archived"] == true && !bool_query(query, "show_codex_archived") {
        return false;
    }
    if summary["workspace"]["archived"] == true && !bool_query(query, "show_archived") {
        return false;
    }
    if summary["workspace"]["removed"] == true && !bool_query(query, "show_removed") {
        return false;
    }
    if bool_query(query, "favorite") && summary["workspace"]["favorite"] != true {
        return false;
    }
    if let Some(tag) = query.get("tag").filter(|value| !value.is_empty()) {
        let matches = summary["workspace"]["tags"]
            .as_array()
            .is_some_and(|tags| tags.iter().any(|value| value.as_str() == Some(tag)));
        if !matches {
            return false;
        }
    }
    if summary["hidden"] == true && !bool_query(query, "show_hidden") {
        return false;
    }
    true
}
pub(crate) fn bool_query(query: &HashMap<String, String>, key: &str) -> bool {
    matches!(query.get(key).map(String::as_str), Some("1" | "true"))
}
pub(crate) fn paginate(
    mut sessions: Vec<Value>,
    query: &HashMap<String, String>,
    mut base: Value,
) -> Value {
    if let Some(cursor) = query.get("cursor") {
        if let Some(index) = sessions
            .iter()
            .position(|summary| summary["_key"].as_str() == Some(cursor))
        {
            sessions = sessions.into_iter().skip(index + 1).collect();
        }
    }
    let limit = query
        .get("limit")
        .and_then(|value| value.parse().ok())
        .unwrap_or(PAGE_LIMIT)
        .clamp(1, 200);
    let has_more = sessions.len() > limit;
    sessions.truncate(limit);
    let next = has_more
        .then(|| {
            sessions
                .last()
                .and_then(|summary| summary["_key"].as_str())
                .map(ToOwned::to_owned)
        })
        .flatten();
    if let Some(object) = base.as_object_mut() {
        object.insert("sessions".into(), Value::Array(sessions));
        object.insert("has_more".into(), Value::Bool(has_more));
        object.insert(
            "next_cursor".into(),
            next.map(Value::String).unwrap_or(Value::Null),
        );
    }
    base
}
#[cfg(test)]
pub(crate) fn search_query_matches(text: &str, query: &str) -> bool {
    let text = text.to_lowercase();
    query
        .to_lowercase()
        .split_whitespace()
        .all(|term| text.contains(term))
}
pub(crate) fn insert_string(target: &mut BTreeSet<String>, value: &Value) {
    if let Some(value) = value.as_str().filter(|value| !value.is_empty()) {
        target.insert(value.into());
    }
}
pub(crate) fn increment(target: &mut HashMap<String, u64>, value: &Value) {
    if let Some(value) = value.as_str().filter(|value| !value.is_empty()) {
        *target.entry(value.into()).or_default() += 1;
    }
}
pub(crate) fn count_values(values: HashMap<String, u64>, limit: usize) -> Vec<Value> {
    let mut values = values.into_iter().collect::<Vec<_>>();
    values.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0)));
    values
        .into_iter()
        .take(limit)
        .map(|(label, count)| json!({ "label": label, "count": count }))
        .collect()
}
pub(crate) fn agent_kind(source_kind: &Value) -> Option<&str> {
    match source_kind.as_str()? {
        "codex_archived" => Some("codex"),
        "claude_code" => Some("claude"),
        "vscode_copilot" => Some("copilot"),
        value => Some(value),
    }
}

/// VS Code 打开 Copilot Chat 面板就会生成空会话文件；
/// 没有消息的占位会话不进入列表。
pub(crate) fn is_placeholder_session(source: &Source, summary: &Value) -> bool {
    matches!(source.format, SourceFormat::VsCodeCopilot)
        && summary["message_count"].as_u64() == Some(0)
}
pub(crate) fn diagnostic_source_kind(kind: &str) -> &str {
    match kind {
        "claude_code" => "claude",
        value => value,
    }
}
pub(crate) fn scan_timestamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}
pub(crate) fn read_only_source_error() -> ApiError {
    ApiError::new(
        ApiError::READ_ONLY_SOURCE,
        "该来源当前为只读模式；请在原 Agent 中删除会话",
    )
}

pub(crate) fn error_text(error: impl std::fmt::Display) -> String {
    error.to_string()
}
