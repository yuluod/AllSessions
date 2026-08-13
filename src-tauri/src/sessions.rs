use std::{
    collections::{BTreeMap, BTreeSet, HashMap, VecDeque},
    env,
    fs::{self, File},
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
};

use chrono::{SecondsFormat, TimeZone, Utc};
use serde_json::{json, Value};
use walkdir::WalkDir;

use crate::cache::IndexCache;

const PAGE_LIMIT: usize = 50;
const SEARCH_TEXT_LIMIT: usize = 64_000;
const DETAIL_MESSAGE_LIMIT: usize = 800;
const DETAIL_EVENT_LIMIT: usize = 1_200;
const DETAIL_TEXT_LIMIT: usize = 20_000;
const DETAIL_CACHE_BYTES: usize = 64 * 1024 * 1024;

#[derive(Clone)]
struct Source {
    kind: &'static str,
    display_name: &'static str,
    root: PathBuf,
    format: SourceFormat,
    archived: bool,
}

#[derive(Clone, Copy)]
enum SourceFormat {
    Codex,
    Claude,
    Gemini,
}

struct StoredSession {
    summary: Value,
    search_text: String,
    source: Source,
    path: PathBuf,
    inline_detail: Option<Value>,
}

pub struct SessionStore {
    summaries: Vec<Value>,
    records: HashMap<String, StoredSession>,
    sources: Vec<Source>,
    index_cache: IndexCache,
    detail_cache: DetailCache,
}

impl SessionStore {
    pub fn load() -> Result<Self, String> {
        let mut store = Self {
            summaries: Vec::new(),
            records: HashMap::new(),
            sources: configured_sources(),
            index_cache: IndexCache::open()?,
            detail_cache: DetailCache::new(DETAIL_CACHE_BYTES),
        };
        store.refresh()?;
        Ok(store)
    }

    pub fn watch_roots(&self) -> Vec<PathBuf> {
        self.sources
            .iter()
            .filter_map(|source| existing_watch_root(&source.root))
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect()
    }

    pub fn refresh(&mut self) -> Result<(), String> {
        let mut next = HashMap::new();
        let mut active_paths = BTreeSet::new();
        for source in &self.sources {
            if matches!(source.format, SourceFormat::Gemini) {
                for detail in parse_gemini_source(source)? {
                    let summary = detail["summary"].clone();
                    let key = summary["_key"].as_str().unwrap_or_default().to_string();
                    next.insert(
                        key,
                        StoredSession {
                            search_text: search_text_from_detail(&detail),
                            summary,
                            source: source.clone(),
                            path: PathBuf::new(),
                            inline_detail: Some(detail),
                        },
                    );
                }
                continue;
            }
            for path in discover_files(source) {
                let path_key = path.to_string_lossy().into_owned();
                active_paths.insert(path_key);
                let metadata = match fs::metadata(&path) {
                    Ok(value) => value,
                    Err(_) => continue,
                };
                let parsed = self
                    .index_cache
                    .get(&path, source.kind, &metadata)
                    .map(|cached| (cached.summary, cached.search_text))
                    .map(Ok)
                    .unwrap_or_else(|| parse_summary(&path, source));
                match parsed {
                    Ok((summary, search_text)) => {
                        self.index_cache
                            .put(&path, source.kind, &metadata, &summary, &search_text);
                        let key = summary["_key"].as_str().unwrap_or_default().to_string();
                        next.insert(
                            key,
                            StoredSession {
                                summary,
                                search_text,
                                source: source.clone(),
                                path,
                                inline_detail: None,
                            },
                        );
                    }
                    Err(error) => eprintln!("无法解析会话摘要（{}）：{error}", path.display()),
                }
            }
        }
        self.index_cache.prune(&active_paths);
        self.records = next;
        self.rebuild_summaries();
        Ok(())
    }

    pub fn refresh_paths(&mut self, paths: &BTreeSet<PathBuf>) -> Result<bool, String> {
        if paths.iter().any(|path| {
            self.sources.iter().any(|source| {
                matches!(source.format, SourceFormat::Gemini) && path.starts_with(&source.root)
            })
        }) {
            self.refresh()?;
            return Ok(true);
        }

        let mut changed = false;
        for path in paths {
            let Some(source) = self
                .sources
                .iter()
                .find(|source| {
                    !matches!(source.format, SourceFormat::Gemini) && path.starts_with(&source.root)
                })
                .cloned()
            else {
                continue;
            };
            let affected = self
                .records
                .iter()
                .filter(|(_, record)| {
                    record.path == *path || (!path.exists() && record.path.starts_with(path))
                })
                .map(|(key, record)| (key.clone(), record.path.clone()))
                .collect::<Vec<_>>();
            if !path.is_file() || !source_matches_path(&source, path) {
                for (key, record_path) in affected {
                    self.records.remove(&key);
                    self.index_cache.remove(&record_path);
                    changed = true;
                }
                continue;
            }
            let metadata = fs::metadata(path).map_err(error_text)?;
            let (summary, search_text) = parse_summary(path, &source)?;
            for (key, record_path) in affected {
                self.records.remove(&key);
                self.index_cache.remove(&record_path);
            }
            self.index_cache
                .put(path, source.kind, &metadata, &summary, &search_text);
            let key = summary["_key"].as_str().unwrap_or_default().to_string();
            self.records.insert(
                key,
                StoredSession {
                    summary,
                    search_text,
                    source,
                    path: path.clone(),
                    inline_detail: None,
                },
            );
            changed = true;
        }
        if changed {
            self.rebuild_summaries();
        }
        Ok(changed)
    }

    fn rebuild_summaries(&mut self) {
        self.summaries = self
            .records
            .values()
            .map(|record| record.summary.clone())
            .collect();
        self.summaries
            .sort_by(|left, right| timestamp_of(right).cmp(timestamp_of(left)));
        self.detail_cache.clear();
    }

    pub fn capabilities(&self, maintenance_enabled: bool) -> Value {
        json!({ "service": { "name": "AllSessions", "protocol_version": 2 }, "codex_maintenance": { "enabled": maintenance_enabled } })
    }

    pub fn list(&self, query: &HashMap<String, String>) -> Value {
        paginate(
            self.filtered(query),
            query,
            json!({ "session_roots": self.session_roots() }),
        )
    }

    pub fn search(&self, query: &HashMap<String, String>) -> Value {
        let needle = query
            .get("q")
            .map(|value| value.to_lowercase())
            .unwrap_or_default();
        let filtered = self
            .filtered(query)
            .into_iter()
            .filter_map(|summary| {
                let record = self.records.get(summary["_key"].as_str()?)?;
                let text = record.search_text.to_lowercase();
                if !search_query_matches(&text, &needle) {
                    return None;
                }
                let mut result = summary;
                result["search_snippet"] = Value::String(search_snippet(&text, &needle));
                Some(result)
            })
            .collect();
        paginate(
            filtered,
            query,
            json!({ "session_roots": self.session_roots(), "query": query.get("q").cloned().unwrap_or_default() }),
        )
    }

    pub fn detail(&mut self, key: &str) -> Option<Value> {
        let resolved = if self.records.contains_key(key) {
            key.to_string()
        } else {
            let matches = self
                .records
                .iter()
                .filter(|(_, record)| record.summary["id"].as_str() == Some(key))
                .map(|(key, _)| key.clone())
                .collect::<Vec<_>>();
            if matches.len() != 1 {
                return None;
            }
            matches[0].clone()
        };
        if let Some(detail) = self.detail_cache.get(&resolved) {
            return Some(detail);
        }
        let record = self.records.get(&resolved)?;
        let detail = record
            .inline_detail
            .clone()
            .or_else(|| parse_detail(&record.path, &record.source).ok())?;
        let size = serde_json::to_vec(&detail)
            .map(|value| value.len())
            .unwrap_or_default();
        self.detail_cache.insert(resolved, detail.clone(), size);
        Some(detail)
    }

    pub fn facets(&self) -> Value {
        let mut providers = BTreeSet::new();
        let mut source_kinds = BTreeSet::new();
        let mut dates = BTreeSet::new();
        let mut cwds = BTreeSet::new();
        let mut hidden_reasons = BTreeSet::new();
        let mut projects: BTreeMap<String, ProjectFacet> = BTreeMap::new();
        for summary in &self.summaries {
            insert_string(&mut providers, &summary["model_provider"]);
            insert_string(&mut source_kinds, &summary["source_kind"]);
            insert_string(&mut cwds, &summary["cwd"]);
            if summary["hidden"].as_bool() == Some(true) {
                insert_string(&mut hidden_reasons, &summary["hidden_reason"]);
            }
            if let Some(date) = timestamp_of(summary).get(..10) {
                dates.insert(date.to_string());
            }
            if let Some(cwd) = summary["cwd"].as_str().filter(|value| !value.is_empty()) {
                let project = projects.entry(cwd.into()).or_insert_with(|| ProjectFacet {
                    name: Path::new(cwd)
                        .file_name()
                        .and_then(|value| value.to_str())
                        .unwrap_or(cwd)
                        .into(),
                    path: cwd.into(),
                    ..ProjectFacet::default()
                });
                project.count += 1;
                let timestamp = timestamp_of(summary).to_string();
                if timestamp > project.last_timestamp {
                    project.last_timestamp = timestamp;
                }
                insert_string(&mut project.providers, &summary["model_provider"]);
                insert_string(&mut project.source_kinds, &summary["source_kind"]);
            }
        }
        let mut project_values = projects
            .into_values()
            .map(ProjectFacet::value)
            .collect::<Vec<_>>();
        project_values.sort_by(|left, right| {
            right["last_timestamp"]
                .as_str()
                .cmp(&left["last_timestamp"].as_str())
        });
        let mut date_values = dates.into_iter().collect::<Vec<_>>();
        date_values.reverse();
        json!({ "session_roots": self.session_roots(), "sources": self.sources.iter().map(|source| json!({ "kind": source.kind, "display_name": source.display_name })).collect::<Vec<_>>(), "providers": providers, "source_kinds": source_kinds, "dates": date_values, "cwds": cwds, "hidden_reasons": hidden_reasons, "projects": project_values })
    }

    pub fn stats(&self, query: &HashMap<String, String>) -> Value {
        let filtered = self.filtered(query);
        let mut by_date = BTreeMap::new();
        let mut by_source_kind = HashMap::new();
        let mut by_provider = HashMap::new();
        let mut by_cwd = HashMap::new();
        let mut total_events = 0_u64;
        for summary in &filtered {
            total_events += summary["event_count"].as_u64().unwrap_or_default();
            if let Some(date) = timestamp_of(summary).get(..10) {
                *by_date.entry(date.to_string()).or_insert(0_u64) += 1;
            }
            increment(&mut by_source_kind, &summary["source_kind"]);
            increment(&mut by_provider, &summary["model_provider"]);
            increment(&mut by_cwd, &summary["cwd"]);
        }
        let active_days = by_date.len();
        json!({ "total": filtered.len(), "total_events": total_events, "active_days": active_days, "avg_daily": if active_days == 0 { "0".into() } else { format!("{:.1}", filtered.len() as f64 / active_days as f64) }, "by_date": by_date.into_iter().map(|(label, count)| json!({ "label": label, "count": count })).collect::<Vec<_>>(), "by_source_kind": count_values(by_source_kind, usize::MAX), "by_provider": count_values(by_provider, usize::MAX), "by_cwd": count_values(by_cwd, 16) })
    }

    fn filtered(&self, query: &HashMap<String, String>) -> Vec<Value> {
        self.summaries
            .iter()
            .filter(|summary| matches_filters(summary, query))
            .cloned()
            .collect()
    }
    fn session_roots(&self) -> Vec<String> {
        self.sources
            .iter()
            .map(|source| source.root.to_string_lossy().into_owned())
            .collect()
    }
}

#[derive(Default)]
struct ProjectFacet {
    name: String,
    path: String,
    count: u64,
    last_timestamp: String,
    providers: BTreeSet<String>,
    source_kinds: BTreeSet<String>,
}
impl ProjectFacet {
    fn value(self) -> Value {
        json!({ "name": self.name, "path": self.path, "count": self.count, "last_timestamp": self.last_timestamp, "providers": self.providers, "source_kinds": self.source_kinds })
    }
}

struct ParseState {
    id: String,
    timestamp: String,
    last_timestamp: String,
    cwd: String,
    provider: String,
    originator: String,
    hidden: bool,
    hidden_reason: String,
    force_sidechain: bool,
    saw_sidechain: bool,
    saw_primary: bool,
    fallback_id: String,
    parent_session_id: String,
    agent_id: String,
    event_count: usize,
    message_count: u64,
    context_count: u64,
    roles: BTreeMap<String, u64>,
    first_user: String,
    first_assistant: String,
    first_message: String,
    search_text: String,
    tool_names: HashMap<String, String>,
    previous_message: Option<(String, String, String)>,
}

impl ParseState {
    fn new(path: &Path) -> Self {
        let fallback_id = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("unknown")
            .to_string();
        let force_sidechain = path
            .components()
            .any(|component| component.as_os_str() == "subagents");
        Self {
            id: fallback_id.clone(),
            timestamp: String::new(),
            last_timestamp: String::new(),
            cwd: String::new(),
            provider: "unknown".into(),
            originator: String::new(),
            hidden: false,
            hidden_reason: String::new(),
            force_sidechain,
            saw_sidechain: force_sidechain,
            saw_primary: false,
            fallback_id,
            parent_session_id: String::new(),
            agent_id: String::new(),
            event_count: 0,
            message_count: 0,
            context_count: 0,
            roles: BTreeMap::new(),
            first_user: String::new(),
            first_assistant: String::new(),
            first_message: String::new(),
            search_text: String::new(),
            tool_names: HashMap::new(),
            previous_message: None,
        }
    }
    fn accept(&mut self, record: &Value) -> Vec<Value> {
        self.event_count += 1;
        let stamp = string_at(record, &["timestamp"]).unwrap_or_default();
        if self.timestamp.is_empty() && !stamp.is_empty() {
            self.timestamp = stamp.clone();
        }
        if !stamp.is_empty() {
            self.last_timestamp = stamp.clone();
        }
        if record.get("type").and_then(Value::as_str) == Some("session_meta") {
            let payload = &record["payload"];
            if let Some(value) = string_at(payload, &["id"]) {
                self.id = value;
            }
            if let Some(value) = string_at(payload, &["cwd"]) {
                self.cwd = value;
            }
            if let Some(value) = string_at(payload, &["model_provider"]) {
                self.provider = value;
            }
            if let Some(value) = string_at(payload, &["originator"]) {
                self.originator = value;
            }
            if payload
                .get("source")
                .and_then(|value| value.get("subagent"))
                .is_some()
            {
                self.hidden = true;
                self.hidden_reason = "subagent".into();
            }
        }
        if let Some(value) = string_at(record, &["cwd"]) {
            self.cwd = value;
        }
        for key in [
            "workingDirectory",
            "working_directory",
            "workspace",
            "workspaceDir",
            "projectRoot",
            "project_root",
        ] {
            if self.cwd.is_empty() {
                if let Some(value) = string_at(record, &[key]) {
                    self.cwd = value;
                }
            }
        }
        if let Some(value) = string_at(record, &["sessionId"]) {
            if self.force_sidechain {
                self.parent_session_id = value;
            } else {
                self.id = value;
            }
        }
        if let Some(value) =
            string_at(record, &["agentId"]).or_else(|| string_at(record, &["agent_id"]))
        {
            self.agent_id = value;
        }
        if self.force_sidechain {
            self.id = format!(
                "{}:subagent:{}",
                if self.parent_session_id.is_empty() {
                    "unknown"
                } else {
                    &self.parent_session_id
                },
                if self.agent_id.is_empty() {
                    &self.fallback_id
                } else {
                    &self.agent_id
                }
            );
        }
        if let Some(value) = string_at(record, &["modelProvider"])
            .or_else(|| string_at(record, &["model_provider"]))
            .or_else(|| string_at(record, &["provider"]))
            .or_else(|| string_at(record, &["message", "provider"]))
        {
            self.provider = value;
        }
        if record.get("isSidechain").and_then(Value::as_bool) == Some(true) {
            self.saw_sidechain = true;
        } else if matches!(
            record.get("type").and_then(Value::as_str),
            Some("user" | "assistant")
        ) {
            self.saw_primary = true;
        }
        let mut accepted = Vec::new();
        for message in conversation_messages(record, &stamp, &mut self.tool_names) {
            if let Some(message) = self.accept_message(message) {
                accepted.push(message);
            }
        }
        accepted
    }
    fn accept_message(&mut self, message: Value) -> Option<Value> {
        let role = message["role"].as_str().unwrap_or("unknown");
        let text = message["text"].as_str().unwrap_or_default();
        let source_type = message["source_type"].as_str().unwrap_or_default();
        if let Some((previous_role, previous_text, previous_type)) = &self.previous_message {
            if previous_role == role
                && previous_text == text
                && ((previous_type == "event_msg" && source_type == "response_item")
                    || (previous_type == "response_item" && source_type == "event_msg"))
            {
                return None;
            }
        }
        self.previous_message = Some((role.into(), text.into(), source_type.into()));
        if message["synthetic_context"].as_bool() == Some(true) {
            self.context_count += 1;
            return Some(message);
        }
        self.message_count += 1;
        *self.roles.entry(role.into()).or_default() += 1;
        if self.first_message.is_empty() {
            self.first_message = compact(text, 160);
        }
        if role == "user" && self.first_user.is_empty() {
            self.first_user = compact_title(text, 90);
        }
        if role == "assistant" && self.first_assistant.is_empty() {
            self.first_assistant = compact(text, 160);
        }
        append_limited(&mut self.search_text, &[role, text], SEARCH_TEXT_LIMIT);
        Some(message)
    }
    fn summary(&self, path: &Path, source: &Source) -> Value {
        let hidden =
            self.hidden || self.force_sidechain || (self.saw_sidechain && !self.saw_primary);
        let hidden_reason = if hidden && self.hidden_reason.is_empty() {
            "subagent"
        } else {
            &self.hidden_reason
        };
        let title = if !self.first_user.is_empty() {
            self.first_user.clone()
        } else {
            Path::new(&self.cwd)
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or(&self.id)
                .into()
        };
        let preview = if !self.first_assistant.is_empty() {
            self.first_assistant.clone()
        } else {
            self.first_message.clone()
        };
        let provider = if self.provider == "unknown" {
            match source.format {
                SourceFormat::Claude => "anthropic",
                SourceFormat::Gemini => "google",
                SourceFormat::Codex => "unknown",
            }
        } else {
            &self.provider
        };
        let originator = if self.originator.is_empty() {
            match source.format {
                SourceFormat::Claude => "claude_code",
                SourceFormat::Gemini => "google_gemini",
                SourceFormat::Codex => "",
            }
        } else {
            &self.originator
        };
        json!({ "id": self.id, "_key": format!("{}:{}", source.kind, self.id), "source_kind": source.kind, "display_source": source.display_name, "timestamp": nullable_string(&self.timestamp), "last_timestamp": nullable_string(&self.last_timestamp), "model_provider": provider, "cwd": self.cwd, "source": if hidden { "subagent" } else { "cli" }, "originator": originator, "file_path": path.to_string_lossy(), "event_count": self.event_count, "message_count": self.message_count, "context_count": self.context_count, "role_counts": self.roles, "tool_count": self.roles.get("tool").copied().unwrap_or_default(), "title": title, "preview_text": preview, "archived": source.archived, "archive_source": if source.archived { "codex" } else { "" }, "hidden": hidden, "hidden_reason": hidden_reason, "parent_session_id": if self.parent_session_id.is_empty() { Value::Null } else { Value::String(self.parent_session_id.clone()) } })
    }
}

fn parse_summary(path: &Path, source: &Source) -> Result<(Value, String), String> {
    if path.extension().and_then(|value| value.to_str()) == Some("json") {
        return parse_legacy_claude_summary(path, source);
    }
    let mut state = ParseState::new(path);
    for line in BufReader::new(File::open(path).map_err(error_text)?).lines() {
        let line = line.map_err(error_text)?;
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(record) = serde_json::from_str::<Value>(&line) {
            state.accept(&record);
        }
    }
    let summary = state.summary(path, source);
    let mut search = summary_search_text(&summary);
    append_limited(&mut search, &[&state.search_text], SEARCH_TEXT_LIMIT);
    Ok((summary, search))
}

fn parse_detail(path: &Path, source: &Source) -> Result<Value, String> {
    if path.extension().and_then(|value| value.to_str()) == Some("json") {
        let value: Value =
            serde_json::from_reader(File::open(path).map_err(error_text)?).map_err(error_text)?;
        return parse_legacy_claude_detail(path, source, value)
            .ok_or_else(|| "旧版 Claude 会话缺少 ID".into());
    }
    let mut state = ParseState::new(path);
    let mut messages = HeadTail::new(DETAIL_MESSAGE_LIMIT);
    let mut events = HeadTail::new(DETAIL_EVENT_LIMIT);
    for (index, line) in BufReader::new(File::open(path).map_err(error_text)?)
        .lines()
        .enumerate()
    {
        let line = line.map_err(error_text)?;
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<Value>(&line) {
            Ok(record) => {
                for mut message in state.accept(&record) {
                    truncate_message(&mut message);
                    messages.push(message);
                }
                let payload = if line.chars().count() > 10_000 {
                    json!({ "truncated": true, "original_chars": line.chars().count() })
                } else {
                    record
                        .get("payload")
                        .cloned()
                        .unwrap_or_else(|| record.clone())
                };
                events.push(json!({ "line_number": index + 1, "timestamp": record.get("timestamp").cloned().unwrap_or(Value::Null), "type": record.get("type").and_then(Value::as_str).unwrap_or("unknown"), "payload": payload }));
            }
            Err(error) => {
                state.event_count += 1;
                events.push(json!({ "line_number": index + 1, "timestamp": Value::Null, "type": "parse_error", "payload": { "message": error.to_string() } }));
            }
        }
    }
    let (mut message_values, omitted_messages, total_messages) = messages.finish(json!({ "role": "system", "text": "", "timestamp": Value::Null, "source_type": "viewer", "source_subtype": "truncation", "is_truncation_marker": true }));
    if omitted_messages > 0 {
        if let Some(marker) = message_values
            .iter_mut()
            .find(|value| value["is_truncation_marker"] == true)
        {
            marker["omitted_count"] = json!(omitted_messages);
        }
    }
    let (event_values, omitted_events, total_events) = events.finish(json!({ "line_number": Value::Null, "timestamp": Value::Null, "type": "viewer_truncation", "payload": { "omitted_events": 0 } }));
    let mut summary = state.summary(path, source);
    if omitted_messages + omitted_events > 0 {
        summary["detail_truncated"] = Value::Bool(true);
    }
    Ok(
        json!({ "summary": summary, "conversation_messages": message_values, "raw_events": event_values, "truncation": { "truncated": omitted_messages + omitted_events > 0, "messages": { "total": total_messages, "omitted": omitted_messages }, "raw_events": { "total": total_events, "omitted": omitted_events } } }),
    )
}

struct HeadTail<T> {
    limit: usize,
    values: VecDeque<T>,
    total: usize,
}
impl<T> HeadTail<T> {
    fn new(limit: usize) -> Self {
        Self {
            limit,
            values: VecDeque::new(),
            total: 0,
        }
    }
    fn push(&mut self, value: T) {
        self.total += 1;
        if self.values.len() < self.limit {
            self.values.push_back(value);
        } else {
            let head = self.limit.div_ceil(2);
            self.values.remove(head);
            self.values.push_back(value);
        }
    }
    fn finish(self, marker: T) -> (Vec<T>, usize, usize) {
        let omitted = self.total.saturating_sub(self.values.len());
        let mut values = self.values.into_iter().collect::<Vec<_>>();
        if omitted > 0 {
            values.insert(self.limit.div_ceil(2), marker);
        }
        (values, omitted, self.total)
    }
}

struct DetailCache {
    max_bytes: usize,
    bytes: usize,
    order: VecDeque<String>,
    values: HashMap<String, (Value, usize)>,
}
impl DetailCache {
    fn new(max_bytes: usize) -> Self {
        Self {
            max_bytes,
            bytes: 0,
            order: VecDeque::new(),
            values: HashMap::new(),
        }
    }
    fn get(&mut self, key: &str) -> Option<Value> {
        let value = self.values.get(key)?.0.clone();
        self.order.retain(|item| item != key);
        self.order.push_back(key.into());
        Some(value)
    }
    fn insert(&mut self, key: String, value: Value, size: usize) {
        if size > self.max_bytes {
            return;
        }
        if let Some((_, old)) = self.values.remove(&key) {
            self.bytes -= old;
        }
        self.order.retain(|item| item != &key);
        self.bytes += size;
        self.order.push_back(key.clone());
        self.values.insert(key, (value, size));
        while self.bytes > self.max_bytes {
            if let Some(old) = self.order.pop_front() {
                if let Some((_, size)) = self.values.remove(&old) {
                    self.bytes -= size;
                }
            }
        }
    }
    fn clear(&mut self) {
        self.bytes = 0;
        self.order.clear();
        self.values.clear();
    }
}

fn configured_sources() -> Vec<Source> {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    let codex_home = env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".codex"));
    let codex = env_path("CODEX_SESSIONS_DIR", codex_home.join("sessions"));
    let archived = env_path(
        "CODEX_ARCHIVED_SESSIONS_DIR",
        codex_home.join("archived_sessions"),
    );
    let claude_home = env_path("CLAUDE_SESSIONS_DIR", home.join(".claude"));
    let gemini = env_path("GEMINI_SESSIONS_DIR", home.join(".gemini"));
    let claude_projects = claude_home.join("projects");
    let claude_sessions = claude_home.join("sessions");
    [
        Source {
            kind: "codex",
            display_name: "Codex",
            root: codex,
            format: SourceFormat::Codex,
            archived: false,
        },
        Source {
            kind: "codex_archived",
            display_name: "Codex Archived",
            root: archived,
            format: SourceFormat::Codex,
            archived: true,
        },
        Source {
            kind: "claude_code",
            display_name: "Claude Code",
            root: if claude_projects.is_dir() {
                claude_projects
            } else {
                claude_sessions
            },
            format: SourceFormat::Claude,
            archived: false,
        },
        Source {
            kind: "gemini",
            display_name: "Gemini CLI",
            root: gemini,
            format: SourceFormat::Gemini,
            archived: false,
        },
    ]
    .into_iter()
    .filter(|source| source.root.exists())
    .collect()
}
fn env_path(key: &str, fallback: PathBuf) -> PathBuf {
    env::var_os(key).map(PathBuf::from).unwrap_or(fallback)
}
fn existing_watch_root(path: &Path) -> Option<PathBuf> {
    let mut current = path;
    loop {
        if current.is_dir() {
            return Some(current.into());
        }
        current = current.parent()?;
    }
}
fn discover_files(source: &Source) -> Vec<PathBuf> {
    let extension =
        if matches!(source.format, SourceFormat::Claude) && source.root.ends_with("sessions") {
            "json"
        } else {
            "jsonl"
        };
    WalkDir::new(&source.root)
        .max_depth(16)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| {
            entry.file_type().is_file()
                && entry.path().extension().and_then(|value| value.to_str()) == Some(extension)
        })
        .map(|entry| entry.into_path())
        .collect()
}

fn source_matches_path(source: &Source, path: &Path) -> bool {
    let extension =
        if matches!(source.format, SourceFormat::Claude) && source.root.ends_with("sessions") {
            "json"
        } else {
            "jsonl"
        };
    path.extension().and_then(|value| value.to_str()) == Some(extension)
}

fn parse_legacy_claude_summary(path: &Path, source: &Source) -> Result<(Value, String), String> {
    let value: Value =
        serde_json::from_reader(File::open(path).map_err(error_text)?).map_err(error_text)?;
    let detail = parse_legacy_claude_detail(path, source, value)
        .ok_or_else(|| "旧版 Claude 会话缺少 ID".to_string())?;
    Ok((detail["summary"].clone(), search_text_from_detail(&detail)))
}
fn parse_legacy_claude_detail(path: &Path, source: &Source, value: Value) -> Option<Value> {
    let id = string_at(&value, &["sessionId"]).or_else(|| string_at(&value, &["id"]))?;
    let timestamp = legacy_timestamp(&value, &["startedAt", "createdAt", "timestamp"]);
    let cwd = string_at(&value, &["projectPath"]).or_else(|| string_at(&value, &["cwd"]));
    let mut state = ParseState::new(path);
    state.id = id.clone();
    if let Some(value) = timestamp.as_ref() {
        state.timestamp = value.clone();
        state.last_timestamp = value.clone();
    }
    if let Some(value) = cwd {
        state.cwd = value;
    }

    let has_entries = value.get("entries").and_then(Value::as_array).is_some();
    let mut messages = value
        .get("entries")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|record| state.accept(record))
        .collect::<Vec<_>>();
    let mut raw_events = vec![json!({
        "line_number": Value::Null,
        "timestamp": nullable_string(&state.timestamp),
        "type": "info",
        "payload": { "message": "Legacy Claude Code metadata; full project transcript is unavailable." }
    })];
    if !has_entries {
        if let Some(text) =
            string_at(&value, &["prompt"]).or_else(|| string_at(&value, &["message"]))
        {
            let timestamp = state.timestamp.clone();
            if let Some(message) = state.accept_message(message_value(
                "user", &text, &timestamp, "legacy", "prompt", false,
            )) {
                messages.push(message);
            }
            raw_events.push(json!({
                "line_number": 1,
                "timestamp": nullable_string(&timestamp),
                "type": "user",
                "payload": { "message": text }
            }));
        }
    }

    let history_path = path
        .parent()
        .and_then(|parent| parent.parent())
        .map(|root| root.join("history.jsonl"));
    if let Some(history_path) = history_path {
        match File::open(&history_path) {
            Ok(file) => {
                for (index, line) in BufReader::new(file).lines().enumerate() {
                    let line = match line {
                        Ok(line) => line,
                        Err(error) => {
                            raw_events.push(json!({
                                "line_number": index + 1,
                                "timestamp": Value::Null,
                                "type": "parse_error",
                                "payload": { "message": error.to_string() }
                            }));
                            continue;
                        }
                    };
                    let record: Value = match serde_json::from_str(&line) {
                        Ok(record) => record,
                        Err(error) => {
                            raw_events.push(json!({
                                "line_number": index + 1,
                                "timestamp": Value::Null,
                                "type": "parse_error",
                                "payload": { "message": error.to_string(), "raw_line": line }
                            }));
                            continue;
                        }
                    };
                    if record
                        .get("sessionId")
                        .or_else(|| record.get("session_id"))
                        .and_then(Value::as_str)
                        != Some(id.as_str())
                    {
                        continue;
                    }
                    let record_timestamp =
                        legacy_timestamp(&record, &["timestamp"]).unwrap_or_default();
                    if !record_timestamp.is_empty() {
                        if state.timestamp.is_empty() {
                            state.timestamp = record_timestamp.clone();
                        }
                        state.last_timestamp = record_timestamp.clone();
                    }
                    raw_events.push(json!({
                        "line_number": index + 1,
                        "timestamp": nullable_string(&record_timestamp),
                        "type": "user_input",
                        "payload": {
                            "display": record.get("display").cloned().unwrap_or(Value::Null),
                            "project": record.get("project").cloned().unwrap_or(Value::Null),
                            "pasted_contents": record.get("pastedContents").cloned().unwrap_or_else(|| json!({}))
                        }
                    }));
                    if let Some(display) = record.get("display").and_then(Value::as_str) {
                        if let Some(message) = state.accept_message(message_value(
                            "user",
                            display,
                            &record_timestamp,
                            "user_input",
                            "display",
                            false,
                        )) {
                            messages.push(message);
                        }
                    }
                }
            }
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                eprintln!(
                    "无法读取旧版 Claude history（{}）：{error}",
                    history_path.display()
                );
            }
            Err(_) => {}
        }
    }

    state.event_count = raw_events.len();
    let mut summary = state.summary(path, source);
    summary["legacy_format"] = Value::Bool(true);
    Some(json!({
        "summary": summary,
        "conversation_messages": messages,
        "raw_events": raw_events
    }))
}

fn legacy_timestamp(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        let value = value.get(*key)?;
        if let Some(text) = value.as_str().filter(|text| !text.is_empty()) {
            if let Ok(milliseconds) = text.parse::<i64>() {
                return timestamp_from_millis(milliseconds).or_else(|| Some(text.to_owned()));
            }
            return Some(text.to_owned());
        }
        value.as_i64().and_then(timestamp_from_millis)
    })
}

fn timestamp_from_millis(milliseconds: i64) -> Option<String> {
    Utc.timestamp_millis_opt(milliseconds)
        .single()
        .map(|value| value.to_rfc3339_opts(SecondsFormat::Millis, true))
}

fn parse_gemini_source(source: &Source) -> Result<Vec<Value>, String> {
    let mut grouped: HashMap<String, Vec<(PathBuf, Value)>> = HashMap::new();
    for entry in WalkDir::new(source.root.join("tmp"))
        .max_depth(3)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file() || entry.file_name() != "logs.json" {
            continue;
        }
        let logs: Value =
            match serde_json::from_reader(File::open(entry.path()).map_err(error_text)?) {
                Ok(value) => value,
                Err(error) => {
                    eprintln!(
                        "无法解析 Gemini 日志（{}）：{error}",
                        entry.path().display()
                    );
                    continue;
                }
            };
        for item in logs.as_array().into_iter().flatten() {
            if let Some(id) = item.get("sessionId").and_then(Value::as_str) {
                grouped
                    .entry(id.into())
                    .or_default()
                    .push((entry.path().into(), item.clone()));
            }
        }
    }
    let mut results = Vec::new();
    for (session_id, mut items) in grouped {
        items.sort_by_key(|(_, item)| {
            item.get("messageId")
                .and_then(Value::as_i64)
                .unwrap_or_default()
        });
        let path = items.first().map(|item| item.0.clone()).unwrap_or_default();
        let mut state = ParseState::new(&path);
        let mut messages = Vec::new();
        let mut events = Vec::new();
        for (index, (_, record)) in items.into_iter().enumerate() {
            messages.extend(state.accept(&record));
            events.push(json!({ "line_number": index + 1, "timestamp": record.get("timestamp").cloned().unwrap_or(Value::Null), "type": record.get("type").and_then(Value::as_str).unwrap_or("unknown"), "payload": record }));
        }
        enrich_gemini_with_brain(&source.root, &session_id, &mut state, &mut messages);
        let summary = state.summary(&path, source);
        results.push(
            json!({ "summary": summary, "conversation_messages": messages, "raw_events": events }),
        );
    }
    Ok(results)
}

fn enrich_gemini_with_brain(
    root: &Path,
    session_id: &str,
    state: &mut ParseState,
    messages: &mut Vec<Value>,
) {
    if session_id.is_empty()
        || matches!(session_id, "." | "..")
        || session_id
            .chars()
            .any(|value| matches!(value, '/' | '\\' | ':'))
    {
        return;
    }
    let brain_dir = root.join("antigravity").join("brain").join(session_id);
    let Ok(entries) = fs::read_dir(&brain_dir) else {
        return;
    };
    for entry in entries.flatten() {
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
        let artifact_path = entry.path();
        let Ok(prompt) = fs::read_to_string(&artifact_path) else {
            continue;
        };
        let prompt = prompt.trim().to_owned();
        if !prompt.is_empty() {
            let prefix = prompt.chars().take(80).collect::<String>();
            let duplicate = messages.iter().any(|message| {
                message["role"].as_str() == Some("user")
                    && message["text"]
                        .as_str()
                        .is_some_and(|text| text.contains(&prefix))
            });
            if !duplicate {
                let timestamp = fs::read_to_string(brain_dir.join(format!("{name}.metadata.json")))
                    .ok()
                    .and_then(|content| serde_json::from_str::<Value>(&content).ok())
                    .and_then(|metadata| legacy_timestamp(&metadata, &["updatedAt"]))
                    .unwrap_or_default();
                append_gemini_message(
                    state, messages, "user", &prompt, &timestamp, "artifact", &name,
                );
            }
        }

        let resolved_path = brain_dir.join(format!("{name}.resolved"));
        append_gemini_resolved(state, messages, &resolved_path, &name);
        let mut index = 0;
        loop {
            let fragment = PathBuf::from(format!("{}.{}", resolved_path.display(), index));
            if !fragment.is_file() {
                break;
            }
            append_gemini_resolved(state, messages, &fragment, &name);
            index += 1;
        }
    }
}

fn append_gemini_resolved(
    state: &mut ParseState,
    messages: &mut Vec<Value>,
    path: &Path,
    artifact_name: &str,
) {
    let Ok(text) = fs::read_to_string(path) else {
        return;
    };
    let text = text.trim();
    if !text.is_empty() {
        append_gemini_message(
            state,
            messages,
            "assistant",
            text,
            "",
            "resolved",
            artifact_name,
        );
    }
}

fn append_gemini_message(
    state: &mut ParseState,
    messages: &mut Vec<Value>,
    role: &str,
    text: &str,
    timestamp: &str,
    source_type: &str,
    source_subtype: &str,
) {
    if let Some(message) = state.accept_message(message_value(
        role,
        text,
        timestamp,
        source_type,
        source_subtype,
        false,
    )) {
        messages.push(message);
    }
}

fn conversation_messages(
    record: &Value,
    timestamp: &str,
    tool_names: &mut HashMap<String, String>,
) -> Vec<Value> {
    let record_type = record
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let message = record.get("message");
    if matches!(record_type, "user" | "assistant") && message.is_some_and(Value::is_object) {
        let message = message.unwrap_or(&Value::Null);
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or(record_type);
        let synthetic = record.get("isMeta").and_then(Value::as_bool) == Some(true)
            || record.get("isSidechain").and_then(Value::as_bool) == Some(true);
        let blocks = message
            .get("content")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_else(|| vec![message.get("content").cloned().unwrap_or(Value::Null)]);
        let mut messages = Vec::new();
        for block in blocks {
            if let Some(text) = block.as_str().filter(|text| !text.trim().is_empty()) {
                messages.push(message_value(
                    role,
                    text,
                    timestamp,
                    record_type,
                    "text",
                    synthetic,
                ));
                continue;
            }
            let Some(kind) = block.get("type").and_then(Value::as_str) else {
                continue;
            };
            match kind {
                "tool_use" => {
                    let name = block
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown_tool");
                    let id = block.get("id").and_then(Value::as_str).unwrap_or_default();
                    if !id.is_empty() {
                        tool_names.insert(id.into(), name.into());
                    }
                    let input = serde_json::to_string(block.get("input").unwrap_or(&Value::Null))
                        .unwrap_or_default();
                    let mut value = message_value(
                        "tool",
                        &format!("[{name}] {input}"),
                        timestamp,
                        record_type,
                        kind,
                        synthetic,
                    );
                    value["tool_name"] = Value::String(name.into());
                    value["tool_kind"] = Value::String("tool_call".into());
                    if !id.is_empty() {
                        value["tool_call_id"] = Value::String(id.into());
                    }
                    messages.push(value);
                }
                "tool_result" => {
                    let id = block
                        .get("tool_use_id")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let name = tool_names
                        .get(id)
                        .map(String::as_str)
                        .unwrap_or(if id.is_empty() { "tool_result" } else { id });
                    let text = extract_text(block.get("content").unwrap_or(&Value::Null))
                        .unwrap_or_else(|| {
                            serde_json::to_string(block.get("content").unwrap_or(&Value::Null))
                                .unwrap_or_default()
                        });
                    let mut value =
                        message_value("tool", &text, timestamp, record_type, kind, synthetic);
                    value["tool_name"] = Value::String(name.into());
                    value["tool_kind"] = Value::String("tool_result".into());
                    if !id.is_empty() {
                        value["tool_call_id"] = Value::String(id.into());
                    }
                    if block.get("is_error").and_then(Value::as_bool) == Some(true) {
                        value["is_error"] = Value::Bool(true);
                    }
                    messages.push(value);
                }
                "thinking" => {
                    if let Some(text) = extract_text(&block).filter(|text| !text.trim().is_empty())
                    {
                        messages.push(message_value(
                            "assistant",
                            &text,
                            timestamp,
                            record_type,
                            kind,
                            true,
                        ));
                    }
                }
                _ => {
                    if let Some(text) = extract_text(&block).filter(|text| !text.trim().is_empty())
                    {
                        messages.push(message_value(
                            role,
                            &text,
                            timestamp,
                            record_type,
                            kind,
                            synthetic,
                        ));
                    }
                }
            }
        }
        return messages;
    }
    generic_conversation_message(record, timestamp, tool_names)
        .into_iter()
        .collect()
}

fn message_value(
    role: &str,
    text: &str,
    timestamp: &str,
    source_type: &str,
    subtype: &str,
    synthetic: bool,
) -> Value {
    json!({ "role": role, "text": text.trim(), "timestamp": nullable_string(timestamp), "source_type": source_type, "source_subtype": subtype, "synthetic_context": synthetic || role == "developer" || (role == "user" && is_synthetic_context(text)) })
}

fn generic_conversation_message(
    record: &Value,
    timestamp: &str,
    tool_names: &mut HashMap<String, String>,
) -> Option<Value> {
    let record_type = record
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let payload = record.get("payload").unwrap_or(record);
    let message = record
        .get("message")
        .unwrap_or(payload.get("message").unwrap_or(payload));
    let subtype = if matches!(record_type, "result" | "system") {
        record
            .get("subtype")
            .and_then(Value::as_str)
            .unwrap_or(record_type)
    } else {
        payload
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or(record_type)
    };
    let role = message
        .get("role")
        .and_then(Value::as_str)
        .or_else(|| record.get("role").and_then(Value::as_str))
        .unwrap_or(if matches!(record_type, "result" | "system") {
            "system"
        } else {
            match subtype {
                "user" | "user_message" => "user",
                "assistant" | "agent_message" | "model" => "assistant",
                "tool_use"
                | "tool_result"
                | "tool_call"
                | "function_call"
                | "function_call_output" => "tool",
                "error" | "result" => "system",
                _ => "unknown",
            }
        });
    let call_id = string_at(payload, &["call_id"])
        .or_else(|| string_at(payload, &["tool_use_id"]))
        .or_else(|| string_at(payload, &["id"]));
    let tool_name = string_at(payload, &["name"])
        .or_else(|| string_at(payload, &["tool_name"]))
        .or_else(|| call_id.as_ref().and_then(|id| tool_names.get(id).cloned()));
    if matches!(subtype, "function_call" | "tool_call" | "tool_use") {
        if let (Some(id), Some(name)) = (&call_id, &tool_name) {
            tool_names.insert(id.clone(), name.clone());
        }
    }
    let text = extract_text(message.get("content").unwrap_or(message))
        .or_else(|| extract_text(payload.get("content").unwrap_or(payload)))
        .or_else(|| string_at(payload, &["message"]))
        .or_else(|| string_at(payload, &["output"]))
        .or_else(|| string_at(payload, &["arguments"]))
        .or_else(|| extract_text(record.get("result").unwrap_or(&Value::Null)))
        .or_else(|| extract_text(record.get("error").unwrap_or(&Value::Null)))?;
    if text.trim().is_empty() {
        return None;
    }
    let synthetic = role == "developer" || (role == "user" && is_synthetic_context(&text));
    let mut value = json!({ "role": role, "text": text.trim(), "timestamp": nullable_string(timestamp), "source_type": record_type, "source_subtype": subtype, "synthetic_context": synthetic });
    if let Some(name) = tool_name {
        value["tool_name"] = Value::String(name);
    }
    if let Some(id) = call_id {
        value["tool_call_id"] = Value::String(id);
    }
    if role == "tool" {
        value["tool_kind"] = Value::String(subtype.into());
    }
    if subtype == "error"
        || record.get("is_error").and_then(Value::as_bool) == Some(true)
        || record_type == "result" && subtype.starts_with("error")
        || record_type == "system" && subtype.contains("error")
    {
        value["is_error"] = Value::Bool(true);
    }
    Some(value)
}
fn extract_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Array(items) => {
            let text = items
                .iter()
                .filter_map(extract_text)
                .collect::<Vec<_>>()
                .join("\n\n");
            (!text.is_empty()).then_some(text)
        }
        Value::Object(object) => object
            .get("text")
            .and_then(extract_text)
            .or_else(|| object.get("thinking").and_then(extract_text))
            .or_else(|| object.get("content").and_then(extract_text))
            .or_else(|| object.get("summary").and_then(extract_text)),
        _ => None,
    }
}
fn truncate_message(message: &mut Value) {
    let Some(text) = message["text"].as_str() else {
        return;
    };
    if text.chars().count() <= DETAIL_TEXT_LIMIT {
        return;
    }
    let original = text.chars().count();
    message["text"] = Value::String(text.chars().take(DETAIL_TEXT_LIMIT).collect());
    message["text_truncated"] = Value::Bool(true);
    message["original_text_chars"] = json!(original);
}
fn append_limited(target: &mut String, values: &[&str], limit: usize) {
    for value in values {
        if target.len() >= limit {
            return;
        }
        let remaining = limit - target.len();
        let chunk = if value.len() <= remaining {
            *value
        } else {
            let mut end = remaining;
            while end > 0 && !value.is_char_boundary(end) {
                end -= 1;
            }
            &value[..end]
        };
        target.push_str(chunk);
        target.push('\n');
    }
}
fn summary_search_text(summary: &Value) -> String {
    [
        "id",
        "_key",
        "title",
        "preview_text",
        "cwd",
        "file_path",
        "source_kind",
        "display_source",
        "model_provider",
        "source",
        "originator",
    ]
    .iter()
    .filter_map(|key| summary[*key].as_str())
    .collect::<Vec<_>>()
    .join("\n")
}
fn search_text_from_detail(detail: &Value) -> String {
    let mut text = summary_search_text(&detail["summary"]);
    for message in detail["conversation_messages"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|message| message["synthetic_context"] != true)
    {
        append_limited(
            &mut text,
            &[
                message["role"].as_str().unwrap_or_default(),
                message["text"].as_str().unwrap_or_default(),
            ],
            SEARCH_TEXT_LIMIT,
        );
    }
    text
}
fn compact_title(text: &str, limit: usize) -> String {
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
fn compact(text: &str, limit: usize) -> String {
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
fn is_synthetic_context(text: &str) -> bool {
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
fn string_at(value: &Value, path: &[&str]) -> Option<String> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    current.as_str().map(ToOwned::to_owned)
}
fn nullable_string(value: &str) -> Value {
    if value.is_empty() {
        Value::Null
    } else {
        Value::String(value.into())
    }
}
fn timestamp_of(summary: &Value) -> &str {
    summary["timestamp"]
        .as_str()
        .or_else(|| summary["last_timestamp"].as_str())
        .unwrap_or_default()
}
fn matches_filters(summary: &Value, query: &HashMap<String, String>) -> bool {
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
        if !timestamp_of(summary).starts_with(date) {
            return false;
        }
    }
    if summary["archived"] == true && !bool_query(query, "show_codex_archived") {
        return false;
    }
    if summary["hidden"] == true && !bool_query(query, "show_hidden") {
        return false;
    }
    true
}
fn bool_query(query: &HashMap<String, String>, key: &str) -> bool {
    matches!(query.get(key).map(String::as_str), Some("1" | "true"))
}
fn paginate(mut sessions: Vec<Value>, query: &HashMap<String, String>, mut base: Value) -> Value {
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
fn search_snippet(text: &str, needle: &str) -> String {
    let Some(byte_index) = text
        .find(needle)
        .or_else(|| needle.split_whitespace().find_map(|term| text.find(term)))
    else {
        return String::new();
    };
    let char_index = text[..byte_index].chars().count();
    text.chars()
        .skip(char_index.saturating_sub(60))
        .take(160)
        .collect()
}
fn search_query_matches(text: &str, query: &str) -> bool {
    let text = text.to_lowercase();
    query
        .to_lowercase()
        .split_whitespace()
        .all(|term| text.contains(term))
}
fn insert_string(target: &mut BTreeSet<String>, value: &Value) {
    if let Some(value) = value.as_str().filter(|value| !value.is_empty()) {
        target.insert(value.into());
    }
}
fn increment(target: &mut HashMap<String, u64>, value: &Value) {
    if let Some(value) = value.as_str().filter(|value| !value.is_empty()) {
        *target.entry(value.into()).or_default() += 1;
    }
}
fn count_values(values: HashMap<String, u64>, limit: usize) -> Vec<Value> {
    let mut values = values.into_iter().collect::<Vec<_>>();
    values.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0)));
    values
        .into_iter()
        .take(limit)
        .map(|(label, count)| json!({ "label": label, "count": count }))
        .collect()
}
fn error_text(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use serde_json::json;
    use tempfile::tempdir;

    use super::{
        compact, generic_conversation_message, is_synthetic_context, parse_detail,
        parse_gemini_source, parse_summary, search_query_matches, DetailCache, HeadTail,
        SessionStore, Source, SourceFormat, DETAIL_CACHE_BYTES, DETAIL_EVENT_LIMIT,
        DETAIL_MESSAGE_LIMIT,
    };
    use std::collections::{BTreeSet, HashMap};
    #[test]
    fn summary_text_has_limit() {
        assert_eq!(compact("abcdefgh", 6), "abc...");
    }
    #[test]
    fn injected_context_is_detected() {
        assert!(is_synthetic_context("<environment_context>test"));
        assert!(is_synthetic_context("<apps_instructions>test"));
        assert!(is_synthetic_context("<plugins_instructions>test"));
        assert!(!is_synthetic_context("正常用户消息"));
    }
    #[test]
    fn head_tail_keeps_boundaries() {
        let mut values = HeadTail::new(4);
        for value in 0..8 {
            values.push(value);
        }
        let (values, omitted, total) = values.finish(99);
        assert_eq!(values, vec![0, 1, 99, 6, 7]);
        assert_eq!((omitted, total), (4, 8));
    }

    #[test]
    fn codex_summary_and_detail_are_streamed() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("session.jsonl");
        let mut file = std::fs::File::create(&path).unwrap();
        for record in [
            json!({ "timestamp": "2026-01-01T00:00:00Z", "type": "session_meta", "payload": { "id": "codex-1", "cwd": "/tmp/project", "model_provider": "custom" } }),
            json!({ "timestamp": "2026-01-01T00:00:01Z", "type": "event_msg", "payload": { "type": "user_message", "message": "修复问题" } }),
            json!({ "timestamp": "2026-01-01T00:00:02Z", "type": "event_msg", "payload": { "type": "agent_message", "message": "已经完成" } }),
        ] {
            writeln!(file, "{}", record).unwrap();
        }
        let source = Source {
            kind: "codex",
            display_name: "Codex",
            root: directory.path().into(),
            format: SourceFormat::Codex,
            archived: false,
        };
        let (summary, search) = parse_summary(&path, &source).unwrap();
        assert_eq!(summary["id"], "codex-1");
        assert_eq!(summary["message_count"], 2);
        assert!(search.contains("已经完成"));
        let detail = parse_detail(&path, &source).unwrap();
        assert_eq!(detail["conversation_messages"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn claude_tool_blocks_keep_tool_semantics() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("claude.jsonl");
        let record = json!({
            "timestamp": "2026-01-01T00:00:00Z", "type": "assistant", "sessionId": "claude-1", "cwd": "/tmp/project",
            "message": { "role": "assistant", "content": [
                { "type": "thinking", "thinking": "内部推理" },
                { "type": "tool_use", "id": "tool-1", "name": "Read", "input": { "path": "a.rs" } }
            ] }
        });
        std::fs::write(&path, format!("{record}\n")).unwrap();
        let source = Source {
            kind: "claude_code",
            display_name: "Claude Code",
            root: directory.path().into(),
            format: SourceFormat::Claude,
            archived: false,
        };
        let detail = parse_detail(&path, &source).unwrap();
        assert_eq!(detail["summary"]["model_provider"], "anthropic");
        assert_eq!(detail["summary"]["tool_count"], 1);
        assert_eq!(detail["conversation_messages"][1]["tool_name"], "Read");
        assert_eq!(
            detail["conversation_messages"][0]["synthetic_context"],
            true
        );
    }

    #[test]
    fn legacy_claude_metadata_reads_history() {
        let directory = tempdir().unwrap();
        let claude_root = directory.path().join(".claude");
        let sessions_root = claude_root.join("sessions");
        std::fs::create_dir_all(&sessions_root).unwrap();
        let path = sessions_root.join("s1.json");
        std::fs::write(
            &path,
            json!({
                "sessionId": "s1",
                "cwd": "/tmp/project",
                "startedAt": 1_767_225_600_000_i64
            })
            .to_string(),
        )
        .unwrap();
        std::fs::write(
            claude_root.join("history.jsonl"),
            concat!(
                "{\"sessionId\":\"other\",\"display\":\"ignore\"}\n",
                "{\"sessionId\":\"s1\",\"timestamp\":1767225601000,\"display\":\"legacy prompt\",\"project\":\"/tmp/project\"}\n"
            ),
        )
        .unwrap();
        let source = Source {
            kind: "claude_code",
            display_name: "Claude Code",
            root: sessions_root,
            format: SourceFormat::Claude,
            archived: false,
        };

        let detail = parse_detail(&path, &source).unwrap();
        assert_eq!(detail["summary"]["legacy_format"], true);
        assert_eq!(detail["summary"]["timestamp"], "2026-01-01T00:00:00.000Z");
        assert_eq!(detail["summary"]["event_count"], 2);
        assert_eq!(detail["conversation_messages"][0]["text"], "legacy prompt");
        assert_eq!(detail["raw_events"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn gemini_brain_artifacts_are_added_to_the_session() {
        let directory = tempdir().unwrap();
        let root = directory.path();
        let log_dir = root.join("tmp").join("queue");
        let brain_dir = root.join("antigravity").join("brain").join("gemini-1");
        std::fs::create_dir_all(&log_dir).unwrap();
        std::fs::create_dir_all(&brain_dir).unwrap();
        std::fs::write(
            log_dir.join("logs.json"),
            json!([
                { "sessionId": "gemini-1", "messageId": 1, "type": "user", "message": "log prompt" }
            ])
            .to_string(),
        )
        .unwrap();
        std::fs::write(brain_dir.join("task.txt"), "artifact prompt").unwrap();
        std::fs::write(
            brain_dir.join("task.txt.metadata.json"),
            json!({ "updatedAt": 1767225602000_i64 }).to_string(),
        )
        .unwrap();
        std::fs::write(brain_dir.join("task.txt.resolved"), "artifact answer").unwrap();
        let source = Source {
            kind: "gemini",
            display_name: "Gemini CLI",
            root: root.into(),
            format: SourceFormat::Gemini,
            archived: false,
        };

        let details = parse_gemini_source(&source).unwrap();
        assert_eq!(details.len(), 1);
        let messages = details[0]["conversation_messages"].as_array().unwrap();
        assert!(messages
            .iter()
            .any(|message| message["text"] == "artifact prompt"));
        assert!(messages
            .iter()
            .any(|message| message["text"] == "artifact answer"));
        assert_eq!(details[0]["summary"]["message_count"], 3);
    }

    #[test]
    fn large_detail_keeps_bounded_head_and_tail() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("large.jsonl");
        let mut file = std::fs::File::create(&path).unwrap();
        writeln!(file, "{}", json!({ "type": "session_meta", "payload": { "id": "large", "model_provider": "custom" } })).unwrap();
        for index in 0..(DETAIL_EVENT_LIMIT + 200) {
            writeln!(file, "{}", json!({ "type": "event_msg", "payload": { "type": "user_message", "message": format!("message-{index}") } })).unwrap();
        }
        let source = Source {
            kind: "codex",
            display_name: "Codex",
            root: directory.path().into(),
            format: SourceFormat::Codex,
            archived: false,
        };
        let detail = parse_detail(&path, &source).unwrap();
        assert!(
            detail["conversation_messages"].as_array().unwrap().len() <= DETAIL_MESSAGE_LIMIT + 1
        );
        assert!(detail["raw_events"].as_array().unwrap().len() <= DETAIL_EVENT_LIMIT + 1);
        assert_eq!(detail["summary"]["detail_truncated"], true);
    }

    #[test]
    fn search_matches_separated_terms() {
        assert!(search_query_matches(
            "Repair provider history safely",
            "repair safely"
        ));
        assert!(search_query_matches("请分析隐藏的子代理会话", "隐藏 会话"));
        assert!(!search_query_matches(
            "Repair history safely",
            "repair provider"
        ));
    }

    #[test]
    fn error_and_result_records_keep_system_semantics() {
        let mut tools = HashMap::new();
        let codex_error = generic_conversation_message(
            &json!({ "type": "event_msg", "payload": { "type": "error", "message": "failed" } }),
            "",
            &mut tools,
        )
        .unwrap();
        assert_eq!(codex_error["role"], "system");
        assert_eq!(codex_error["is_error"], true);

        let claude_result = generic_conversation_message(
            &json!({ "type": "result", "subtype": "error_during_execution", "error": "boom" }),
            "",
            &mut tools,
        )
        .unwrap();
        assert_eq!(claude_result["role"], "system");
        assert_eq!(claude_result["text"], "boom");
        assert_eq!(claude_result["is_error"], true);
    }

    #[test]
    fn file_change_refreshes_only_the_affected_session() {
        let directory = tempdir().unwrap();
        let first = directory.path().join("first.jsonl");
        let second = directory.path().join("second.jsonl");
        let session = |id: &str, message: &str| {
            format!(
                "{}\n{}\n",
                json!({ "type": "session_meta", "payload": { "id": id, "model_provider": "custom" } }),
                json!({ "type": "event_msg", "payload": { "type": "user_message", "message": message } })
            )
        };
        std::fs::write(&first, session("first", "old first")).unwrap();
        std::fs::write(&second, session("second", "keep second")).unwrap();
        let source = Source {
            kind: "codex",
            display_name: "Codex",
            root: directory.path().into(),
            format: SourceFormat::Codex,
            archived: false,
        };
        let mut store = SessionStore {
            summaries: Vec::new(),
            records: HashMap::new(),
            sources: vec![source],
            index_cache: crate::cache::IndexCache::disabled(),
            detail_cache: DetailCache::new(DETAIL_CACHE_BYTES),
        };
        store.refresh().unwrap();
        std::fs::write(&second, "not valid json\n").unwrap();
        std::fs::write(&first, session("first", "new first")).unwrap();

        store
            .refresh_paths(&BTreeSet::from([first.clone()]))
            .unwrap();

        assert!(store.records.contains_key("codex:second"));
        assert!(store.records["codex:first"]
            .search_text
            .contains("new first"));
    }
}
