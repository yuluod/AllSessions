use std::{
    cmp::Ordering,
    collections::{BTreeMap, BTreeSet, HashMap},
    ffi::OsStr,
    fmt,
    fs::{self, File},
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
};

use serde::de::{DeserializeSeed, Deserializer, SeqAccess, Visitor};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use walkdir::WalkDir;

use super::{
    append_limited, attach_message_delete_ref, attach_message_key, error_text, extract_text,
    json_fingerprint, legacy_timestamp, message_value, nullable_string, replace_file_contents,
    truncate_message, HeadTail, ParseState, Source, DETAIL_EVENT_LIMIT, DETAIL_MESSAGE_LIMIT,
    DETAIL_TEXT_LIMIT, SEARCH_TEXT_LIMIT,
};
use crate::cache::IndexCache;

const GEMINI_CACHE_KIND: &str = "gemini_file_v1";
const GEMINI_CHAT_CACHE_KIND: &str = "gemini_chat_v2";
const MIN_DUPLICATE_PREFIX_CHARS: usize = 16;
// 旧版 chats/session-*.json 是单个 ConversationRecord 对象，无法逐行流式解析；
// 读取时限制字节数，超限文件报错而不是无界占用内存。
const CHAT_JSON_BYTES: u64 = 64 * 1024 * 1024;
// JSONL 回放的内存上限：单行（含 `$set.messages` 整段检查点）与累计保留的
// 消息字节数。超限时明确报错，避免大文件在扫描、索引和详情回放时无界驻留。
const CHAT_LINE_BYTES: usize = 16 * 1024 * 1024;
const CHAT_RETAIN_BYTES: usize = 64 * 1024 * 1024;

pub(super) struct ParsedSource {
    pub sessions: Vec<ParsedSession>,
    pub active_paths: BTreeSet<String>,
    pub errors: Vec<(PathBuf, String)>,
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
pub(crate) struct DetailLocator {
    session_id: String,
    primary_path: PathBuf,
    /// 共享 logs.json 中包含该会话记录的文件；chats 优先的会话里这些文件
    /// 不参与展示，但永久删除与备份仍要覆盖其中的会话副本。
    paths: Vec<PathBuf>,
    /// v0.61+ chats/session-* 回放文件；非空时详情与搜索都以它为准。
    chat_paths: Vec<PathBuf>,
    /// 被同主名 .jsonl 隐藏的旧版 .json 副本，会话独占，删除时一并移除。
    shadowed_chat_paths: Vec<PathBuf>,
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

/// Gemini CLI v0.61+ 的完整会话记录：`tmp/<projectHash>/chats/session-*.json[l]`。
/// 只匹配 chats 目录直接子层的 `session-` 前缀文件；子代理会话嵌套在
/// `chats/<parentShortId>/` 下且不带该前缀，不在主会话列表出现。
/// 返回（活跃文件，活跃 .jsonl → 被其隐藏的同主名旧版 .json）。
/// 隐藏的旧文件仍属于同一会话，永久删除与备份必须覆盖。
fn chat_paths(source: &Source) -> (Vec<PathBuf>, BTreeMap<PathBuf, PathBuf>) {
    let mut paths = WalkDir::new(source.root.join("tmp"))
        .max_depth(3)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| {
            entry.file_type().is_file()
                && entry
                    .path()
                    .parent()
                    .is_some_and(|parent| parent.file_name() == Some(OsStr::new("chats")))
                && entry.file_name().to_string_lossy().starts_with("session-")
        })
        .map(|entry| entry.into_path())
        .collect::<Vec<_>>();
    // 旧版 .json 与迁移后的 .jsonl 同主名并存时只回放 .jsonl，避免同一会话重复计数。
    let mut jsonl_by_key = HashMap::new();
    for path in &paths {
        if path.extension().and_then(|value| value.to_str()) == Some("jsonl") {
            jsonl_by_key.insert(chat_file_key(path), path.clone());
        }
    }
    let mut shadowed = BTreeMap::new();
    paths.retain(|path| {
        if path.extension().and_then(|value| value.to_str()) == Some("json") {
            if let Some(jsonl) = jsonl_by_key.get(&chat_file_key(path)) {
                shadowed.insert(jsonl.clone(), path.clone());
                return false;
            }
        }
        true
    });
    paths.sort();
    let mut path_identities = BTreeSet::new();
    let active = paths
        .into_iter()
        .filter(|path| path_identities.insert(super::path_identity(path)))
        .collect();
    (active, shadowed)
}

fn chat_file_key(path: &Path) -> (Option<PathBuf>, std::ffi::OsString) {
    (
        path.parent().map(Path::to_path_buf),
        path.file_stem().unwrap_or_default().to_os_string(),
    )
}

/// 从上游 chatRecordingService 回放规则转写：
/// - 元数据行（含 `sessionId`）合并标量字段，`messages` 数组是完整快照，直接替换；
/// - `{"$set": ...}` 元数据补丁同样合并，`$set.messages` 是检查点（清空后重建）；
/// - `{"$rewindTo": id}` 删除该消息及其后的全部消息，找不到时清空；
/// - 其余含 `id` + `type` 的行是消息记录，按 id 原位更新（upsert 保持插入顺序）。
///
/// 单行解析失败按上游行为忽略。
#[derive(Default)]
struct ReplayedChat {
    session_id: String,
    start_time: String,
    last_updated: String,
    directories: Vec<String>,
    kind: String,
    messages: Vec<Value>,
    message_ids: HashMap<String, usize>,
    message_bytes: Vec<usize>,
    retained_bytes: usize,
}

impl ReplayedChat {
    fn merge_metadata(&mut self, record: &Value) -> Result<(), String> {
        if let Some(value) = record.get("sessionId").and_then(Value::as_str) {
            self.session_id = value.into();
        }
        if let Some(value) = record.get("startTime").and_then(Value::as_str) {
            self.start_time = value.into();
        }
        if let Some(value) = record.get("lastUpdated").and_then(Value::as_str) {
            self.last_updated = value.into();
        }
        if let Some(value) = record.get("kind").and_then(Value::as_str) {
            self.kind = value.into();
        }
        if let Some(list) = record.get("directories").and_then(Value::as_array) {
            self.directories = list
                .iter()
                .filter_map(Value::as_str)
                .map(String::from)
                .collect();
        }
        if let Some(messages) = record.get("messages").and_then(Value::as_array) {
            self.replace_messages(messages.iter().cloned())?;
        }
        Ok(())
    }

    fn replace_messages(&mut self, messages: impl Iterator<Item = Value>) -> Result<(), String> {
        self.messages.clear();
        self.message_bytes.clear();
        self.message_ids.clear();
        self.retained_bytes = 0;
        for record in messages {
            let (bytes, total) = self.check_message_size(&record, 0)?;
            self.messages.push(record);
            self.message_bytes.push(bytes);
            self.retained_bytes = total;
        }
        self.rebuild_ids();
        Ok(())
    }

    // 以当前保留消息的序列化字节数计量；替换时扣除旧消息，避免累计历史写入量。
    fn check_message_size(
        &self,
        record: &Value,
        replaced: usize,
    ) -> Result<(usize, usize), String> {
        let bytes = serde_json::to_vec(record).map_err(error_text)?.len();
        let total = self.retained_bytes - replaced + bytes;
        if total > CHAT_RETAIN_BYTES {
            return Err(format!(
                "Gemini chats 消息总量超过 {CHAT_RETAIN_BYTES} 字节上限"
            ));
        }
        Ok((bytes, total))
    }

    fn rebuild_ids(&mut self) {
        self.message_ids = self
            .messages
            .iter()
            .enumerate()
            .filter_map(|(index, record)| {
                record
                    .get("id")
                    .and_then(Value::as_str)
                    .map(|id| (id.to_string(), index))
            })
            .collect();
    }

    fn rewind(&mut self, message_id: &str) {
        match self.message_ids.get(message_id).copied() {
            // 删除目标消息本身及其后的全部消息。
            Some(index) => {
                self.messages.truncate(index);
                self.message_bytes.truncate(index);
            }
            None => {
                self.messages.clear();
                self.message_bytes.clear();
            }
        }
        self.retained_bytes = self.message_bytes.iter().sum();
        self.rebuild_ids();
    }

    fn upsert_message(&mut self, record: Value) -> Result<(), String> {
        let Some(id) = record.get("id").and_then(Value::as_str) else {
            return Ok(());
        };
        match self.message_ids.get(id).copied() {
            Some(index) => {
                let (bytes, total) = self.check_message_size(&record, self.message_bytes[index])?;
                self.messages[index] = record;
                self.message_bytes[index] = bytes;
                self.retained_bytes = total;
            }
            None => {
                let (bytes, total) = self.check_message_size(&record, 0)?;
                self.message_ids.insert(id.to_string(), self.messages.len());
                self.messages.push(record);
                self.message_bytes.push(bytes);
                self.retained_bytes = total;
            }
        }
        Ok(())
    }
}

/// 逐块读取一行（不含换行符），单行超过 `cap` 字节时报错；输入结束时返回 None。
/// 不用 `lines()`：它会在检查长度前把整行读进内存。
fn read_bounded_line(reader: &mut impl BufRead, cap: usize) -> Result<Option<Vec<u8>>, String> {
    let mut line = Vec::new();
    loop {
        let available = reader.fill_buf().map_err(error_text)?;
        if available.is_empty() {
            return if line.is_empty() {
                Ok(None)
            } else {
                Ok(Some(line))
            };
        }
        match available.iter().position(|&byte| byte == b'\n') {
            Some(position) => {
                line.extend_from_slice(&available[..position]);
                reader.consume(position + 1);
                if line.len() > cap {
                    return Err(format!("Gemini chats 单行超过 {cap} 字节上限"));
                }
                return Ok(Some(line));
            }
            None => {
                let length = available.len();
                line.extend_from_slice(available);
                reader.consume(length);
                if line.len() > cap {
                    return Err(format!("Gemini chats 单行超过 {cap} 字节上限"));
                }
            }
        }
    }
}

fn replay_chat_file(path: &Path) -> Result<ReplayedChat, String> {
    let mut chat = ReplayedChat::default();
    if path.extension().and_then(|value| value.to_str()) == Some("json") {
        let file = File::open(path).map_err(error_text)?;
        let file = file.take(CHAT_JSON_BYTES);
        let record: Value = serde_json::from_reader(BufReader::new(file)).map_err(error_text)?;
        chat.merge_metadata(&record)?;
        return Ok(chat);
    }
    let file = File::open(path).map_err(error_text)?;
    let mut reader = BufReader::new(file);
    while let Some(line) = read_bounded_line(&mut reader, CHAT_LINE_BYTES)? {
        if line.iter().all(|byte| byte.is_ascii_whitespace()) {
            continue;
        }
        let Ok(record) = serde_json::from_slice::<Value>(&line) else {
            // 上游逐行忽略解析失败。
            continue;
        };
        if let Some(target) = record.get("$rewindTo").and_then(Value::as_str) {
            chat.rewind(target);
        } else if record.get("$set").is_some_and(Value::is_object) {
            chat.merge_metadata(&record["$set"])?;
        } else if record.get("sessionId").is_some() {
            chat.merge_metadata(&record)?;
        } else if record.get("id").is_some() && record.get("type").is_some() {
            chat.upsert_message(record)?;
        }
    }
    Ok(chat)
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
    cache: &IndexCache,
    brain_messages: &BTreeMap<String, Vec<BrainMessage>>,
    cache_kind: &str,
    parse: impl FnOnce() -> Result<Vec<Value>, String>,
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

    let contributions = parse()?;
    cache.put(
        path,
        cache_kind,
        &metadata,
        &json!({ "contributions": contributions }),
        "",
    );
    Ok(contributions)
}

/// content / displayContent 的 PartListUnion：字符串或 Part 数组（取 text 部分）。
fn chat_part_text(value: &Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        return Some(text.to_string());
    }
    let parts = value.as_array()?;
    let text = parts
        .iter()
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n");
    (!text.is_empty()).then_some(text)
}

fn chat_display_text(record: &Value) -> String {
    record
        .get("displayContent")
        .and_then(chat_part_text)
        .or_else(|| record.get("content").and_then(chat_part_text))
        .unwrap_or_default()
}

/// 单条 chats 消息记录 → 归一化消息。thoughts 映射为合成的 assistant 思考
/// 消息，toolCalls 连同 result 映射为 tool 调用与结果，与 Claude 转录的
/// `tool_use`/`tool_result` 形状保持一致。
fn chat_message_values(record: &Value) -> Vec<Value> {
    let record_type = record.get("type").and_then(Value::as_str).unwrap_or("info");
    let timestamp = record
        .get("timestamp")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut messages = Vec::new();
    for thought in record
        .get("thoughts")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
    {
        let subject = thought.get("subject").and_then(Value::as_str).unwrap_or("");
        let description = thought
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("");
        let mut text = subject.to_string();
        if !text.is_empty() && !description.is_empty() {
            text.push('：');
        }
        text.push_str(description);
        if !text.trim().is_empty() {
            messages.push(message_value(
                "assistant",
                &text,
                timestamp,
                "chat",
                "thinking",
                true,
            ));
        }
    }
    let role = match record_type {
        "user" => "user",
        "gemini" => "assistant",
        // info / error / warning 等系统提示。
        _ => "system",
    };
    let text = chat_display_text(record);
    if !text.trim().is_empty() {
        messages.push(message_value(
            role,
            &text,
            timestamp,
            "chat",
            record_type,
            false,
        ));
    }
    for call in record
        .get("toolCalls")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
    {
        let name = call
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("unknown_tool");
        let id = call.get("id").and_then(Value::as_str).unwrap_or_default();
        let args =
            serde_json::to_string(call.get("args").unwrap_or(&Value::Null)).unwrap_or_default();
        let mut value = message_value(
            "tool",
            &format!("[{name}] {args}"),
            timestamp,
            "chat",
            "tool_use",
            false,
        );
        value["tool_name"] = Value::String(name.into());
        value["tool_kind"] = Value::String("tool_call".into());
        if !id.is_empty() {
            value["tool_call_id"] = Value::String(id.into());
        }
        messages.push(value);
        if let Some(result) = call.get("result").filter(|value| !value.is_null()) {
            let text = chat_part_text(result)
                .or_else(|| extract_text(result))
                .unwrap_or_else(|| serde_json::to_string(result).unwrap_or_default());
            let mut value = message_value("tool", &text, timestamp, "chat", "tool_result", false);
            value["tool_name"] = Value::String(name.into());
            value["tool_kind"] = Value::String("tool_result".into());
            if !id.is_empty() {
                value["tool_call_id"] = Value::String(id.into());
            }
            messages.push(value);
        }
    }
    messages
}

/// chats 的 tokens 与 Codex 同口径：input 已包含 cached（扣除避免重复），
/// tool 计入输入，thoughts 计入输出。回放按消息 id 收敛后累计一次，
/// `$rewindTo` / `$set` 截断掉的记录自然不参与。
fn accumulate_chat_tokens(state: &mut ParseState, messages: &[Value]) {
    for record in messages {
        let tokens = &record["tokens"];
        if !tokens.is_object() {
            continue;
        }
        let input = tokens["input"].as_u64().unwrap_or(0);
        let cached = tokens["cached"].as_u64().unwrap_or(0);
        let tool = tokens["tool"].as_u64().unwrap_or(0);
        let output = tokens["output"].as_u64().unwrap_or(0);
        let thoughts = tokens["thoughts"].as_u64().unwrap_or(0);
        state.cached_input_tokens += cached;
        state.input_tokens += input.saturating_sub(cached).saturating_add(tool);
        state.output_tokens += output.saturating_add(thoughts);
    }
}

fn chat_file_contributions(path: &Path, source: &Source) -> Result<Vec<Value>, String> {
    let chat = replay_chat_file(path)?;
    let mut state = ParseState::new(path);
    if chat.session_id.is_empty() {
        state.id = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("unknown")
            .to_string();
    } else {
        state.id = chat.session_id.clone();
    }
    state.timestamp = chat.start_time.clone();
    if let Some(directory) = chat.directories.first() {
        state.cwd = directory.clone();
    }
    if chat.kind == "subagent" {
        state.hidden = true;
        state.hidden_reason = "subagent".into();
    }
    let mut duplicate_keys = BTreeSet::new();
    for record in &chat.messages {
        let stamp = record
            .get("timestamp")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !stamp.is_empty()
            && (state.last_timestamp.is_empty()
                || compare_timestamps(stamp, &state.last_timestamp) == Ordering::Greater)
        {
            state.last_timestamp = stamp.to_string();
        }
        state.event_count += 1;
        for message in chat_message_values(record) {
            if message["role"].as_str() == Some("user") {
                if let Some(text) = message["text"].as_str() {
                    duplicate_keys.insert(DuplicateUserKey::from_text(text));
                }
            }
            state.accept_message(message);
        }
    }
    accumulate_chat_tokens(&mut state, &chat.messages);
    if state.message_count + state.context_count == 0 {
        // 回放后没有任何可读消息（例如全部被回退），不产出会话。
        return Ok(Vec::new());
    }
    let summary = state.summary(path, source);
    Ok(vec![json!({
        "session_id": state.id,
        "summary": summary,
        "search_text": state.search_text,
        "first_user": state.first_user,
        "first_assistant": state.first_assistant,
        "first_message": state.first_message,
        "saw_primary": true,
        "is_chat": true,
        "duplicate_user_keys": duplicate_keys
            .iter()
            .map(DuplicateUserKey::to_json)
            .collect::<Vec<_>>(),
    })])
}

struct MergedSession {
    path: PathBuf,
    paths: BTreeSet<PathBuf>,
    chat_paths: BTreeSet<PathBuf>,
    shadowed_chat_paths: BTreeSet<PathBuf>,
    state: ParseState,
}

impl MergedSession {
    fn new(session_id: &str, path: PathBuf) -> Self {
        let mut state = ParseState::new(&path);
        state.id = session_id.to_string();
        Self {
            path,
            paths: BTreeSet::new(),
            chat_paths: BTreeSet::new(),
            shadowed_chat_paths: BTreeSet::new(),
            state,
        }
    }

    fn merge(&mut self, contribution: &Value) {
        let summary = &contribution["summary"];
        let path = summary["file_path"]
            .as_str()
            .filter(|value| !value.is_empty());
        let is_chat = contribution["is_chat"].as_bool() == Some(true);
        if let Some(path) = path {
            if is_chat {
                self.chat_paths.insert(PathBuf::from(path));
                if let Some(shadowed) = contribution["shadowed_chat_path"]
                    .as_str()
                    .filter(|value| !value.is_empty())
                {
                    self.shadowed_chat_paths.insert(PathBuf::from(shadowed));
                }
            } else {
                self.paths.insert(PathBuf::from(path));
            }
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
        self.state.input_tokens += summary["input_tokens"].as_u64().unwrap_or_default();
        self.state.output_tokens += summary["output_tokens"].as_u64().unwrap_or_default();
        self.state.cached_input_tokens +=
            summary["cached_input_tokens"].as_u64().unwrap_or_default();
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

    /// 只收集贡献的原始文件路径，不合并内容：被 chats 去重的 logs 副本
    /// 仍要进入 DetailLocator.paths，保证永久删除与备份覆盖全部副本。
    fn merge_paths_only(&mut self, contribution: &Value) {
        if let Some(path) = contribution["summary"]["file_path"]
            .as_str()
            .filter(|value| !value.is_empty())
        {
            self.paths.insert(PathBuf::from(path));
        }
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
                chat_paths: self.chat_paths.into_iter().collect(),
                shadowed_chat_paths: self.shadowed_chat_paths.into_iter().collect(),
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
    let (chat_files, shadowed_chats) = chat_paths(source);
    let active_paths: BTreeSet<String> = paths
        .iter()
        .chain(chat_files.iter())
        .map(|path| path.to_string_lossy().into_owned())
        .collect();
    let mut grouped = HashMap::<String, Vec<Value>>::new();
    let mut errors = Vec::new();

    // chats/ 会话：有回放消息时以它为准，展示不再合并 logs.json 中同一会话
    // 的贡献（避免重复计数）；被去重的 logs 副本仍会进入 locator.paths，
    // 由永久删除与备份覆盖。
    let mut chat_grouped = HashMap::<String, Vec<Value>>::new();
    for path in &chat_files {
        let parse = || chat_file_contributions(path, source);
        let shadowed = shadowed_chats.get(path).cloned();
        match cached_file_contributions(path, cache, &brain_messages, GEMINI_CHAT_CACHE_KIND, parse)
        {
            Ok(contributions) => {
                for mut contribution in contributions {
                    if let Some(shadowed) = &shadowed {
                        contribution["shadowed_chat_path"] =
                            json!(shadowed.to_string_lossy().into_owned());
                    }
                    if let Some(session_id) = contribution["session_id"].as_str() {
                        chat_grouped
                            .entry(session_id.to_string())
                            .or_default()
                            .push(contribution);
                    }
                }
            }
            Err(error) => {
                eprintln!("无法解析 Gemini chats（{}）：{error}", path.display());
                errors.push((path.clone(), error));
            }
        }
    }
    let authoritative_chats: BTreeSet<String> = chat_grouped
        .iter()
        .filter(|(_, contributions)| {
            contributions.iter().any(|contribution| {
                contribution["summary"]["message_count"]
                    .as_u64()
                    .unwrap_or_default()
                    > 0
            })
        })
        .map(|(session_id, _)| session_id.clone())
        .collect();

    for path in &paths {
        let parse = || parse_file_contributions(path, source, &brain_messages);
        match cached_file_contributions(path, cache, &brain_messages, &cache_kind, parse) {
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
            Err(error) => {
                eprintln!("无法解析 Gemini 日志（{}）：{error}", path.display());
                errors.push((path.clone(), error));
            }
        }
    }
    for (session_id, mut contributions) in chat_grouped {
        grouped
            .entry(session_id)
            .or_default()
            .append(&mut contributions);
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
            let is_chat = contribution["is_chat"].as_bool() == Some(true);
            if !is_chat && authoritative_chats.contains(&session_id) {
                // chats 已覆盖展示；logs 副本只保留原始路径供删除与备份。
                merged.merge_paths_only(contribution);
                continue;
            }
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
        errors,
    })
}

/// 把同一会话的多个 chats 文件按序回放到一个状态里（upsert 语义天然去重），
/// 并校验文件与会话标识一致，避免详情读到已被改写的会话。
fn replay_chat_conversation(locator: &DetailLocator) -> Result<ReplayedChat, String> {
    let mut chat = ReplayedChat::default();
    for path in &locator.chat_paths {
        let file_chat = replay_chat_file(path)?;
        if !file_chat.session_id.is_empty() {
            if chat.session_id.is_empty() {
                chat.session_id = file_chat.session_id.clone();
            } else if chat.session_id != file_chat.session_id {
                return Err("chats 文件属于不同的会话标识".into());
            }
        }
        if chat.start_time.is_empty() {
            chat.start_time = file_chat.start_time.clone();
        }
        if chat.last_updated.is_empty()
            || compare_timestamps(&file_chat.last_updated, &chat.last_updated) == Ordering::Greater
        {
            chat.last_updated = file_chat.last_updated.clone();
        }
        if chat.directories.is_empty() {
            chat.directories = file_chat.directories.clone();
        }
        if chat.kind.is_empty() {
            chat.kind = file_chat.kind.clone();
        }
        for record in file_chat.messages {
            chat.upsert_message(record)?;
        }
    }
    if chat.session_id.is_empty() {
        chat.session_id = locator.session_id.clone();
    }
    if chat.session_id != locator.session_id {
        return Err("原始文件已经变化，会话标识不一致；请刷新后重试".into());
    }
    Ok(chat)
}

/// chats 消息的统一身份引用：详情与搜索索引必须共用同一路径，
/// 否则同一消息会得到不同的 `_message_key`，移除与隐藏无法互通。
fn chat_message_identity(message_id: &str, message_index: usize) -> Value {
    json!({"kind":"gemini_chat","message_id":message_id,"message_index":message_index})
}

fn chat_messages_with_keys(chat: &ReplayedChat, mut handle: impl FnMut(Value)) {
    for record in &chat.messages {
        let message_id = record.get("id").and_then(Value::as_str).unwrap_or_default();
        for (message_index, mut message) in chat_message_values(record).into_iter().enumerate() {
            // chats 消息暂不支持消息级永久删除，只附加稳定的消息键供搜索与隐藏使用。
            attach_message_key(
                &mut message,
                chat_message_identity(message_id, message_index),
            );
            handle(message);
        }
    }
}

pub(super) fn visit_detail(
    source: &Source,
    locator: &DetailLocator,
    visitor: &mut dyn FnMut(&Value),
) -> Result<Value, String> {
    if !locator.chat_paths.is_empty() {
        let chat = replay_chat_conversation(locator)?;
        chat_messages_with_keys(&chat, |message| visitor(&message));
        visit_brain_messages(
            &source.root,
            &locator.session_id,
            |role, text, timestamp, subtype, path| {
                if role == "user"
                    && locator
                        .duplicate_user_keys
                        .contains(&DuplicateUserKey::from_text(text))
                {
                    return;
                }
                let mut message = json!({"role":role,"text":text,"timestamp":nullable_string(timestamp),"source_type":"artifact","source_subtype":subtype,"synthetic_context":false});
                attach_message_key(
                    &mut message,
                    json!({"kind":"gemini_artifact","path":path.to_string_lossy(),"content_fingerprint":json_fingerprint(&Value::String(text.to_string()))}),
                );
                visitor(&message);
            },
        );
        return Ok(json!({}));
    }
    let mut state = ParseState::new(&locator.primary_path);
    // 使用临时 SQLite 排序完整日志，避免为长会话保留无界记录数组。
    let records = rusqlite::Connection::open("").map_err(error_text)?;
    records.execute_batch("create table records(message_id integer, timestamp text, payload text, path text, record_index integer); begin").map_err(error_text)?;
    for path in &locator.paths {
        let mut index = 0;
        let mut failure = None;
        visit_log_records(path, |record| {
            let record_index = index;
            index += 1;
            if record["sessionId"].as_str() != Some(locator.session_id.as_str()) {
                return;
            }
            if failure.is_none() {
                if let Err(error) = records.execute(
                    "insert into records values(?1,?2,?3,?4,?5)",
                    rusqlite::params![
                        record["messageId"].as_i64().unwrap_or_default(),
                        record["timestamp"].as_str().unwrap_or_default(),
                        record.to_string(),
                        path.to_string_lossy(),
                        record_index
                    ],
                ) {
                    failure = Some(error.to_string());
                }
            }
        })?;
        if let Some(error) = failure {
            return Err(error);
        }
    }
    records.execute_batch("commit").map_err(error_text)?;
    let mut ordered = records
        .prepare(
            "select payload,path,record_index from records order by message_id,timestamp,rowid",
        )
        .map_err(error_text)?;
    let mut rows = ordered.query([]).map_err(error_text)?;
    while let Some(row) = rows.next().map_err(error_text)? {
        let payload: String = row.get(0).map_err(error_text)?;
        let record: Value = serde_json::from_str(&payload).map_err(error_text)?;
        let path: String = row.get(1).map_err(error_text)?;
        let record_index: i64 = row.get(2).map_err(error_text)?;
        for (message_index, mut message) in state.accept(&record).into_iter().enumerate() {
            attach_message_delete_ref(
                &mut message,
                json!({"kind":"gemini_log","path":path,"record_index":record_index,"message_index":message_index,"record_fingerprint":json_fingerprint(&record)}),
            );
            visitor(&message);
        }
    }
    visit_brain_messages(
        &source.root,
        &locator.session_id,
        |role, text, timestamp, subtype, path| {
            if role == "user"
                && locator
                    .duplicate_user_keys
                    .contains(&DuplicateUserKey::from_text(text))
            {
                return;
            }
            let mut message = json!({"role":role,"text":text,"timestamp":nullable_string(timestamp),"source_type":"artifact","source_subtype":subtype,"synthetic_context":false});
            attach_message_delete_ref(
                &mut message,
                json!({"kind":"gemini_artifact","path":path.to_string_lossy(),"content_fingerprint":json_fingerprint(&Value::String(text.to_string()))}),
            );
            visitor(&message);
        },
    );
    Ok(json!({}))
}

pub(super) fn parse_detail(source: &Source, locator: &DetailLocator) -> Result<Value, String> {
    if !locator.chat_paths.is_empty() {
        return parse_chat_detail(source, locator);
    }
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

/// chats 会话详情：回放后的消息记录就是详情消息与原始事件的来源，
/// 首尾各有界；brain artifacts 与 logs 会话同样参与用户消息去重。
fn parse_chat_detail(source: &Source, locator: &DetailLocator) -> Result<Value, String> {
    let chat = replay_chat_conversation(locator)?;
    let mut state = ParseState::new(&locator.primary_path);
    state.id = locator.session_id.clone();
    let mut messages = HeadTail::new(DETAIL_MESSAGE_LIMIT);
    let mut events = HeadTail::new(DETAIL_EVENT_LIMIT);
    for (index, record) in chat.messages.iter().enumerate() {
        for (message_index, mut message) in chat_message_values(record).into_iter().enumerate() {
            let message_id = record.get("id").and_then(Value::as_str).unwrap_or_default();
            attach_message_key(
                &mut message,
                chat_message_identity(message_id, message_index),
            );
            truncate_message(&mut message);
            messages.push(message);
        }
        let serialized_size = serde_json::to_string(record)
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
    let total_events = chat.messages.len();
    let omitted_events = window_omitted_events;
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

pub(super) fn session_backup_paths(
    source: &Source,
    locator: &DetailLocator,
) -> Result<Vec<PathBuf>, String> {
    let mut paths = locator.paths.clone();
    paths.extend(locator.chat_paths.iter().cloned());
    paths.extend(locator.shadowed_chat_paths.iter().cloned());
    let brain_dir = brain_session_dir(source, &locator.session_id)?;
    if brain_dir.exists() {
        paths.push(brain_dir);
    }
    Ok(paths)
}

pub(super) fn message_backup_paths(
    source: &Source,
    locator: &DetailLocator,
    delete_ref: &Value,
) -> Result<Vec<PathBuf>, String> {
    match delete_ref["kind"].as_str() {
        Some("gemini_log") => Ok(vec![locator_log_path(locator, &delete_ref["path"])?]),
        Some("gemini_artifact") => {
            let brain_dir = brain_session_dir(source, &locator.session_id)?;
            let path = delete_ref["path"]
                .as_str()
                .map(PathBuf::from)
                .ok_or_else(|| "Gemini artifact 删除标识缺少路径".to_string())?;
            if !path.starts_with(&brain_dir) || path == brain_dir {
                return Err("消息不属于当前 Gemini artifact 目录".into());
            }
            Ok(vec![path])
        }
        _ => Err("消息删除标识与 Gemini 格式不匹配".into()),
    }
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
    // chats 文件（含被 .jsonl 隐藏的旧版 .json 副本）是会话独占的，整体移除；
    // 删除前已由调用方完成备份。
    for path in locator
        .chat_paths
        .iter()
        .chain(&locator.shadowed_chat_paths)
    {
        if path.is_file() {
            fs::remove_file(path).map_err(error_text)?;
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

    use super::{
        delete_message, delete_session, parse_detail, parse_source, session_backup_paths,
        visit_detail,
    };
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
    fn 损坏的日志会返回来源诊断错误() {
        let directory = tempdir().unwrap();
        let valid_dir = directory.path().join("tmp").join("valid");
        let broken_dir = directory.path().join("tmp").join("broken");
        std::fs::create_dir_all(&valid_dir).unwrap();
        std::fs::create_dir_all(&broken_dir).unwrap();
        std::fs::write(
            valid_dir.join("logs.json"),
            json!([{ "sessionId": "g1", "messageId": 1, "type": "user", "message": "hello" }])
                .to_string(),
        )
        .unwrap();
        std::fs::write(broken_dir.join("logs.json"), "{broken").unwrap();

        let parsed = parse_source(&source(directory.path()), &IndexCache::disabled()).unwrap();

        assert_eq!(parsed.sessions.len(), 1);
        assert_eq!(parsed.active_paths.len(), 2);
        assert_eq!(parsed.errors.len(), 1);
        assert_eq!(parsed.errors[0].0, broken_dir.join("logs.json"));
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

    fn write_chat_lines(path: &Path, lines: &[Value]) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut content = String::new();
        for line in lines {
            content.push_str(&line.to_string());
            content.push('\n');
        }
        std::fs::write(path, content).unwrap();
    }

    fn chat_file(root: &Path, name: &str) -> PathBuf {
        root.join("tmp").join("hash1").join("chats").join(name)
    }

    #[test]
    fn chats_jsonl回放构建会话统计与详情() {
        let directory = tempdir().unwrap();
        let root = directory.path();
        write_chat_lines(
            &chat_file(root, "session-2026-01-01T08-00-00-c1abcd12.jsonl"),
            &[
                json!({
                    "sessionId": "c1",
                    "projectHash": "hash1",
                    "startTime": "2026-01-01T08:00:00Z",
                    "lastUpdated": "2026-01-01T08:10:00Z",
                    "kind": "main",
                    "directories": ["/work/demo"]
                }),
                json!({"id":"m1","timestamp":"2026-01-01T08:00:01Z","type":"user","content":"第一问"}),
                json!({"id":"m2","timestamp":"2026-01-01T08:00:02Z","type":"gemini","content":[{"text":"第一次回答"}],"tokens":{"input":100,"output":20,"cached":40,"thoughts":5,"tool":2,"total":167}}),
                json!({"$rewindTo":"m9"}),
                json!({"id":"m3","timestamp":"2026-01-01T08:05:00Z","type":"user","content":"重来"}),
                json!({
                    "id":"m4",
                    "timestamp":"2026-01-01T08:05:05Z",
                    "type":"gemini",
                    "content":"最终回答",
                    "thoughts":[{"subject":"思考","description":"检查一下"}],
                    "toolCalls":[{"id":"t1","name":"read_file","args":{"path":"a.rs"},"result":"ok"}],
                    "tokens":{"input":50,"output":10,"cached":10,"thoughts":0,"tool":0,"total":70}
                }),
            ],
        );

        let source = source(root);
        let parsed = parse_source(&source, &IndexCache::disabled()).unwrap();
        assert_eq!(parsed.sessions.len(), 1);
        let session = &parsed.sessions[0];
        let summary = &session.summary;
        assert_eq!(summary["id"], "c1");
        // $rewindTo 未命中清空了前两条；最终消息为 m3 + m4（思考不计入消息数）。
        assert_eq!(summary["message_count"], 4);
        assert_eq!(summary["context_count"], 1);
        // token 口径与 Codex 一致：input 扣 cached 加 tool，thoughts 计入 output；
        // 被回退掉的 m2 不参与累计。
        assert_eq!(summary["input_tokens"], 40);
        assert_eq!(summary["cached_input_tokens"], 10);
        assert_eq!(summary["output_tokens"], 10);
        assert_eq!(summary["cwd"], "/work/demo");
        assert_eq!(summary["model_provider"], "google");

        let detail = parse_detail(&source, &session.detail_locator).unwrap();
        let messages = detail["conversation_messages"].as_array().unwrap();
        assert_eq!(messages.len(), 5);
        assert_eq!(messages[0]["text"], "重来");
        assert_eq!(messages[1]["source_subtype"], "thinking");
        assert_eq!(messages[1]["synthetic_context"], true);
        assert_eq!(messages[2]["text"], "最终回答");
        assert_eq!(messages[3]["tool_name"], "read_file");
        assert_eq!(messages[3]["tool_kind"], "tool_call");
        assert_eq!(messages[4]["tool_kind"], "tool_result");
        assert_eq!(messages[4]["tool_call_id"], "t1");
        assert_eq!(detail["raw_events"].as_array().unwrap().len(), 2);
        assert_eq!(
            detail["summary"]["file_path"],
            chat_file(root, "session-2026-01-01T08-00-00-c1abcd12.jsonl")
                .to_string_lossy()
                .as_ref()
        );
    }

    #[test]
    fn chats会话优先于logs_json避免重复计数() {
        let directory = tempdir().unwrap();
        let root = directory.path();
        let log_dir = root.join("tmp").join("queue");
        std::fs::create_dir_all(&log_dir).unwrap();
        std::fs::write(
            log_dir.join("logs.json"),
            json!([{ "sessionId": "c2", "messageId": 1, "type": "user", "message": "logs里的提问" }])
                .to_string(),
        )
        .unwrap();
        write_chat_lines(
            &chat_file(root, "session-2026-01-02T09-00-00-c2abcd12.jsonl"),
            &[
                json!({"sessionId":"c2","startTime":"2026-01-02T09:00:00Z","directories":["/work/demo"]}),
                json!({"id":"n1","timestamp":"2026-01-02T09:00:01Z","type":"user","content":"完整提问一"}),
                json!({"id":"n2","timestamp":"2026-01-02T09:00:02Z","type":"gemini","content":"完整回答"}),
            ],
        );

        let parsed = parse_source(&source(root), &IndexCache::disabled()).unwrap();
        assert_eq!(parsed.sessions.len(), 1);
        let summary = &parsed.sessions[0].summary;
        assert_eq!(summary["id"], "c2");
        assert_eq!(summary["message_count"], 2);
        assert_eq!(
            summary["file_path"],
            chat_file(root, "session-2026-01-02T09-00-00-c2abcd12.jsonl")
                .to_string_lossy()
                .as_ref()
        );
        let detail = parse_detail(&source(root), &parsed.sessions[0].detail_locator).unwrap();
        assert_eq!(detail["conversation_messages"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn chats旧版json与新jsonl同主名去重() {
        let directory = tempdir().unwrap();
        let root = directory.path();
        let legacy_path = chat_file(root, "session-2026-01-03T09-00-00-c3abcd12.json");
        std::fs::create_dir_all(legacy_path.parent().unwrap()).unwrap();
        std::fs::write(
            legacy_path,
            json!({
                "sessionId": "c3",
                "startTime": "2026-01-03T09:00:00Z",
                "messages": [
                    {"id":"o1","timestamp":"2026-01-03T09:00:01Z","type":"user","content":"旧格式提问"}
                ]
            })
            .to_string(),
        )
        .unwrap();
        write_chat_lines(
            &chat_file(root, "session-2026-01-03T09-00-00-c3abcd12.jsonl"),
            &[
                json!({"sessionId":"c3","startTime":"2026-01-03T09:00:00Z"}),
                json!({"id":"o1","timestamp":"2026-01-03T09:00:01Z","type":"user","content":"旧格式提问"}),
                json!({"id":"o2","timestamp":"2026-01-03T09:00:02Z","type":"gemini","content":"迁移后的回答"}),
            ],
        );

        let parsed = parse_source(&source(root), &IndexCache::disabled()).unwrap();
        assert_eq!(parsed.sessions.len(), 1);
        assert_eq!(parsed.sessions[0].summary["message_count"], 2);
        assert!(parsed.errors.is_empty());
    }

    #[test]
    fn chats会话删除移除原始文件并纳入备份() {
        let directory = tempdir().unwrap();
        let root = directory.path();
        let path = chat_file(root, "session-2026-01-04T09-00-00-c4abcd12.jsonl");
        write_chat_lines(
            &path,
            &[
                json!({"sessionId":"c4","startTime":"2026-01-04T09:00:00Z"}),
                json!({"id":"p1","timestamp":"2026-01-04T09:00:01Z","type":"user","content":"将被删除"}),
            ],
        );

        let source = source(root);
        let parsed = parse_source(&source, &IndexCache::disabled()).unwrap();
        let session = &parsed.sessions[0];
        let backup_paths = session_backup_paths(&source, &session.detail_locator).unwrap();
        assert!(backup_paths.contains(&path));

        delete_session(&source, &session.detail_locator).unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn 嵌套子代理chats文件不进入主会话列表() {
        let directory = tempdir().unwrap();
        let root = directory.path();
        // 子代理会话：嵌套在 chats/<parent>/ 下且不带 session- 前缀。
        write_chat_lines(
            &root
                .join("tmp")
                .join("hash1")
                .join("chats")
                .join("c5abcd12")
                .join("sub-agent.jsonl"),
            &[
                json!({"sessionId":"sub1","kind":"subagent"}),
                json!({"id":"s1","timestamp":"2026-01-05T09:00:01Z","type":"user","content":"子任务"}),
            ],
        );
        // 主会话目录的更深层同名文件也不应被发现。
        write_chat_lines(
            &root
                .join("tmp")
                .join("hash1")
                .join("chats")
                .join("nested")
                .join("session-2026-01-05T09-00-00-c5abcd12.jsonl"),
            &[json!({"sessionId":"c5"})],
        );

        let parsed = parse_source(&source(root), &IndexCache::disabled()).unwrap();
        assert!(parsed.sessions.is_empty());
        assert!(parsed.errors.is_empty());
    }

    #[test]
    fn chats详情与搜索索引使用一致的消息键() {
        let directory = tempdir().unwrap();
        let root = directory.path();
        write_chat_lines(
            &chat_file(root, "session-2026-01-06T09-00-00-c6abcd12.jsonl"),
            &[
                json!({"sessionId":"c6","startTime":"2026-01-06T09:00:00Z"}),
                json!({"id":"q1","timestamp":"2026-01-06T09:00:01Z","type":"user","content":"键一致性"}),
                json!({"id":"q2","timestamp":"2026-01-06T09:00:02Z","type":"gemini","content":"回答"}),
            ],
        );
        let source = source(root);
        let parsed = parse_source(&source, &IndexCache::disabled()).unwrap();
        let session = &parsed.sessions[0];

        let detail = parse_detail(&source, &session.detail_locator).unwrap();
        let detail_keys = detail["conversation_messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|message| {
                message["_message_key"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string()
            })
            .collect::<Vec<_>>();
        assert!(detail_keys.iter().all(|key| !key.is_empty()));

        let mut visitor_keys = Vec::new();
        visit_detail(&source, &session.detail_locator, &mut |message| {
            visitor_keys.push(
                message["_message_key"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string(),
            );
        })
        .unwrap();
        assert_eq!(detail_keys, visitor_keys);
    }

    #[test]
    fn chats会话删除覆盖logs与被隐藏的旧文件() {
        let directory = tempdir().unwrap();
        let root = directory.path();
        let log_dir = root.join("tmp").join("queue");
        std::fs::create_dir_all(&log_dir).unwrap();
        let log_path = log_dir.join("logs.json");
        std::fs::write(
            &log_path,
            json!([
                { "sessionId": "c7", "messageId": 1, "type": "user", "message": "旧日志提问" },
                { "sessionId": "other", "messageId": 1, "type": "user", "message": "必须保留" }
            ])
            .to_string(),
        )
        .unwrap();
        let legacy_path = chat_file(root, "session-2026-01-07T09-00-00-c7abcd12.json");
        std::fs::create_dir_all(legacy_path.parent().unwrap()).unwrap();
        std::fs::write(
            &legacy_path,
            json!({
                "sessionId": "c7",
                "startTime": "2026-01-07T09:00:00Z",
                "messages": [
                    {"id":"r1","timestamp":"2026-01-07T09:00:01Z","type":"user","content":"旧文件提问"}
                ]
            })
            .to_string(),
        )
        .unwrap();
        let jsonl_path = chat_file(root, "session-2026-01-07T09-00-00-c7abcd12.jsonl");
        write_chat_lines(
            &jsonl_path,
            &[
                json!({"sessionId":"c7","startTime":"2026-01-07T09:00:00Z"}),
                json!({"id":"r1","timestamp":"2026-01-07T09:00:01Z","type":"user","content":"旧文件提问"}),
                json!({"id":"r2","timestamp":"2026-01-07T09:00:02Z","type":"gemini","content":"当前回答"}),
            ],
        );

        let source = source(root);
        let parsed = parse_source(&source, &IndexCache::disabled()).unwrap();
        // logs.json 中的 "other" 是独立的合法会话。
        assert_eq!(parsed.sessions.len(), 2);
        let session = parsed
            .sessions
            .iter()
            .find(|session| session.summary["id"] == "c7")
            .unwrap();
        assert_eq!(session.summary["message_count"], 2);
        let locator = &session.detail_locator;
        assert!(locator.paths.contains(&log_path));
        assert!(locator.chat_paths.contains(&jsonl_path));
        assert!(locator.shadowed_chat_paths.contains(&legacy_path));

        let backup_paths = session_backup_paths(&source, locator).unwrap();
        assert!(backup_paths.contains(&log_path));
        assert!(backup_paths.contains(&jsonl_path));
        assert!(backup_paths.contains(&legacy_path));

        delete_session(&source, locator).unwrap();
        assert!(!jsonl_path.exists());
        assert!(!legacy_path.exists());
        let after: Value =
            serde_json::from_str(&std::fs::read_to_string(&log_path).unwrap()).unwrap();
        assert!(after
            .as_array()
            .unwrap()
            .iter()
            .all(|record| record["sessionId"] != "c7"));
        assert!(after
            .as_array()
            .unwrap()
            .iter()
            .any(|record| record["sessionId"] == "other"));
    }

    #[test]
    fn chats超限单行返回来源错误() {
        let directory = tempdir().unwrap();
        let root = directory.path();
        let oversized = "x".repeat(super::CHAT_LINE_BYTES + 1);
        write_chat_lines(
            &chat_file(root, "session-2026-01-08T09-00-00-c8abcd12.jsonl"),
            &[
                json!({"sessionId":"c8","startTime":"2026-01-08T09:00:00Z"}),
                json!({"id":"big1","timestamp":"2026-01-08T09:00:01Z","type":"user","content":oversized}),
            ],
        );

        let parsed = parse_source(&source(root), &IndexCache::disabled()).unwrap();
        assert!(parsed.sessions.is_empty());
        assert_eq!(parsed.errors.len(), 1);
    }

    #[test]
    fn chats已有消息更新增长同样受累计上限约束() {
        let directory = tempdir().unwrap();
        let path = chat_file(directory.path(), "session-growth.jsonl");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut file = std::fs::File::create(&path).unwrap();
        use std::io::Write;
        writeln!(file, "{}", json!({"sessionId":"growth"})).unwrap();
        for id in 0..9 {
            writeln!(
                file,
                "{}",
                json!({"id":id.to_string(),"type":"gemini","content":""})
            )
            .unwrap();
        }
        let content = "x".repeat(8 * 1024 * 1024);
        for id in 0..9 {
            writeln!(
                file,
                "{}",
                json!({"id":id.to_string(),"type":"gemini","content":content})
            )
            .unwrap();
        }
        drop(file);
        let error = super::replay_chat_file(&path)
            .err()
            .expect("更新后应超过累计上限");
        assert!(error.contains("消息总量超过"));
    }

    #[test]
    fn chats替换回退与检查点同步更新保留大小() {
        let mut chat = super::ReplayedChat::default();
        let a = json!({"id":"a","type":"user","content":"首条"});
        let b = json!({"id":"b","type":"gemini","content":"较长的回答内容"});
        let size = |record: &Value| serde_json::to_vec(record).unwrap().len();
        chat.upsert_message(a.clone()).unwrap();
        chat.upsert_message(b.clone()).unwrap();
        assert_eq!(chat.retained_bytes, size(&a) + size(&b));
        let shorter = json!({"id":"b","type":"gemini","content":"短"});
        chat.upsert_message(shorter.clone()).unwrap();
        assert_eq!(chat.retained_bytes, size(&a) + size(&shorter));
        chat.rewind("b");
        assert_eq!(chat.retained_bytes, size(&a));
        chat.merge_metadata(&json!({"messages":[b.clone()]}))
            .unwrap();
        assert_eq!(chat.retained_bytes, size(&b));
        assert_eq!(chat.message_bytes, vec![size(&b)]);
        chat.upsert_message(shorter.clone()).unwrap();
        assert_eq!(chat.retained_bytes, size(&shorter));
        chat.rewind("missing");
        assert_eq!(chat.retained_bytes, 0);
        assert!(chat.message_bytes.is_empty());
    }
}
