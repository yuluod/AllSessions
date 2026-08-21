use std::{
    cmp::Ordering,
    collections::{BTreeMap, BTreeSet, HashMap},
    fmt,
    fs::{self, File},
    io::{BufReader, Read, Write},
    path::{Path, PathBuf},
};

use serde::de::{DeserializeSeed, Deserializer, SeqAccess, Visitor};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use walkdir::WalkDir;

use super::{
    append_limited, attach_message_delete_ref, error_text, json_fingerprint, legacy_timestamp,
    nullable_string, replace_file_contents, truncate_message, HeadTail, ParseState, Source,
    DETAIL_EVENT_LIMIT, DETAIL_MESSAGE_LIMIT, DETAIL_TEXT_LIMIT, SEARCH_TEXT_LIMIT,
};
use crate::cache::IndexCache;

const GEMINI_CACHE_KIND: &str = "gemini_file_v1";
const MIN_DUPLICATE_PREFIX_CHARS: usize = 16;

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
    duplicate_user_keys: BTreeSet<DuplicateUserKey>,
    summary: Value,
}

#[derive(Clone, Eq, PartialEq, Ord, PartialOrd)]
struct DuplicateUserKey {
    value: String,
    prefix_matches: bool,
}

impl DuplicateUserKey {
    fn from_text(text: &str) -> Self {
        let prefix = user_prefix(text);
        if prefix.chars().count() < MIN_DUPLICATE_PREFIX_CHARS {
            Self {
                value: text.to_string(),
                prefix_matches: false,
            }
        } else {
            Self {
                value: prefix,
                prefix_matches: true,
            }
        }
    }

    fn matches_text(&self, text: &str) -> bool {
        if self.prefix_matches {
            text.contains(self.value.as_str())
        } else {
            text == self.value
        }
    }

    fn to_json(&self) -> Value {
        json!({ "value": self.value, "prefix_matches": self.prefix_matches })
    }

    fn from_json(value: &Value) -> Option<Self> {
        Some(Self {
            value: value.get("value")?.as_str()?.to_string(),
            prefix_matches: value.get("prefix_matches")?.as_bool()?,
        })
    }
}

fn duplicate_keys_from_json(value: &Value) -> Option<BTreeSet<DuplicateUserKey>> {
    value
        .as_array()?
        .iter()
        .map(DuplicateUserKey::from_json)
        .collect()
}

fn user_prefix(text: &str) -> String {
    text.chars().take(80).collect()
}

fn compare_timestamps(left: &str, right: &str) -> Ordering {
    match (
        chrono::DateTime::parse_from_rfc3339(left).ok(),
        chrono::DateTime::parse_from_rfc3339(right).ok(),
    ) {
        (Some(left), Some(right)) => left.cmp(&right),
        _ => left.cmp(right),
    }
}

type RecordKey = (i64, String, usize);

struct OrderedRecordWindow {
    head: BTreeMap<RecordKey, (Value, PathBuf, usize)>,
    tail: BTreeMap<RecordKey, (Value, PathBuf, usize)>,
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

    fn push(&mut self, key: RecordKey, record: Value, path: PathBuf, record_index: usize) {
        self.total += 1;
        let head_limit = DETAIL_EVENT_LIMIT.div_ceil(2);
        let tail_limit = DETAIL_EVENT_LIMIT / 2;
        self.head
            .insert(key.clone(), (record.clone(), path.clone(), record_index));
        if self.head.len() > head_limit {
            self.head.pop_last();
        }
        self.tail.insert(key, (record, path, record_index));
        if self.tail.len() > tail_limit {
            self.tail.pop_first();
        }
    }

    fn finish(mut self) -> (Vec<(Value, PathBuf, usize)>, usize) {
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
    let mut path_identities = BTreeSet::new();
    paths
        .into_iter()
        .filter(|path| path_identities.insert(super::path_identity(path)))
        .collect()
}

fn parse_file_contributions(
    path: &Path,
    source: &Source,
    brain_messages: &BTreeMap<String, Vec<BrainMessage>>,
) -> Result<Vec<Value>, String> {
    let mut states = HashMap::<String, ParseState>::new();
    let mut duplicate_keys = HashMap::<String, BTreeSet<DuplicateUserKey>>::new();
    visit_log_records(path, |record| {
        let Some(session_id) = record.get("sessionId").and_then(Value::as_str) else {
            return;
        };
        let state = states
            .entry(session_id.to_string())
            .or_insert_with(|| ParseState::new(path));
        let messages = state.accept(&record);
        let Some(artifacts) = brain_messages.get(session_id) else {
            return;
        };
        for message in messages {
            if message["role"].as_str() != Some("user") {
                continue;
            }
            let Some(text) = message["text"].as_str() else {
                continue;
            };
            for artifact in artifacts {
                if artifact.role != "user" {
                    continue;
                }
                let key = DuplicateUserKey::from_text(&artifact.text);
                if key.matches_text(text) {
                    duplicate_keys
                        .entry(session_id.to_string())
                        .or_default()
                        .insert(key);
                }
            }
        }
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
                "duplicate_user_keys": duplicate_keys
                    .get(&session_id)
                    .map(|keys| keys.iter().map(DuplicateUserKey::to_json).collect::<Vec<_>>())
                    .unwrap_or_default(),
            })
        })
        .collect())
}

fn cached_file_contributions(
    path: &Path,
    source: &Source,
    cache: &IndexCache,
    brain_messages: &BTreeMap<String, Vec<BrainMessage>>,
    cache_kind: &str,
) -> Result<Vec<Value>, String> {
    let metadata = fs::metadata(path).map_err(error_text)?;
    if let Some(cached) = cache.get(path, cache_kind, &metadata) {
        if let Some(contributions) = cached.summary["contributions"].as_array() {
            let mut restored = Vec::with_capacity(contributions.len());
            for contribution in contributions {
                let mut contribution = contribution.clone();
                let has_user_artifacts = contribution["session_id"]
                    .as_str()
                    .and_then(|session_id| brain_messages.get(session_id))
                    .is_some_and(|messages| messages.iter().any(|message| message.role == "user"));
                let keys = if has_user_artifacts {
                    duplicate_keys_from_json(&contribution["duplicate_user_keys"])
                        .ok_or_else(|| "Gemini 缓存缺少 artifact 去重字段".to_string())?
                } else {
                    BTreeSet::new()
                };
                contribution["duplicate_user_keys"] =
                    Value::Array(keys.iter().map(DuplicateUserKey::to_json).collect());
                restored.push(contribution);
            }
            return Ok(restored);
        }
    }

    let contributions = parse_file_contributions(path, source, brain_messages)?;
    cache.put(
        path,
        cache_kind,
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
        let path = summary["file_path"]
            .as_str()
            .filter(|value| !value.is_empty());
        if let Some(path) = path {
            self.paths.insert(PathBuf::from(path));
        }
        let timestamp = summary["timestamp"].as_str().unwrap_or_default();
        if !timestamp.is_empty()
            && (self.state.timestamp.is_empty()
                || compare_timestamps(timestamp, &self.state.timestamp) == Ordering::Less)
        {
            self.state.timestamp = timestamp.to_string();
            if let Some(path) = path {
                self.path = PathBuf::from(path);
            }
        }
        let last_timestamp = summary["last_timestamp"].as_str().unwrap_or_default();
        if compare_timestamps(last_timestamp, &self.state.last_timestamp) == Ordering::Greater {
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

    fn finish(
        self,
        source: &Source,
        duplicate_user_keys: BTreeSet<DuplicateUserKey>,
    ) -> ParsedSession {
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
                duplicate_user_keys,
                summary,
            },
        }
    }
}

pub(super) fn parse_source(source: &Source, cache: &IndexCache) -> Result<ParsedSource, String> {
    let brain_messages = collect_brain_messages(&source.root);
    let cache_kind = gemini_cache_kind(&brain_messages);
    let paths = log_paths(source);
    let active_paths = paths
        .iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect();
    let mut grouped = HashMap::<String, Vec<Value>>::new();

    for path in paths {
        match cached_file_contributions(&path, source, cache, &brain_messages, &cache_kind) {
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
            compare_timestamps(
                left["summary"]["timestamp"].as_str().unwrap_or_default(),
                right["summary"]["timestamp"].as_str().unwrap_or_default(),
            )
            .then_with(|| {
                left["summary"]["file_path"]
                    .as_str()
                    .cmp(&right["summary"]["file_path"].as_str())
            })
        });
        let initial_path = contributions
            .iter()
            .filter_map(|value| value["summary"]["file_path"].as_str())
            .find(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| source.root.clone());
        let mut merged = MergedSession::new(&session_id, initial_path);
        let mut duplicate_user_keys = BTreeSet::new();
        for contribution in &contributions {
            merged.merge(contribution);
            let keys = duplicate_keys_from_json(&contribution["duplicate_user_keys"])
                .ok_or_else(|| "Gemini 缓存缺少 artifact 去重字段".to_string())?;
            duplicate_user_keys.extend(keys);
        }
        if let Some(messages) = brain_messages.get(&session_id) {
            for message in messages {
                if message.role == "user"
                    && duplicate_user_keys.contains(&DuplicateUserKey::from_text(&message.text))
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
        }
        sessions.push(merged.finish(source, duplicate_user_keys));
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
        let mut record_index = 0_usize;
        if let Err(error) = visit_log_records(log_path, |record| {
            let current_record_index = record_index;
            record_index += 1;
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
            ordered_records.push(
                (message_id, timestamp, sequence),
                record,
                log_path.clone(),
                current_record_index,
            );
            sequence += 1;
        }) {
            eprintln!("无法解析 Gemini 日志（{}）：{error}", log_path.display());
        }
    }
    let (ordered_records, omitted_records) = ordered_records.finish();
    for (index, (record, log_path, record_index)) in ordered_records.into_iter().enumerate() {
        for (message_index, mut message) in state.accept(&record).into_iter().enumerate() {
            attach_message_delete_ref(
                &mut message,
                json!({
                    "kind": "gemini_log",
                    "path": log_path.to_string_lossy(),
                    "record_index": record_index,
                    "message_index": message_index,
                    "record_fingerprint": json_fingerprint(&record),
                }),
            );
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
        |role, text, timestamp, subtype, artifact_path| {
            let duplicate_key = DuplicateUserKey::from_text(text);
            if role == "user" && locator.duplicate_user_keys.contains(&duplicate_key) {
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
                attach_message_delete_ref(
                    &mut accepted,
                    json!({
                        "kind": "gemini_artifact",
                        "path": artifact_path.to_string_lossy(),
                        "content_fingerprint": json_fingerprint(&Value::String(text.to_string())),
                    }),
                );
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

fn rewrite_log_file(
    path: &Path,
    mut should_remove: impl FnMut(usize, &Value) -> bool,
) -> Result<usize, String> {
    let mut removed = 0_usize;
    replace_file_contents(path, |writer| {
        writer.write_all(b"[").map_err(error_text)?;
        let mut first = true;
        let mut record_index = 0_usize;
        let mut write_error = None;
        visit_log_records(path, |record| {
            let current = record_index;
            record_index += 1;
            if should_remove(current, &record) {
                removed += 1;
                return;
            }
            if write_error.is_some() {
                return;
            }
            let result = (|| {
                if !first {
                    writer.write_all(b",")?;
                }
                serde_json::to_writer(&mut *writer, &record)?;
                first = false;
                Ok::<(), std::io::Error>(())
            })();
            if let Err(error) = result {
                write_error = Some(error.to_string());
            }
        })?;
        if let Some(error) = write_error {
            return Err(error);
        }
        writer.write_all(b"]\n").map_err(error_text)
    })?;
    Ok(removed)
}

fn locator_log_path(locator: &DetailLocator, value: &Value) -> Result<PathBuf, String> {
    let requested = value
        .as_str()
        .map(PathBuf::from)
        .ok_or_else(|| "Gemini 消息删除标识缺少日志路径".to_string())?;
    locator
        .paths
        .iter()
        .find(|path| super::path_identity(path) == super::path_identity(&requested))
        .cloned()
        .ok_or_else(|| "消息不属于当前 Gemini 会话".to_string())
}

pub(super) fn delete_session(source: &Source, locator: &DetailLocator) -> Result<usize, String> {
    let brain_dir = brain_session_dir(source, &locator.session_id)?;
    let mut deleted_files = 0_usize;
    for path in &locator.paths {
        let removed = rewrite_log_file(path, |_, record| {
            record.get("sessionId").and_then(Value::as_str) == Some(locator.session_id.as_str())
        })?;
        if removed > 0 {
            deleted_files += 1;
        }
    }
    if brain_dir.exists() {
        let metadata = fs::symlink_metadata(&brain_dir).map_err(error_text)?;
        if metadata.file_type().is_symlink() {
            fs::remove_file(&brain_dir).map_err(error_text)?;
        } else {
            fs::remove_dir_all(&brain_dir).map_err(error_text)?;
        }
        deleted_files += 1;
    }
    if deleted_files == 0 {
        return Err("原始文件已经变化，未找到要删除的 Gemini 会话".into());
    }
    Ok(deleted_files)
}

pub(super) fn delete_message(
    source: &Source,
    locator: &DetailLocator,
    delete_ref: &Value,
) -> Result<(), String> {
    let brain_dir = brain_session_dir(source, &locator.session_id)?;
    match delete_ref["kind"].as_str() {
        Some("gemini_log") => {
            let path = locator_log_path(locator, &delete_ref["path"])?;
            let record_index = delete_ref["record_index"]
                .as_u64()
                .and_then(|value| usize::try_from(value).ok())
                .ok_or_else(|| "Gemini 消息删除标识缺少记录序号".to_string())?;
            let removed = rewrite_log_file(&path, |index, record| {
                index == record_index
                    && record.get("sessionId").and_then(Value::as_str)
                        == Some(locator.session_id.as_str())
                    && delete_ref["record_fingerprint"].as_str()
                        == Some(json_fingerprint(record).as_str())
            })?;
            if removed != 1 {
                return Err("原始文件已经变化，未找到要删除的消息；请刷新后重试".into());
            }
            Ok(())
        }
        Some("gemini_artifact") => {
            let path = delete_ref["path"]
                .as_str()
                .map(PathBuf::from)
                .ok_or_else(|| "Gemini artifact 删除标识缺少路径".to_string())?;
            if !path.starts_with(&brain_dir) || path == brain_dir {
                return Err("消息不属于当前 Gemini artifact 目录".into());
            }
            let metadata = fs::symlink_metadata(&path).map_err(|error| {
                format!("无法读取 Gemini artifact（{}）：{error}", path.display())
            })?;
            if !metadata.file_type().is_file() {
                return Err("Gemini artifact 已变化或不是普通文件".into());
            }
            let current = read_text_limited(&path, DETAIL_TEXT_LIMIT)
                .ok_or_else(|| "无法读取 Gemini artifact".to_string())?;
            let fingerprint = json_fingerprint(&Value::String(current.trim().to_string()));
            if delete_ref["content_fingerprint"].as_str() != Some(fingerprint.as_str()) {
                return Err("原始文件已经变化；请刷新详情后重试".into());
            }
            fs::remove_file(&path)
                .map_err(|error| format!("无法删除 Gemini artifact（{}）：{error}", path.display()))
        }
        _ => Err("消息删除标识与 Gemini 格式不匹配".into()),
    }
}

fn collect_brain_messages(root: &Path) -> BTreeMap<String, Vec<BrainMessage>> {
    let brain_root = root.join("antigravity").join("brain");
    let Ok(entries) = fs::read_dir(&brain_root) else {
        return BTreeMap::new();
    };
    let mut session_ids = entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|file_type| file_type.is_dir()))
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|session_id| valid_session_id(session_id))
        .collect::<BTreeSet<_>>();

    let mut messages_by_session = BTreeMap::new();
    while let Some(session_id) = session_ids.pop_last() {
        let mut messages = Vec::new();
        visit_brain_messages(
            root,
            &session_id,
            |role, text, timestamp, subtype, _artifact_path| {
                messages.push(BrainMessage {
                    role: role.into(),
                    text: text.into(),
                    timestamp: timestamp.into(),
                    subtype: subtype.into(),
                });
            },
        );
        if !messages.is_empty() {
            messages_by_session.insert(session_id, messages);
        }
    }
    messages_by_session
}

fn gemini_cache_kind(brain_messages: &BTreeMap<String, Vec<BrainMessage>>) -> String {
    let has_user_artifacts = brain_messages
        .values()
        .flatten()
        .any(|message| message.role == "user");
    if !has_user_artifacts {
        return GEMINI_CACHE_KIND.to_string();
    }

    let mut hasher = Sha256::new();
    for (session_id, messages) in brain_messages {
        hasher.update(session_id.as_bytes());
        hasher.update([0]);
        for message in messages {
            if message.role != "user" {
                continue;
            }
            let key = DuplicateUserKey::from_text(&message.text);
            hasher.update(key.value.as_bytes());
            hasher.update([u8::from(key.prefix_matches)]);
            hasher.update([0]);
        }
    }
    let digest = hasher.finalize();
    let fingerprint = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("{GEMINI_CACHE_KIND}:{fingerprint}")
}

fn valid_session_id(session_id: &str) -> bool {
    let mut components = Path::new(session_id).components();
    !session_id.is_empty()
        && matches!(components.next(), Some(std::path::Component::Normal(_)))
        && components.next().is_none()
        && !session_id
            .chars()
            .any(|value| matches!(value, '/' | '\\' | ':'))
}

fn brain_session_dir(source: &Source, session_id: &str) -> Result<PathBuf, String> {
    if !valid_session_id(session_id) {
        return Err("Gemini 会话标识无效，拒绝删除原始数据".into());
    }
    let brain_root = source.root.join("antigravity").join("brain");
    let session_dir = brain_root.join(session_id);
    if session_dir.parent() != Some(brain_root.as_path()) {
        return Err("Gemini 会话目录超出允许范围，拒绝删除原始数据".into());
    }
    Ok(session_dir)
}

fn visit_brain_messages(
    root: &Path,
    session_id: &str,
    mut callback: impl FnMut(&str, &str, &str, &str, &Path),
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
            callback("user", prompt, &timestamp, "artifact", &entry.path());
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
    callback: &mut impl FnMut(&str, &str, &str, &str, &Path),
) {
    let Some(text) = read_text_limited(path, DETAIL_TEXT_LIMIT) else {
        return;
    };
    let text = text.trim();
    if !text.is_empty() {
        callback("assistant", text, "", artifact_name, path);
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
    use std::{io::Write, path::PathBuf};

    use serde_json::{json, Value};
    use tempfile::tempdir;

    use super::{delete_message, delete_session, parse_detail, parse_source};
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
    fn 永久删除消息和会话不会影响共享日志中的其他会话() {
        let directory = tempdir().unwrap();
        let log_dir = directory.path().join("tmp").join("queue");
        std::fs::create_dir_all(&log_dir).unwrap();
        let log_path = log_dir.join("logs.json");
        std::fs::write(
            &log_path,
            json!([
                { "sessionId": "g1", "messageId": 1, "type": "user", "message": "删除消息" },
                { "sessionId": "g1", "messageId": 2, "type": "assistant", "message": "删除会话" },
                { "sessionId": "g2", "messageId": 1, "type": "user", "message": "必须保留" }
            ])
            .to_string(),
        )
        .unwrap();
        let source = source(directory.path());
        let cache = IndexCache::open_at(&directory.path().join("index.sqlite"));
        let parsed = parse_source(&source, &cache).unwrap();
        let session = parsed
            .sessions
            .iter()
            .find(|session| session.summary["id"] == "g1")
            .unwrap();
        let detail = parse_detail(&source, &session.detail_locator).unwrap();
        let delete_ref = detail["conversation_messages"][0]["_delete_ref"].clone();

        delete_message(&source, &session.detail_locator, &delete_ref).unwrap();
        let after_message: Value =
            serde_json::from_str(&std::fs::read_to_string(&log_path).unwrap()).unwrap();
        assert!(!after_message
            .as_array()
            .unwrap()
            .iter()
            .any(|record| record["message"] == "删除消息"));
        assert!(after_message
            .as_array()
            .unwrap()
            .iter()
            .any(|record| record["message"] == "必须保留"));

        delete_session(&source, &session.detail_locator).unwrap();
        let after_session: Value =
            serde_json::from_str(&std::fs::read_to_string(&log_path).unwrap()).unwrap();
        assert!(after_session
            .as_array()
            .unwrap()
            .iter()
            .all(|record| record["sessionId"] != "g1"));
        assert!(after_session
            .as_array()
            .unwrap()
            .iter()
            .any(|record| record["sessionId"] == "g2"));
    }

    #[test]
    fn 永久删除拒绝越出_brain_根目录的会话标识() {
        let directory = tempdir().unwrap();
        let gemini_root = directory.path().join("gemini");
        let log_dir = gemini_root.join("tmp").join("queue");
        let outside = directory.path().join("outside");
        std::fs::create_dir_all(&log_dir).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("sentinel.txt"), "必须保留").unwrap();
        let log_path = log_dir.join("logs.json");
        let session_id = outside.to_string_lossy().into_owned();
        std::fs::write(
            &log_path,
            json!([{ "sessionId": session_id, "messageId": 1, "type": "user", "message": "问题" }])
                .to_string(),
        )
        .unwrap();
        let source = source(&gemini_root);
        let parsed = parse_source(&source, &IndexCache::disabled()).unwrap();

        assert!(delete_session(&source, &parsed.sessions[0].detail_locator).is_err());
        assert!(outside.join("sentinel.txt").is_file());
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
    fn 空文件路径不会覆盖主路径() {
        let mut merged = super::MergedSession::new("g1", PathBuf::from("/primary/logs.json"));
        merged.merge(&json!({
            "summary": {
                "timestamp": "2026-01-01T00:00:00Z",
                "last_timestamp": "2026-01-01T00:00:00Z",
                "file_path": ""
            },
            "search_text": ""
        }));

        assert_eq!(merged.path, PathBuf::from("/primary/logs.json"));
    }

    #[test]
    fn 跨文件时间戳按实际时间排序() {
        let directory = tempdir().unwrap();
        let lexical_earlier = directory.path().join("tmp").join("a");
        let actual_earlier = directory.path().join("tmp").join("z");
        std::fs::create_dir_all(&lexical_earlier).unwrap();
        std::fs::create_dir_all(&actual_earlier).unwrap();
        std::fs::write(
            lexical_earlier.join("logs.json"),
            json!([{ "sessionId": "g1", "messageId": 2, "timestamp": "2026-01-01T01:00:00Z", "type": "assistant", "message": "晚一小时" }])
                .to_string(),
        )
        .unwrap();
        std::fs::write(
            actual_earlier.join("logs.json"),
            json!([{ "sessionId": "g1", "messageId": 1, "timestamp": "2026-01-01T08:00:00+08:00", "type": "user", "message": "实际更早" }])
                .to_string(),
        )
        .unwrap();

        let parsed = parse_source(&source(directory.path()), &IndexCache::disabled()).unwrap();
        assert_eq!(
            parsed.sessions[0].summary["file_path"],
            actual_earlier.join("logs.json").to_string_lossy().as_ref()
        );
    }

    #[test]
    fn brain提示变化后缓存去重结果失效() {
        let directory = tempdir().unwrap();
        let log_dir = directory.path().join("tmp").join("queue");
        let brain_dir = directory
            .path()
            .join("antigravity")
            .join("brain")
            .join("g1");
        std::fs::create_dir_all(&log_dir).unwrap();
        std::fs::create_dir_all(&brain_dir).unwrap();
        std::fs::write(
            log_dir.join("logs.json"),
            json!([{ "sessionId": "g1", "messageId": 1, "type": "user", "message": "原始提示" }])
                .to_string(),
        )
        .unwrap();
        std::fs::write(brain_dir.join("prompt"), "原始提示").unwrap();
        let cache = IndexCache::open_at(&directory.path().join("index.sqlite"));

        let first = parse_source(&source(directory.path()), &cache).unwrap();
        assert_eq!(first.sessions[0].summary["message_count"], 1);

        std::fs::write(brain_dir.join("prompt"), "新的提示").unwrap();
        let second = parse_source(&source(directory.path()), &cache).unwrap();
        assert_eq!(second.sessions[0].summary["message_count"], 2);
    }

    #[test]
    fn 短brain提示只在完整相同时去重() {
        let directory = tempdir().unwrap();
        let log_dir = directory.path().join("tmp").join("queue");
        let brain_dir = directory
            .path()
            .join("antigravity")
            .join("brain")
            .join("g1");
        std::fs::create_dir_all(&log_dir).unwrap();
        std::fs::create_dir_all(&brain_dir).unwrap();
        std::fs::write(
            log_dir.join("logs.json"),
            json!([{ "sessionId": "g1", "messageId": 1, "type": "user", "message": "请继续执行" }])
                .to_string(),
        )
        .unwrap();
        std::fs::write(brain_dir.join("prompt"), "继续").unwrap();

        let parsed = parse_source(&source(directory.path()), &IndexCache::disabled()).unwrap();
        assert_eq!(parsed.sessions[0].summary["message_count"], 2);
        let detail = parse_detail(
            &source(directory.path()),
            &parsed.sessions[0].detail_locator,
        )
        .unwrap();
        assert_eq!(
            detail["conversation_messages"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|message| message["source_type"].as_str() == Some("artifact"))
                .count(),
            1
        );
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
