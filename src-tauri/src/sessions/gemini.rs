use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    fmt,
    fs::{self, File},
    io::{BufReader, Read},
    path::{Path, PathBuf},
};

use serde::de::{DeserializeSeed, Deserializer, SeqAccess, Visitor};
use serde_json::{json, Value};
use walkdir::WalkDir;

use super::{
    append_limited, conversation_messages, error_text, legacy_timestamp, nullable_string,
    truncate_message, HeadTail, ParseState, Source, DETAIL_EVENT_LIMIT, DETAIL_MESSAGE_LIMIT,
    DETAIL_TEXT_LIMIT, SEARCH_TEXT_LIMIT,
};
use crate::cache::IndexCache;

const GEMINI_CACHE_KIND: &str = "gemini_file_v1";

pub(super) struct ParsedSource {
    pub sessions: Vec<ParsedSession>,
    pub active_paths: BTreeSet<String>,
}

pub(super) struct ParsedSession {
    pub summary: Value,
    pub search_text: String,
    pub path: PathBuf,
    pub detail_locator: DetailLocator,
}

struct BrainMessage {
    role: String,
    text: String,
    timestamp: String,
    subtype: String,
}

#[derive(Clone)]
pub(super) struct DetailLocator {
    session_id: String,
    primary_path: PathBuf,
    paths: Vec<PathBuf>,
    duplicate_user_prefixes: BTreeSet<String>,
    summary: Value,
}

fn user_prefix(text: &str) -> String {
    text.chars().take(80).collect()
}

type RecordKey = (i64, String, usize);

struct OrderedRecordWindow {
    head: BTreeMap<RecordKey, Value>,
    tail: BTreeMap<RecordKey, Value>,
    total: usize,
}

impl OrderedRecordWindow {
    fn new() -> Self {
        Self {
            head: BTreeMap::new(),
            tail: BTreeMap::new(),
            total: 0,
        }
    }

    fn push(&mut self, key: RecordKey, record: Value) {
        self.total += 1;
        let head_limit = DETAIL_EVENT_LIMIT.div_ceil(2);
        let tail_limit = DETAIL_EVENT_LIMIT / 2;
        self.head.insert(key.clone(), record.clone());
        if self.head.len() > head_limit {
            self.head.pop_last();
        }
        self.tail.insert(key, record);
        if self.tail.len() > tail_limit {
            self.tail.pop_first();
        }
    }

    fn finish(mut self) -> (Vec<Value>, usize) {
        self.head.append(&mut self.tail);
        let omitted = self.total.saturating_sub(self.head.len());
        (self.head.into_values().collect(), omitted)
    }
}

struct RecordArraySeed<'a, F> {
    callback: &'a mut F,
}

impl<'de, F> DeserializeSeed<'de> for RecordArraySeed<'_, F>
where
    F: FnMut(Value),
{
    type Value = ();

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_seq(RecordArrayVisitor {
            callback: self.callback,
        })
    }
}

struct RecordArrayVisitor<'a, F> {
    callback: &'a mut F,
}

impl<'de, F> Visitor<'de> for RecordArrayVisitor<'_, F>
where
    F: FnMut(Value),
{
    type Value = ();

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Gemini logs.json 顶层数组")
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        while let Some(record) = sequence.next_element::<Value>()? {
            (self.callback)(record);
        }
        Ok(())
    }
}

fn visit_log_records(path: &Path, mut callback: impl FnMut(Value)) -> Result<(), String> {
    let file = File::open(path).map_err(error_text)?;
    let mut deserializer = serde_json::Deserializer::from_reader(BufReader::new(file));
    RecordArraySeed {
        callback: &mut callback,
    }
    .deserialize(&mut deserializer)
    .map_err(error_text)
}

fn log_paths(source: &Source) -> Vec<PathBuf> {
    let mut paths = WalkDir::new(source.root.join("tmp"))
        .max_depth(3)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file() && entry.file_name() == "logs.json")
        .map(|entry| entry.into_path())
        .collect::<Vec<_>>();
    paths.sort();
    paths
}

fn parse_file_contributions(path: &Path, source: &Source) -> Result<Vec<Value>, String> {
    let mut states = HashMap::<String, ParseState>::new();
    visit_log_records(path, |record| {
        let Some(session_id) = record.get("sessionId").and_then(Value::as_str) else {
            return;
        };
        states
            .entry(session_id.to_string())
            .or_insert_with(|| ParseState::new(path))
            .accept(&record);
    })?;

    Ok(states
        .into_iter()
        .map(|(session_id, state)| {
            let summary = state.summary(path, source);
            json!({
                "session_id": session_id,
                "summary": summary,
                "search_text": state.search_text,
                "first_user": state.first_user,
                "first_assistant": state.first_assistant,
                "first_message": state.first_message,
                "saw_primary": state.saw_primary,
            })
        })
        .collect())
}

fn cached_file_contributions(
    path: &Path,
    source: &Source,
    cache: &IndexCache,
) -> Result<Vec<Value>, String> {
    let metadata = fs::metadata(path).map_err(error_text)?;
    if let Some(cached) = cache.get(path, GEMINI_CACHE_KIND, &metadata) {
        if let Some(contributions) = cached.summary["contributions"].as_array() {
            return Ok(contributions.clone());
        }
    }

    let contributions = parse_file_contributions(path, source)?;
    cache.put(
        path,
        GEMINI_CACHE_KIND,
        &metadata,
        &json!({ "contributions": contributions }),
        "",
    );
    Ok(contributions)
}

struct MergedSession {
    path: PathBuf,
    paths: BTreeSet<PathBuf>,
    state: ParseState,
}

impl MergedSession {
    fn new(session_id: &str, path: PathBuf) -> Self {
        let mut state = ParseState::new(&path);
        state.id = session_id.to_string();
        Self {
            path,
            paths: BTreeSet::new(),
            state,
        }
    }

    fn merge(&mut self, contribution: &Value) {
        let summary = &contribution["summary"];
        if let Some(path) = summary["file_path"]
            .as_str()
            .filter(|value| !value.is_empty())
        {
            self.paths.insert(PathBuf::from(path));
        }
        let timestamp = summary["timestamp"].as_str().unwrap_or_default();
        if !timestamp.is_empty()
            && (self.state.timestamp.is_empty() || timestamp < self.state.timestamp.as_str())
        {
            self.state.timestamp = timestamp.to_string();
            self.path = PathBuf::from(summary["file_path"].as_str().unwrap_or_default());
        }
        let last_timestamp = summary["last_timestamp"].as_str().unwrap_or_default();
        if last_timestamp > self.state.last_timestamp.as_str() {
            self.state.last_timestamp = last_timestamp.to_string();
        }
        if let Some(cwd) = summary["cwd"].as_str().filter(|value| !value.is_empty()) {
            self.state.cwd = cwd.to_string();
        }
        if let Some(provider) = summary["model_provider"]
            .as_str()
            .filter(|value| !value.is_empty() && *value != "unknown")
        {
            self.state.provider = provider.to_string();
        }
        if let Some(originator) = summary["originator"]
            .as_str()
            .filter(|value| !value.is_empty())
        {
            self.state.originator = originator.to_string();
        }
        self.state.event_count += summary["event_count"].as_u64().unwrap_or_default() as usize;
        self.state.message_count += summary["message_count"].as_u64().unwrap_or_default();
        self.state.context_count += summary["context_count"].as_u64().unwrap_or_default();
        if let Some(roles) = summary["role_counts"].as_object() {
            for (role, count) in roles {
                *self.state.roles.entry(role.clone()).or_default() +=
                    count.as_u64().unwrap_or_default();
            }
        }
        if self.state.first_user.is_empty() {
            self.state.first_user = contribution["first_user"]
                .as_str()
                .unwrap_or_default()
                .to_string();
        }
        if self.state.first_assistant.is_empty() {
            self.state.first_assistant = contribution["first_assistant"]
                .as_str()
                .unwrap_or_default()
                .to_string();
        }
        if self.state.first_message.is_empty() {
            self.state.first_message = contribution["first_message"]
                .as_str()
                .unwrap_or_default()
                .to_string();
        }
        self.state.saw_primary |= contribution["saw_primary"].as_bool() == Some(true);
        append_limited(
            &mut self.state.search_text,
            &[contribution["search_text"].as_str().unwrap_or_default()],
            SEARCH_TEXT_LIMIT,
        );
    }

    fn add_brain_message(&mut self, role: &str, text: &str, timestamp: &str, subtype: &str) {
        let message = json!({
            "role": role,
            "text": text,
            "timestamp": nullable_string(timestamp),
            "source_type": "artifact",
            "source_subtype": subtype,
            "synthetic_context": false,
        });
        self.state.accept_message(message);
    }

    fn finish(self, source: &Source, duplicate_user_prefixes: BTreeSet<String>) -> ParsedSession {
        let summary = self.state.summary(&self.path, source);
        let primary_path = self.path;
        ParsedSession {
            summary: summary.clone(),
            search_text: self.state.search_text,
            path: primary_path.clone(),
            detail_locator: DetailLocator {
                session_id: self.state.id,
                primary_path,
                paths: self.paths.into_iter().collect(),
                duplicate_user_prefixes,
                summary,
            },
        }
    }
}

pub(super) fn parse_source(source: &Source, cache: &IndexCache) -> Result<ParsedSource, String> {
    let paths = log_paths(source);
    let active_paths = paths
        .iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect();
    let mut grouped = HashMap::<String, Vec<Value>>::new();

    for path in paths {
        match cached_file_contributions(&path, source, cache) {
            Ok(contributions) => {
                for contribution in contributions {
                    if let Some(session_id) = contribution["session_id"].as_str() {
                        grouped
                            .entry(session_id.to_string())
                            .or_default()
                            .push(contribution);
                    }
                }
            }
            Err(error) => eprintln!("无法解析 Gemini 日志（{}）：{error}", path.display()),
        }
    }

    let mut sessions = Vec::with_capacity(grouped.len());
    for (session_id, mut contributions) in grouped {
        contributions.sort_by(|left, right| {
            left["summary"]["timestamp"]
                .as_str()
                .cmp(&right["summary"]["timestamp"].as_str())
        });
        let initial_path = contributions
            .first()
            .and_then(|value| value["summary"]["file_path"].as_str())
            .map(PathBuf::from)
            .unwrap_or_else(|| source.root.clone());
        let mut merged = MergedSession::new(&session_id, initial_path);
        for contribution in &contributions {
            merged.merge(contribution);
        }
        let mut brain_messages = Vec::new();
        visit_brain_messages(
            &source.root,
            &session_id,
            |role, text, timestamp, subtype| {
                brain_messages.push(BrainMessage {
                    role: role.into(),
                    text: text.into(),
                    timestamp: timestamp.into(),
                    subtype: subtype.into(),
                });
            },
        );
        let duplicate_user_prefixes =
            duplicate_user_prefixes(&merged.paths, &session_id, &brain_messages);
        for message in brain_messages {
            if message.role == "user"
                && duplicate_user_prefixes.contains(&user_prefix(&message.text))
            {
                continue;
            }
            merged.add_brain_message(
                &message.role,
                &message.text,
                &message.timestamp,
                &message.subtype,
            );
        }
        sessions.push(merged.finish(source, duplicate_user_prefixes));
    }

    Ok(ParsedSource {
        sessions,
        active_paths,
    })
}

pub(super) fn parse_detail(source: &Source, locator: &DetailLocator) -> Result<Value, String> {
    let path = if locator.primary_path.as_os_str().is_empty() {
        locator.paths.first().cloned().unwrap_or_else(|| {
            source
                .root
                .join("tmp")
                .join(&locator.session_id)
                .join("logs.json")
        })
    } else {
        locator.primary_path.clone()
    };
    let mut state = ParseState::new(&path);
    state.id = locator.session_id.clone();
    let mut messages = HeadTail::new(DETAIL_MESSAGE_LIMIT);
    let mut events = HeadTail::new(DETAIL_EVENT_LIMIT);
    let mut ordered_records = OrderedRecordWindow::new();
    let mut sequence = 0_usize;

    for log_path in &locator.paths {
        if let Err(error) = visit_log_records(log_path, |record| {
            if record.get("sessionId").and_then(Value::as_str) != Some(locator.session_id.as_str())
            {
                return;
            }
            let message_id = record
                .get("messageId")
                .and_then(Value::as_i64)
                .unwrap_or_default();
            let timestamp = record
                .get("timestamp")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            ordered_records.push((message_id, timestamp, sequence), record);
            sequence += 1;
        }) {
            eprintln!("无法解析 Gemini 日志（{}）：{error}", log_path.display());
        }
    }
    let (ordered_records, omitted_records) = ordered_records.finish();
    for (index, record) in ordered_records.into_iter().enumerate() {
        for mut message in state.accept(&record) {
            truncate_message(&mut message);
            messages.push(message);
        }
        let serialized_size = serde_json::to_string(&record)
            .map(|value| value.chars().count())
            .unwrap_or_default();
        let payload = if serialized_size > 10_000 {
            json!({ "truncated": true, "original_chars": serialized_size })
        } else {
            record.clone()
        };
        events.push(json!({
            "line_number": index + 1,
            "timestamp": record.get("timestamp").cloned().unwrap_or(Value::Null),
            "type": record.get("type").and_then(Value::as_str).unwrap_or("unknown"),
            "payload": payload,
        }));
    }

    visit_brain_messages(
        &source.root,
        &locator.session_id,
        |role, text, timestamp, subtype| {
            let prefix = user_prefix(text);
            if role == "user"
                && !prefix.is_empty()
                && locator.duplicate_user_prefixes.contains(&prefix)
            {
                return;
            }
            let message = json!({
                "role": role,
                "text": text,
                "timestamp": nullable_string(timestamp),
                "source_type": "artifact",
                "source_subtype": subtype,
                "synthetic_context": false,
            });
            if let Some(mut accepted) = state.accept_message(message) {
                truncate_message(&mut accepted);
                messages.push(accepted);
            }
        },
    );

    let (mut message_values, window_omitted_messages, window_total_messages) =
        messages.finish(json!({
            "role": "system",
            "text": "",
            "timestamp": Value::Null,
            "source_type": "viewer",
            "source_subtype": "truncation",
            "is_truncation_marker": true,
        }));
    let expected_messages = locator.summary["message_count"]
        .as_u64()
        .unwrap_or_default()
        .saturating_add(
            locator.summary["context_count"]
                .as_u64()
                .unwrap_or_default(),
        ) as usize;
    let total_messages = expected_messages.max(window_total_messages);
    let retained_messages = message_values
        .iter()
        .filter(|value| value["is_truncation_marker"] != true)
        .count();
    let omitted_messages = total_messages
        .saturating_sub(retained_messages)
        .max(window_omitted_messages);
    if omitted_messages > 0 {
        if !message_values
            .iter()
            .any(|value| value["is_truncation_marker"] == true)
        {
            message_values.insert(
                message_values.len().div_ceil(2),
                json!({
                    "role": "system",
                    "text": "",
                    "timestamp": Value::Null,
                    "source_type": "viewer",
                    "source_subtype": "truncation",
                    "is_truncation_marker": true,
                }),
            );
        }
        if let Some(marker) = message_values
            .iter_mut()
            .find(|value| value["is_truncation_marker"] == true)
        {
            marker["omitted_count"] = json!(omitted_messages);
        }
    }
    let (mut event_values, window_omitted_events, _) = events.finish(json!({
        "line_number": Value::Null,
        "timestamp": Value::Null,
        "type": "viewer_truncation",
        "payload": { "omitted_events": 0 },
    }));
    let total_events = locator.summary["event_count"].as_u64().unwrap_or_default() as usize;
    let omitted_events = omitted_records.saturating_add(window_omitted_events);
    if omitted_events > 0 {
        if !event_values
            .iter()
            .any(|value| value["type"] == "viewer_truncation")
        {
            event_values.insert(
                event_values.len().div_ceil(2),
                json!({
                    "line_number": Value::Null,
                    "timestamp": Value::Null,
                    "type": "viewer_truncation",
                    "payload": { "omitted_events": omitted_events },
                }),
            );
        } else if let Some(marker) = event_values
            .iter_mut()
            .find(|value| value["type"] == "viewer_truncation")
        {
            marker["payload"]["omitted_events"] = json!(omitted_events);
        }
    }
    let mut summary = locator.summary.clone();
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

fn duplicate_user_prefixes(
    paths: &BTreeSet<PathBuf>,
    session_id: &str,
    brain_messages: &[BrainMessage],
) -> BTreeSet<String> {
    let prefixes = brain_messages
        .iter()
        .filter(|message| message.role == "user")
        .map(|message| user_prefix(&message.text))
        .filter(|prefix| !prefix.is_empty())
        .collect::<Vec<_>>();
    if prefixes.is_empty() {
        return BTreeSet::new();
    }

    let mut duplicates = BTreeSet::new();
    let mut tool_names = HashMap::new();
    for path in paths {
        let result = visit_log_records(path, |record: Value| {
            if record.get("sessionId").and_then(Value::as_str) != Some(session_id) {
                return;
            }
            let timestamp = record
                .get("timestamp")
                .and_then(Value::as_str)
                .unwrap_or_default();
            for message in conversation_messages(&record, timestamp, &mut tool_names) {
                if message["role"].as_str() != Some("user") {
                    continue;
                }
                let Some(text) = message["text"].as_str() else {
                    continue;
                };
                for prefix in &prefixes {
                    if text.contains(prefix.as_str()) {
                        duplicates.insert(prefix.clone());
                    }
                }
            }
        });
        if let Err(error) = result {
            eprintln!("无法解析 Gemini 日志（{}）：{error}", path.display());
        }
    }
    duplicates
}

fn valid_session_id(session_id: &str) -> bool {
    !session_id.is_empty()
        && !matches!(session_id, "." | "..")
        && !session_id
            .chars()
            .any(|value| matches!(value, '/' | '\\' | ':'))
}

fn visit_brain_messages(
    root: &Path,
    session_id: &str,
    mut callback: impl FnMut(&str, &str, &str, &str),
) {
    if !valid_session_id(session_id) {
        return;
    }
    let brain_dir = root.join("antigravity").join("brain").join(session_id);
    let Ok(entries) = fs::read_dir(&brain_dir) else {
        return;
    };
    let mut entries = entries.flatten().collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.ends_with(".metadata.json")
            || name.ends_with(".resolved")
            || name.to_ascii_lowercase().starts_with("uploaded_")
        {
            continue;
        }
        let prompt = read_text_limited(&entry.path(), DETAIL_TEXT_LIMIT).unwrap_or_default();
        let prompt = prompt.trim();
        if !prompt.is_empty() {
            let timestamp =
                read_text_limited(&brain_dir.join(format!("{name}.metadata.json")), 16_384)
                    .and_then(|content| serde_json::from_str::<Value>(&content).ok())
                    .and_then(|metadata| legacy_timestamp(&metadata, &["updatedAt"]))
                    .unwrap_or_default();
            callback("user", prompt, &timestamp, "artifact");
        }

        let resolved_path = brain_dir.join(format!("{name}.resolved"));
        visit_resolved(&resolved_path, &name, &mut callback);
        for index in 0.. {
            let fragment = PathBuf::from(format!("{}.{}", resolved_path.display(), index));
            if !fragment.is_file() {
                break;
            }
            visit_resolved(&fragment, &name, &mut callback);
        }
    }
}

fn visit_resolved(
    path: &Path,
    artifact_name: &str,
    callback: &mut impl FnMut(&str, &str, &str, &str),
) {
    let Some(text) = read_text_limited(path, DETAIL_TEXT_LIMIT) else {
        return;
    };
    let text = text.trim();
    if !text.is_empty() {
        callback("assistant", text, "", artifact_name);
    }
}

fn read_text_limited(path: &Path, char_limit: usize) -> Option<String> {
    let mut bytes = Vec::new();
    File::open(path)
        .ok()?
        .take((char_limit.saturating_mul(4).saturating_add(1)) as u64)
        .read_to_end(&mut bytes)
        .ok()?;
    Some(
        String::from_utf8_lossy(&bytes)
            .chars()
            .take(char_limit)
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use serde_json::json;
    use tempfile::tempdir;

    use super::{parse_detail, parse_source};
    use crate::{
        cache::IndexCache,
        sessions::{Source, SourceFormat, DETAIL_EVENT_LIMIT, DETAIL_MESSAGE_LIMIT},
    };

    fn source(root: &Path) -> Source {
        Source {
            kind: "gemini",
            display_name: "Gemini CLI",
            root: root.into(),
            format: SourceFormat::Gemini,
            archived: false,
        }
    }

    use std::path::Path;

    #[test]
    fn 流式扫描并按需生成详情() {
        let directory = tempdir().unwrap();
        let log_dir = directory.path().join("tmp").join("queue");
        std::fs::create_dir_all(&log_dir).unwrap();
        std::fs::write(
            log_dir.join("logs.json"),
            json!([
                { "sessionId": "g1", "messageId": 1, "type": "user", "message": "问题" },
                { "sessionId": "g1", "messageId": 2, "type": "assistant", "message": "回答" }
            ])
            .to_string(),
        )
        .unwrap();

        let cache = IndexCache::open_at(&directory.path().join("index.sqlite"));
        let parsed = parse_source(&source(directory.path()), &cache).unwrap();
        assert_eq!(parsed.sessions.len(), 1);
        assert_eq!(parsed.sessions[0].summary["message_count"], 2);
        let metadata = std::fs::metadata(log_dir.join("logs.json")).unwrap();
        let cached = cache
            .get(
                &log_dir.join("logs.json"),
                super::GEMINI_CACHE_KIND,
                &metadata,
            )
            .unwrap();
        assert_eq!(cached.summary["contributions"].as_array().unwrap().len(), 1);

        let detail = parse_detail(
            &source(directory.path()),
            &parsed.sessions[0].detail_locator,
        )
        .unwrap();
        assert_eq!(detail["conversation_messages"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn 超大详情保持首尾有界() {
        let directory = tempdir().unwrap();
        let log_dir = directory.path().join("tmp").join("queue");
        std::fs::create_dir_all(&log_dir).unwrap();
        let path = log_dir.join("logs.json");
        let mut file = std::fs::File::create(&path).unwrap();
        write!(file, "[").unwrap();
        for index in 0..(DETAIL_EVENT_LIMIT + 200) {
            if index > 0 {
                write!(file, ",").unwrap();
            }
            write!(
                file,
                "{}",
                json!({
                    "sessionId": "large",
                    "messageId": index,
                    "type": "user",
                    "message": format!("message-{index}")
                })
            )
            .unwrap();
        }
        write!(file, "]").unwrap();

        let parsed = parse_source(&source(directory.path()), &IndexCache::disabled()).unwrap();
        let detail = parse_detail(
            &source(directory.path()),
            &parsed.sessions[0].detail_locator,
        )
        .unwrap();
        assert!(
            detail["conversation_messages"].as_array().unwrap().len() <= DETAIL_MESSAGE_LIMIT + 1
        );
        assert!(detail["raw_events"].as_array().unwrap().len() <= DETAIL_EVENT_LIMIT + 1);
        let messages = detail["conversation_messages"].as_array().unwrap();
        assert_eq!(messages.first().unwrap()["text"], "message-0");
        assert_eq!(
            messages.last().unwrap()["text"],
            format!("message-{}", DETAIL_EVENT_LIMIT + 199)
        );
        assert_eq!(detail["summary"]["detail_truncated"], true);
    }

    #[test]
    fn 大会话详情不会重复显示brain用户消息() {
        let directory = tempdir().unwrap();
        let log_dir = directory.path().join("tmp").join("large");
        let brain_dir = directory
            .path()
            .join("antigravity")
            .join("brain")
            .join("large");
        std::fs::create_dir_all(&log_dir).unwrap();
        std::fs::create_dir_all(&brain_dir).unwrap();
        let path = log_dir.join("logs.json");
        let total = DETAIL_EVENT_LIMIT + 200;
        let duplicated_index = DETAIL_EVENT_LIMIT + 100;
        let mut file = std::fs::File::create(&path).unwrap();
        write!(file, "[").unwrap();
        for index in 0..total {
            if index > 0 {
                write!(file, ",").unwrap();
            }
            write!(
                file,
                "{}",
                json!({
                    "sessionId": "large",
                    "messageId": index,
                    "type": "user",
                    "message": format!("message-{index}")
                })
            )
            .unwrap();
        }
        write!(file, "]").unwrap();
        std::fs::write(
            brain_dir.join("prompt"),
            format!("message-{duplicated_index}"),
        )
        .unwrap();

        let source = source(directory.path());
        let parsed = parse_source(&source, &IndexCache::disabled()).unwrap();
        let session = parsed
            .sessions
            .iter()
            .find(|session| session.detail_locator.session_id == "large")
            .unwrap();
        assert_eq!(session.summary["message_count"], total as u64);

        let detail = parse_detail(&source, &session.detail_locator).unwrap();
        let messages = detail["conversation_messages"].as_array().unwrap();
        assert_eq!(
            messages
                .iter()
                .filter(|message| {
                    message["source_type"].as_str() == Some("artifact")
                        && message["role"].as_str() == Some("user")
                })
                .count(),
            0
        );
        assert_eq!(detail["truncation"]["messages"]["omitted"], 600);
    }

    #[test]
    fn 跨文件详情按消息编号排序且只读取相关日志() {
        let directory = tempdir().unwrap();
        let unrelated_dir = directory.path().join("tmp").join("0-unrelated");
        let later_dir = directory.path().join("tmp").join("a-later");
        let earlier_dir = directory.path().join("tmp").join("z-earlier");
        for path in [&unrelated_dir, &later_dir, &earlier_dir] {
            std::fs::create_dir_all(path).unwrap();
        }
        std::fs::write(
            unrelated_dir.join("logs.json"),
            json!([{ "sessionId": "other", "messageId": 1, "type": "user", "message": "无关" }])
                .to_string(),
        )
        .unwrap();
        std::fs::write(
            later_dir.join("logs.json"),
            json!([{ "sessionId": "g1", "messageId": 2, "timestamp": "2026-01-01T00:00:02Z", "type": "assistant", "message": "第二条" }]).to_string(),
        )
        .unwrap();
        std::fs::write(
            earlier_dir.join("logs.json"),
            json!([{ "sessionId": "g1", "messageId": 1, "timestamp": "2026-01-01T00:00:01Z", "type": "user", "message": "第一条" }]).to_string(),
        )
        .unwrap();

        let source = source(directory.path());
        let parsed = parse_source(&source, &IndexCache::disabled()).unwrap();
        let session = parsed
            .sessions
            .iter()
            .find(|session| session.detail_locator.session_id == "g1")
            .unwrap();
        assert_eq!(session.detail_locator.paths.len(), 2);
        assert!(!session
            .detail_locator
            .paths
            .contains(&unrelated_dir.join("logs.json")));

        let detail = parse_detail(&source, &session.detail_locator).unwrap();
        let messages = detail["conversation_messages"].as_array().unwrap();
        assert_eq!(messages[0]["text"], "第一条");
        assert_eq!(messages[1]["text"], "第二条");
        assert_eq!(
            detail["summary"]["file_path"],
            earlier_dir.join("logs.json").to_string_lossy().as_ref()
        );
    }
}
