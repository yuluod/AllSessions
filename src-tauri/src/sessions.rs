use std::{
    collections::{BTreeMap, BTreeSet, HashMap, VecDeque},
    env,
    ffi::OsStr,
    fs::{self, File},
    io::{BufRead, BufReader, BufWriter, Write},
    path::{Component, Path, PathBuf},
};

use chrono::{SecondsFormat, TimeZone, Utc};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;
use walkdir::WalkDir;

use crate::cache::IndexCache;

mod gemini;

const PAGE_LIMIT: usize = 50;
const SEARCH_TEXT_LIMIT: usize = 64_000;
const DETAIL_MESSAGE_LIMIT: usize = 800;
const DETAIL_EVENT_LIMIT: usize = 1_200;
const DETAIL_TEXT_LIMIT: usize = 20_000;
const DETAIL_CACHE_BYTES: usize = 64 * 1024 * 1024;

#[derive(Clone, PartialEq)]
struct Source {
    kind: &'static str,
    display_name: &'static str,
    root: PathBuf,
    format: SourceFormat,
    archived: bool,
}

#[derive(Clone, Copy, PartialEq)]
enum SourceFormat {
    Codex,
    Claude,
    Gemini,
}

#[derive(Clone)]
struct StoredSession {
    summary: Value,
    search_text: String,
    source: Source,
    path: PathBuf,
    detail_locator: Option<gemini::DetailLocator>,
}

#[derive(Default)]
struct SourceScanDiagnostic {
    discovered_paths: BTreeSet<PathBuf>,
    errors: BTreeMap<PathBuf, String>,
    last_error: Option<String>,
}

#[derive(Default)]
struct ScanDiagnostics {
    last_scan_at: String,
    sources: BTreeMap<String, SourceScanDiagnostic>,
}

impl ScanDiagnostics {
    fn started() -> Self {
        Self {
            last_scan_at: scan_timestamp(),
            sources: BTreeMap::new(),
        }
    }

    fn touch(&mut self) {
        self.last_scan_at = scan_timestamp();
    }

    fn discover(&mut self, kind: &str, path: &Path) {
        self.sources
            .entry(kind.to_string())
            .or_default()
            .discovered_paths
            .insert(path.to_path_buf());
    }

    fn record_error(&mut self, kind: &str, path: &Path, error: &str) {
        let diagnostic = self.sources.entry(kind.to_string()).or_default();
        diagnostic
            .errors
            .insert(path.to_path_buf(), error.to_string());
        diagnostic.last_error = Some(error.to_string());
    }

    fn clear_error(&mut self, kind: &str, path: &Path) {
        let Some(diagnostic) = self.sources.get_mut(kind) else {
            return;
        };
        if diagnostic.errors.remove(path).is_some() {
            diagnostic.last_error = diagnostic.errors.values().next_back().cloned();
        }
    }

    fn remove_path(&mut self, kind: &str, path: &Path, include_descendants: bool) {
        let Some(diagnostic) = self.sources.get_mut(kind) else {
            return;
        };
        let matches = |candidate: &PathBuf| {
            candidate == path || (include_descendants && candidate.starts_with(path))
        };
        diagnostic
            .discovered_paths
            .retain(|candidate| !matches(candidate));
        let removed_error = diagnostic.errors.keys().any(&matches);
        diagnostic.errors.retain(|candidate, _| !matches(candidate));
        if removed_error {
            diagnostic.last_error = diagnostic.errors.values().next_back().cloned();
        }
    }
}

pub struct SessionStore {
    summaries: Vec<Value>,
    records: HashMap<String, StoredSession>,
    sources: Vec<Source>,
    sources_config: crate::config::SourceRoots,
    index_cache: IndexCache,
    detail_cache: DetailCache,
    scan_diagnostics: ScanDiagnostics,
}

impl SessionStore {
    pub fn load(config: &crate::config::AppConfig) -> Result<Self, String> {
        let mut store = Self {
            summaries: Vec::new(),
            records: HashMap::new(),
            sources: Vec::new(),
            sources_config: config.sources.clone(),
            index_cache: IndexCache::open()?,
            detail_cache: DetailCache::new(DETAIL_CACHE_BYTES),
            scan_diagnostics: ScanDiagnostics::default(),
        };
        store.refresh()?;
        Ok(store)
    }

    pub fn reconfigure(&mut self, config: &crate::config::AppConfig) -> Result<(), String> {
        self.sources_config = config.sources.clone();
        self.refresh()
    }

    pub fn clear_index_cache(&mut self) {
        self.index_cache.clear();
    }

    pub fn cache_storage(&self) -> Value {
        self.index_cache.storage_info()
    }

    pub fn diagnostics(&self) -> Value {
        let mut sources = BTreeMap::<String, Value>::new();
        for kind in ["codex", "codex_archived", "claude", "gemini"] {
            let enabled = self
                .sources_config
                .get(kind)
                .is_none_or(|roots| !roots.is_empty());
            sources.insert(
                kind.to_string(),
                json!({
                    "enabled": enabled,
                    "declared_roots": 0,
                    "available_roots": 0,
                    "discovered_files": 0,
                    "indexed_sessions": 0,
                    "error_count": 0,
                    "last_error": Value::Null,
                }),
            );
        }
        let lists = root_lists(&self.sources_config).0;
        for (kind, roots) in [
            ("codex", lists.codex.as_slice()),
            ("codex_archived", lists.codex_archived.as_slice()),
            ("claude", lists.claude.as_slice()),
            ("gemini", lists.gemini.as_slice()),
        ] {
            let entry = sources.entry(kind.to_string()).or_insert_with(|| json!({}));
            entry["declared_roots"] = json!(roots.len());
            entry["available_roots"] = json!(roots.iter().filter(|root| root.is_dir()).count());
        }
        for record in self.records.values() {
            let kind = diagnostic_source_kind(record.source.kind);
            if let Some(entry) = sources.get_mut(kind) {
                entry["indexed_sessions"] =
                    json!(entry["indexed_sessions"].as_u64().unwrap_or(0) + 1);
            }
        }
        for (kind, diagnostic) in &self.scan_diagnostics.sources {
            if let Some(entry) = sources.get_mut(kind) {
                entry["discovered_files"] = json!(diagnostic.discovered_paths.len());
                entry["error_count"] = json!(diagnostic.errors.len());
                entry["last_error"] = diagnostic
                    .last_error
                    .as_ref()
                    .map_or(Value::Null, |value| Value::String(value.clone()));
            }
        }
        json!({
            "last_scan_at": if self.scan_diagnostics.last_scan_at.is_empty() {
                Value::Null
            } else {
                Value::String(self.scan_diagnostics.last_scan_at.clone())
            },
            "sources": sources,
        })
    }

    pub fn watch_roots(&self) -> Vec<PathBuf> {
        watch_roots_for(&self.sources_config)
    }

    pub fn refresh(&mut self) -> Result<(), String> {
        // 来源目录可能在启动后才被创建（例如首次运行 Codex/Claude/Gemini），
        // 每次刷新都按当前配置重新解析，而不是沿用启动时的快照。
        self.resolve_sources();
        let mut diagnostics = ScanDiagnostics::started();
        let mut next = HashMap::new();
        let mut active_paths = BTreeSet::new();
        for source in &self.sources {
            let diagnostic_kind = diagnostic_source_kind(source.kind).to_string();
            if matches!(source.format, SourceFormat::Gemini) {
                let parsed = match gemini::parse_source(source, &self.index_cache) {
                    Ok(parsed) => parsed,
                    Err(error) => {
                        diagnostics.record_error(&diagnostic_kind, &source.root, &error);
                        eprintln!("无法解析 Gemini 来源：{error}");
                        continue;
                    }
                };
                for path in &parsed.active_paths {
                    diagnostics.discover(&diagnostic_kind, Path::new(path));
                    active_paths.insert(path.clone());
                    active_paths.insert(path_identity(Path::new(path)));
                }
                for (path, error) in &parsed.errors {
                    diagnostics.record_error(&diagnostic_kind, path, error);
                }
                for session in parsed.sessions {
                    let key = session.summary["_key"]
                        .as_str()
                        .unwrap_or_default()
                        .to_string();
                    next.entry(key).or_insert_with(|| StoredSession {
                        search_text: session.search_text,
                        summary: session.summary,
                        source: source.clone(),
                        path: session.path,
                        detail_locator: Some(session.detail_locator),
                    });
                }
                continue;
            }
            for path in discover_files(source) {
                diagnostics.discover(&diagnostic_kind, &path);
                let path_key = path_identity(&path);
                if !active_paths.insert(path_key) {
                    continue;
                }
                active_paths.insert(path.to_string_lossy().into_owned());
                let metadata = match fs::metadata(&path) {
                    Ok(value) => value,
                    Err(error) => {
                        diagnostics.record_error(
                            &diagnostic_kind,
                            &path,
                            &format!("无法读取文件元数据：{error}"),
                        );
                        continue;
                    }
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
                        next.entry(key).or_insert_with(|| StoredSession {
                            summary,
                            search_text,
                            source: source.clone(),
                            path,
                            detail_locator: None,
                        });
                    }
                    Err(error) => {
                        diagnostics.record_error(&diagnostic_kind, &path, &error);
                        eprintln!("无法解析会话摘要（{}）：{error}", path.display());
                    }
                }
            }
        }
        self.index_cache.prune(&active_paths);
        self.records = next;
        self.scan_diagnostics = diagnostics;
        self.rebuild_summaries();
        Ok(())
    }

    pub fn refresh_paths(&mut self, paths: &BTreeSet<PathBuf>) -> Result<bool, String> {
        // 来源集合变化时，事件路径无法可靠匹配新旧来源，继续走增量更新
        // 会让旧目录的 records 残留（新旧会话混列、已删文件变幽灵会话），
        // 直接全量重建。
        if self.resolve_sources() {
            self.refresh()?;
            return Ok(true);
        }
        // Gemini 会话可能跨文件，Claude 新旧布局也可能包含相同会话 ID。
        // 单路径更新无法可靠重建聚合结果或来源优先级，因此复用缓存全量刷新。
        if paths.iter().any(|path| {
            self.sources.iter().any(|source| {
                matches!(source.format, SourceFormat::Gemini | SourceFormat::Claude)
                    && path.starts_with(&source.root)
            })
        }) {
            self.refresh()?;
            return Ok(true);
        }

        self.scan_diagnostics.touch();
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
            let diagnostic_kind = diagnostic_source_kind(source.kind);
            let affected = self
                .records
                .iter()
                .filter(|(_, record)| {
                    record.path == *path || (!path.exists() && record.path.starts_with(path))
                })
                .map(|(key, record)| (key.clone(), record.path.clone()))
                .collect::<Vec<_>>();
            if !path.is_file() || !source_matches_path(&source, path) {
                self.scan_diagnostics
                    .remove_path(diagnostic_kind, path, !path.exists());
                for (key, record_path) in affected {
                    self.records.remove(&key);
                    self.index_cache.remove(&record_path);
                    changed = true;
                }
                continue;
            }
            self.scan_diagnostics.discover(diagnostic_kind, path);
            let metadata = fs::metadata(path).map_err(|error| {
                let error = error_text(error);
                self.scan_diagnostics.record_error(
                    diagnostic_kind,
                    path,
                    &format!("无法读取文件元数据：{error}"),
                );
                error
            })?;
            let (summary, search_text) = parse_summary(path, &source).inspect_err(|error| {
                self.scan_diagnostics
                    .record_error(diagnostic_kind, path, error);
            })?;
            self.scan_diagnostics.clear_error(diagnostic_kind, path);
            for (key, record_path) in affected {
                self.records.remove(&key);
                self.index_cache.remove(&record_path);
            }
            self.index_cache
                .put(path, source.kind, &metadata, &summary, &search_text);
            let key = summary["_key"].as_str().unwrap_or_default().to_string();
            self.records.entry(key).or_insert_with(|| StoredSession {
                summary,
                search_text,
                source,
                path: path.clone(),
                detail_locator: None,
            });
            changed = true;
        }
        if changed {
            self.rebuild_summaries();
        }
        Ok(changed)
    }

    /// 按当前配置重新解析来源，返回来源集合是否发生变化
    /// （例如用户在设置中调整来源根目录）。
    fn resolve_sources(&mut self) -> bool {
        let sources = configured_sources(&self.sources_config);
        if sources != self.sources {
            self.sources = sources;
            true
        } else {
            false
        }
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
        let resolved = self.resolve_record_key(key)?;
        if let Some(detail) = self.detail_cache.get(&resolved) {
            return Some(detail);
        }
        let record = self.records.get(&resolved)?;
        let detail = if let Some(locator) = &record.detail_locator {
            gemini::parse_detail(&record.source, locator).ok()
        } else {
            parse_detail(&record.path, &record.source).ok()
        }?;
        let size = serde_json::to_vec(&detail)
            .map(|value| value.len())
            .unwrap_or_default();
        self.detail_cache.insert(resolved, detail.clone(), size);
        Some(detail)
    }

    fn resolve_record_key(&self, key: &str) -> Option<String> {
        if self.records.contains_key(key) {
            return Some(key.to_string());
        }
        let matches = self
            .records
            .iter()
            .filter(|(_, record)| record.summary["id"].as_str() == Some(key))
            .map(|(key, _)| key.clone())
            .collect::<Vec<_>>();
        (matches.len() == 1).then(|| matches[0].clone())
    }

    pub fn delete_session(&mut self, key: &str) -> Result<Value, String> {
        let resolved = self
            .resolve_record_key(key)
            .ok_or_else(|| "会话不存在或标识不唯一".to_string())?;
        let record = self
            .records
            .get(&resolved)
            .cloned()
            .ok_or_else(|| "会话不存在".to_string())?;
        let current_summary = if record.detail_locator.is_none() {
            let (summary, _) = parse_summary(&record.path, &record.source)?;
            if summary["_key"].as_str() != Some(resolved.as_str()) {
                return Err("原始文件已经变化；请刷新列表后重试".into());
            }
            Some(summary)
        } else {
            None
        };
        let backup_paths = if let Some(locator) = &record.detail_locator {
            gemini::session_backup_paths(&record.source, locator)?
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
            gemini::delete_session(&record.source, locator)?
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
        self.refresh()?;
        Ok(json!({ "ok": true, "deleted_files": deleted_files, "backup": backup }))
    }

    pub fn delete_message(&mut self, key: &str, message_key: &str) -> Result<Value, String> {
        let resolved = self
            .resolve_record_key(key)
            .ok_or_else(|| "会话不存在或标识不唯一".to_string())?;
        let detail = self
            .detail(&resolved)
            .ok_or_else(|| "无法读取会话详情".to_string())?;
        let message = detail["conversation_messages"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|message| message["_message_key"].as_str() == Some(message_key))
            .ok_or_else(|| "消息不存在或当前详情未包含该消息".to_string())?;
        let delete_ref = message
            .get("_delete_ref")
            .cloned()
            .ok_or_else(|| "该消息不支持删除原始数据".to_string())?;
        let record = self
            .records
            .get(&resolved)
            .cloned()
            .ok_or_else(|| "会话不存在".to_string())?;
        let backup_paths = if let Some(locator) = &record.detail_locator {
            gemini::message_backup_paths(&record.source, locator, &delete_ref)?
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
            gemini::delete_message(&record.source, locator, &delete_ref)?;
        } else if record.path.extension().and_then(|value| value.to_str()) == Some("json") {
            delete_legacy_message(&record.path, &delete_ref)?;
        } else {
            delete_jsonl_message(&record.path, &delete_ref)?;
        }
        self.index_cache.remove(&record.path);
        self.refresh()?;
        Ok(json!({ "ok": true, "backup": backup }))
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
            if let Some(date) = local_date_key(timestamp_of(summary)) {
                dates.insert(date);
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
        let mut seen_source_kinds = BTreeSet::new();
        let sources = self
            .sources
            .iter()
            // 尚未创建的目录不进入来源筛选，避免展示永远为空的选项
            .filter(|source| source.root.exists())
            .filter(|source| seen_source_kinds.insert(source.kind))
            .map(|source| json!({ "kind": source.kind, "display_name": source.display_name }))
            .collect::<Vec<_>>();
        json!({ "session_roots": self.session_roots(), "sources": sources, "providers": providers, "source_kinds": source_kinds, "dates": date_values, "cwds": cwds, "hidden_reasons": hidden_reasons, "projects": project_values })
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
            if let Some(date) = local_date_key(timestamp_of(summary)) {
                *by_date.entry(date).or_insert(0_u64) += 1;
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
            .filter(|source| source.root.exists())
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
                for (message_index, mut message) in state.accept(&record).into_iter().enumerate() {
                    attach_message_delete_ref(
                        &mut message,
                        json!({
                            "kind": "jsonl_record",
                            "line_number": index + 1,
                            "message_index": message_index,
                            "record_fingerprint": json_fingerprint(&record),
                        }),
                    );
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

pub(crate) struct RootLists {
    pub codex: Vec<PathBuf>,
    pub codex_archived: Vec<PathBuf>,
    pub claude: Vec<PathBuf>,
    pub gemini: Vec<PathBuf>,
}

fn resolve_kind(
    config_roots: Option<&Vec<String>>,
    env_key: &str,
    fallback: PathBuf,
) -> (Vec<PathBuf>, &'static str) {
    if let Some(roots) = config_roots {
        return (
            roots
                .iter()
                .map(|raw| expand_tilde(PathBuf::from(raw)))
                .filter(|path| !path.as_os_str().is_empty())
                .collect(),
            "config",
        );
    }
    if let Some(value) = env::var_os(env_key) {
        return (split_path_list(&value), "env");
    }
    (vec![fallback], "default")
}

fn root_lists(config: &crate::config::SourceRoots) -> (RootLists, Value) {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    let codex_home = env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .map(expand_tilde)
        .unwrap_or_else(|| home.join(".codex"));
    let (codex, codex_origin) = resolve_kind(
        config.get("codex"),
        "CODEX_SESSIONS_DIR",
        codex_home.join("sessions"),
    );
    let (codex_archived, codex_archived_origin) = resolve_kind(
        config.get("codex_archived"),
        "CODEX_ARCHIVED_SESSIONS_DIR",
        codex_home.join("archived_sessions"),
    );
    let (claude, claude_origin) = resolve_kind(
        config.get("claude"),
        "CLAUDE_SESSIONS_DIR",
        home.join(".claude"),
    );
    let (gemini, gemini_origin) = resolve_kind(
        config.get("gemini"),
        "GEMINI_SESSIONS_DIR",
        home.join(".gemini"),
    );
    let description = json!({
        "codex": { "roots": codex.iter().map(|path| path.to_string_lossy()).collect::<Vec<_>>(), "origin": codex_origin },
        "codex_archived": { "roots": codex_archived.iter().map(|path| path.to_string_lossy()).collect::<Vec<_>>(), "origin": codex_archived_origin },
        "claude": { "roots": claude.iter().map(|path| path.to_string_lossy()).collect::<Vec<_>>(), "origin": claude_origin },
        "gemini": { "roots": gemini.iter().map(|path| path.to_string_lossy()).collect::<Vec<_>>(), "origin": gemini_origin },
    });
    (
        RootLists {
            codex,
            codex_archived,
            claude,
            gemini,
        },
        description,
    )
}

pub(crate) fn describe_sources(config: &crate::config::SourceRoots) -> Value {
    root_lists(config).1
}

pub(crate) fn describe_inherited_sources() -> Value {
    root_lists(&crate::config::SourceRoots::default()).1
}

fn source_root_identity(path: PathBuf) -> String {
    let expanded = expand_tilde(path);
    let absolute = if expanded.is_absolute() {
        expanded
    } else {
        env::current_dir()
            .map(|current| current.join(&expanded))
            .unwrap_or(expanded)
    };
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() && !normalized.has_root() {
                    normalized.push(component.as_os_str());
                }
            }
            _ => normalized.push(component.as_os_str()),
        }
    }
    let identity = path_identity(&normalized);
    if cfg!(windows) {
        identity.to_lowercase()
    } else {
        identity
    }
}

fn describe_protected_source_roots(configured: &[String], inherited: &[PathBuf]) -> Vec<String> {
    let inherited_identities = inherited
        .iter()
        .cloned()
        .map(source_root_identity)
        .collect::<BTreeSet<_>>();
    configured
        .iter()
        .filter(|root| {
            inherited_identities.contains(&source_root_identity(PathBuf::from(root.as_str())))
        })
        .cloned()
        .collect()
}

pub(crate) fn describe_protected_sources(config: &crate::config::SourceRoots) -> Value {
    let inherited = root_lists(&crate::config::SourceRoots::default()).0;
    json!({
        "codex": describe_protected_source_roots(config.codex.as_deref().unwrap_or_default(), &inherited.codex),
        "codex_archived": describe_protected_source_roots(config.codex_archived.as_deref().unwrap_or_default(), &inherited.codex_archived),
        "claude": describe_protected_source_roots(config.claude.as_deref().unwrap_or_default(), &inherited.claude),
        "gemini": describe_protected_source_roots(config.gemini.as_deref().unwrap_or_default(), &inherited.gemini),
    })
}

fn configured_sources(config: &crate::config::SourceRoots) -> Vec<Source> {
    let lists = root_lists(config).0;
    sources_from_paths(
        &lists.codex,
        &lists.codex_archived,
        &lists.claude,
        &lists.gemini,
    )
}
fn sources_from_paths(
    codex_roots: &[PathBuf],
    codex_archived_roots: &[PathBuf],
    claude_roots: &[PathBuf],
    gemini_roots: &[PathBuf],
) -> Vec<Source> {
    codex_roots
        .iter()
        .map(|root| Source {
            kind: "codex",
            display_name: "Codex",
            root: root.clone(),
            format: SourceFormat::Codex,
            archived: false,
        })
        .chain(codex_archived_roots.iter().map(|root| Source {
            kind: "codex_archived",
            display_name: "Codex Archived",
            root: root.clone(),
            format: SourceFormat::Codex,
            archived: true,
        }))
        .chain(claude_roots.iter().flat_map(|root| {
            [root.join("projects"), root.join("sessions")].map(|root| Source {
                kind: "claude_code",
                display_name: "Claude Code",
                root,
                format: SourceFormat::Claude,
                archived: false,
            })
        }))
        .chain(gemini_roots.iter().map(|root| Source {
            kind: "gemini",
            display_name: "Gemini CLI",
            root: root.clone(),
            format: SourceFormat::Gemini,
            archived: false,
        }))
        // 注意：这里不过滤不存在的目录。来源目录可能在应用启动后才被创建，
        // 保留它们才能在 refresh 时重新发现；不存在的目录由扫描和监听逻辑各自兜底。
        .collect()
}
fn split_path_list(value: &OsStr) -> Vec<PathBuf> {
    env::split_paths(value)
        .map(expand_tilde)
        .filter(|path| !path.as_os_str().is_empty())
        .collect()
}
pub(crate) fn expand_tilde(path: PathBuf) -> PathBuf {
    let Some(text) = path.to_str() else {
        return path;
    };
    if text == "~" {
        return dirs::home_dir().unwrap_or_default();
    }
    if let Some(rest) = text.strip_prefix("~/").or_else(|| {
        if cfg!(windows) {
            text.strip_prefix("~\\")
        } else {
            None
        }
    }) {
        return dirs::home_dir().unwrap_or_default().join(rest);
    }
    path
}

pub(crate) fn path_identity(path: &Path) -> String {
    fs::canonicalize(path)
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|_| path.to_string_lossy().into_owned())
}
fn existing_watch_root(path: &Path) -> Option<PathBuf> {
    let home = dirs::home_dir();
    let mut current = path;
    loop {
        if current.is_dir() {
            // 目录不存在时向上回溯到最近的现有父目录（如 ~/.codex/sessions
            // 尚未创建时监听 ~/.codex），但绝不监听用户主目录或文件系统根，
            // 递归监听这些目录的代价过高。
            if current.parent().is_none() || home.as_deref() == Some(current) {
                return None;
            }
            return Some(current.into());
        }
        current = current.parent()?;
    }
}

pub(crate) fn watch_roots_for(config: &crate::config::SourceRoots) -> Vec<PathBuf> {
    configured_sources(config)
        .iter()
        .filter_map(|source| existing_watch_root(&source.root))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
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
    let mut messages = Vec::new();
    for (entry_index, record) in value
        .get("entries")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
    {
        for (message_index, mut message) in state.accept(record).into_iter().enumerate() {
            attach_message_delete_ref(
                &mut message,
                json!({
                    "kind": "legacy_entry",
                    "entry_index": entry_index,
                    "message_index": message_index,
                    "record_fingerprint": json_fingerprint(record),
                }),
            );
            messages.push(message);
        }
    }
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
            if let Some(mut message) = state.accept_message(message_value(
                "user", &text, &timestamp, "legacy", "prompt", false,
            )) {
                attach_message_delete_ref(
                    &mut message,
                    json!({
                        "kind": "legacy_prompt",
                        "record_fingerprint": json_fingerprint(&Value::String(text.clone())),
                    }),
                );
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
                        if let Some(mut message) = state.accept_message(message_value(
                            "user",
                            display,
                            &record_timestamp,
                            "user_input",
                            "display",
                            false,
                        )) {
                            attach_message_delete_ref(
                                &mut message,
                                json!({
                                    "kind": "legacy_history",
                                    "line_number": index + 1,
                                    "record_fingerprint": json_fingerprint(&record),
                                }),
                            );
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

pub(super) fn attach_message_delete_ref(message: &mut Value, mut delete_ref: Value) {
    if let Some(tool_call_id) = message["tool_call_id"].as_str() {
        delete_ref["tool_call_id"] = Value::String(tool_call_id.to_string());
    }
    let mut identity_ref = delete_ref.clone();
    if let Some(object) = identity_ref.as_object_mut() {
        for field in ["line_number", "record_index", "entry_index"] {
            object.remove(field);
        }
    }
    let mut hasher = Sha256::new();
    hasher.update(serde_json::to_vec(&identity_ref).unwrap_or_default());
    for field in ["role", "text", "timestamp", "source_type", "source_subtype"] {
        hasher.update([0]);
        hasher.update(message[field].to_string().as_bytes());
    }
    let key = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    message["_message_key"] = Value::String(key);
    message["_delete_ref"] = delete_ref;
}

pub(super) fn json_fingerprint(value: &Value) -> String {
    let mut hasher = Sha256::new();
    hasher.update(serde_json::to_vec(value).unwrap_or_default());
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn replacement_path(path: &Path, suffix: &str) -> Result<PathBuf, String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("文件缺少父目录：{}", path.display()))?;
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| format!("文件名无效：{}", path.display()))?;
    Ok(parent.join(format!(".{name}.allsessions-{}.{suffix}", Uuid::new_v4())))
}

pub(super) fn replace_file_contents(
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

fn rewrite_jsonl_without_lines(path: &Path, removed_lines: &BTreeSet<usize>) -> Result<(), String> {
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

fn delete_jsonl_message(path: &Path, delete_ref: &Value) -> Result<(), String> {
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

fn delete_legacy_message(path: &Path, delete_ref: &Value) -> Result<(), String> {
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

fn legacy_history_path(path: &Path) -> Option<PathBuf> {
    path.parent()
        .and_then(Path::parent)
        .map(|root| root.join("history.jsonl"))
}

fn session_backup_paths(path: &Path) -> Vec<PathBuf> {
    let mut paths = vec![path.to_path_buf()];
    if path.extension().and_then(|value| value.to_str()) == Some("json") {
        if let Some(history) = legacy_history_path(path).filter(|value| value.is_file()) {
            paths.push(history);
        }
    }
    paths
}

fn message_backup_paths(path: &Path, delete_ref: &Value) -> Result<Vec<PathBuf>, String> {
    if delete_ref["kind"].as_str() == Some("legacy_history") {
        return legacy_history_path(path)
            .filter(|value| value.is_file())
            .map(|value| vec![value])
            .ok_or_else(|| "无法确定旧版 Claude history 路径".to_string());
    }
    Ok(vec![path.to_path_buf()])
}

fn delete_legacy_session(path: &Path, session_id: &str) -> Result<usize, String> {
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
/// 时间戳的本地日期键（YYYY-MM-DD），与前端 localDateKey 使用同一规则，
/// 避免带 Z/偏移的 UTC 时间戳在非 UTC 时区被拆到错误的日期。
/// 无法按 RFC3339 解析时回退到字符串前 10 位。
fn local_date_key(timestamp: &str) -> Option<String> {
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
fn diagnostic_source_kind(kind: &str) -> &str {
    match kind {
        "claude_code" => "claude",
        value => value,
    }
}
fn scan_timestamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn error_text(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use serde_json::{json, Value};
    use tempfile::tempdir;

    #[cfg(windows)]
    use crate::cache::IndexCache;

    use super::{
        compact, delete_jsonl_message, delete_legacy_session, describe_inherited_sources,
        describe_protected_source_roots, describe_sources, existing_watch_root,
        generic_conversation_message, is_synthetic_context, local_date_key, parse_detail,
        parse_summary, resolve_kind, search_query_matches, sources_from_paths, split_path_list,
        watch_roots_for, DetailCache, HeadTail, ScanDiagnostics, SessionStore, Source,
        SourceFormat, DETAIL_CACHE_BYTES, DETAIL_EVENT_LIMIT, DETAIL_MESSAGE_LIMIT,
    };
    use std::collections::{BTreeSet, HashMap};
    use std::path::PathBuf;

    fn codex_roots_config(roots: &[PathBuf]) -> crate::config::SourceRoots {
        crate::config::SourceRoots {
            codex: Some(
                roots
                    .iter()
                    .map(|root| root.to_string_lossy().into_owned())
                    .collect(),
            ),
            // 显式停用其余来源：否则会回退到默认目录，把测试机上真实存在的
            // ~/.claude、~/.gemini 会话扫进测试。
            codex_archived: Some(Vec::new()),
            claude: Some(Vec::new()),
            gemini: Some(Vec::new()),
        }
    }

    #[test]
    fn summary_text_has_limit() {
        assert_eq!(compact("abcdefgh", 6), "abc...");
    }

    #[test]
    fn refresh_discovers_source_directory_created_after_startup() {
        let base = tempdir().unwrap();
        let root = base.path().join("sessions");
        let session = format!(
            "{}\n{}\n",
            json!({ "type": "session_meta", "payload": { "id": "late", "model_provider": "custom" } }),
            json!({ "type": "event_msg", "payload": { "type": "user_message", "message": "created later" } })
        );
        let mut store = SessionStore {
            summaries: Vec::new(),
            records: HashMap::new(),
            sources: Vec::new(),
            sources_config: codex_roots_config(std::slice::from_ref(&root)),
            index_cache: crate::cache::IndexCache::disabled(),
            detail_cache: DetailCache::new(DETAIL_CACHE_BYTES),
            scan_diagnostics: ScanDiagnostics::default(),
        };
        store.refresh().unwrap();
        assert!(store.summaries.is_empty());

        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("a.jsonl"), session).unwrap();
        store.refresh().unwrap();
        assert!(store.records.contains_key("codex:late"));
    }

    #[test]
    fn refresh_records_source_errors_without_blocking_valid_sessions() {
        let base = tempdir().unwrap();
        let codex_root = base.path().join("codex");
        let claude_root = base.path().join("claude");
        std::fs::create_dir_all(&codex_root).unwrap();
        std::fs::create_dir_all(claude_root.join("sessions")).unwrap();
        std::fs::write(
            codex_root.join("valid.jsonl"),
            format!(
                "{}\n",
                json!({ "type": "session_meta", "payload": { "id": "valid" } })
            ),
        )
        .unwrap();
        std::fs::write(claude_root.join("sessions/broken.json"), "{broken").unwrap();

        let mut store = SessionStore {
            summaries: Vec::new(),
            records: HashMap::new(),
            sources: Vec::new(),
            sources_config: crate::config::SourceRoots {
                codex: Some(vec![codex_root.to_string_lossy().into_owned()]),
                codex_archived: Some(Vec::new()),
                claude: Some(vec![claude_root.to_string_lossy().into_owned()]),
                gemini: Some(Vec::new()),
            },
            index_cache: crate::cache::IndexCache::disabled(),
            detail_cache: DetailCache::new(DETAIL_CACHE_BYTES),
            scan_diagnostics: ScanDiagnostics::default(),
        };

        store.refresh().unwrap();

        assert!(store.records.contains_key("codex:valid"));
        let diagnostics = store.diagnostics();
        assert_eq!(diagnostics["sources"]["codex"]["indexed_sessions"], 1);
        assert_eq!(diagnostics["sources"]["claude"]["error_count"], 1);
        assert!(diagnostics["sources"]["claude"]["last_error"].is_string());
    }

    #[test]
    fn refresh_paths_rebuilds_claude_priority_after_layout_change() {
        let base = tempdir().unwrap();
        let claude_root = base.path().join("claude-home");
        let projects = claude_root.join("projects");
        let sessions = claude_root.join("sessions");
        std::fs::create_dir_all(&projects).unwrap();
        std::fs::create_dir_all(&sessions).unwrap();
        let session_file = projects.join("s1.jsonl");
        std::fs::write(
            &session_file,
            concat!(
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"hello\"},",
                "\"timestamp\":\"2026-08-20T01:00:00.000Z\",\"cwd\":\"/proj\",\"sessionId\":\"s1\"}\n"
            ),
        )
        .unwrap();
        let legacy_file = sessions.join("s1.json");
        std::fs::write(
            &legacy_file,
            json!({
                "sessionId": "s1",
                "prompt": "legacy fallback",
                "cwd": "/legacy",
                "startedAt": 1_766_016_000_000_i64
            })
            .to_string(),
        )
        .unwrap();
        let mut store = SessionStore {
            summaries: Vec::new(),
            records: HashMap::new(),
            sources: Vec::new(),
            sources_config: crate::config::SourceRoots {
                claude: Some(vec![claude_root.to_string_lossy().into_owned()]),
                codex: Some(Vec::new()),
                codex_archived: Some(Vec::new()),
                gemini: Some(Vec::new()),
            },
            index_cache: crate::cache::IndexCache::disabled(),
            detail_cache: DetailCache::new(DETAIL_CACHE_BYTES),
            scan_diagnostics: ScanDiagnostics::default(),
        };
        store.refresh().unwrap();
        assert!(store.records.contains_key("claude_code:s1"));
        assert_eq!(store.records["claude_code:s1"].path, session_file);

        // projects 目录被删除后，应重新选择旧版记录，而不是残留幽灵会话或丢失回退记录。
        std::fs::remove_dir_all(&projects).unwrap();
        let changed = store
            .refresh_paths(&BTreeSet::from([session_file.clone()]))
            .unwrap();
        assert!(changed);
        assert_eq!(store.records["claude_code:s1"].path, legacy_file);
    }

    #[test]
    fn watch_roots_fall_back_to_parent_but_never_home() {
        let base = tempdir().unwrap();
        let child = base.path().join("sessions");
        // 目录不存在时回溯到最近的现有父目录
        assert_eq!(existing_watch_root(&child), Some(base.path().into()));
        // 爬到用户主目录或文件系统根仍找不到时就放弃，避免递归监听整个主目录
        let home = dirs::home_dir().unwrap();
        assert_eq!(
            existing_watch_root(&home.join(".never-exists-all-sessions")),
            None
        );

        assert_eq!(
            watch_roots_for(&codex_roots_config(std::slice::from_ref(&child))),
            vec![base.path()]
        );
    }

    #[test]
    fn local_date_key_converts_to_local_timezone() {
        // 本地日期键必须来自本地时区换算，而不是直接取 UTC 字符串前缀
        for timestamp in [
            "2026-08-20T00:30:00.000Z",
            "2026-08-20T23:30:00+08:00",
            "2026-08-19T18:00:00Z",
        ] {
            let expected = chrono::DateTime::parse_from_rfc3339(timestamp)
                .unwrap()
                .with_timezone(&chrono::Local)
                .format("%Y-%m-%d")
                .to_string();
            assert_eq!(
                local_date_key(timestamp).as_deref(),
                Some(expected.as_str())
            );
        }
        // 无法解析时回退到字符串前 10 位
        assert_eq!(
            local_date_key("2026-08-19 自定义"),
            Some("2026-08-19".into())
        );
        assert_eq!(local_date_key(""), None);
    }

    #[test]
    fn 配置根目录优先于环境变量并展开波浪线() {
        let configured = vec!["~/custom-codex".to_string()];
        let (roots, origin) = resolve_kind(
            Some(&configured),
            "CODEX_SESSIONS_DIR",
            PathBuf::from("/fallback"),
        );
        assert_eq!(origin, "config");
        assert_eq!(roots, vec![dirs::home_dir().unwrap().join("custom-codex")]);
    }

    #[test]
    fn 继承来源描述不会采用用户配置() {
        let config = crate::config::SourceRoots {
            codex: Some(vec!["/custom-codex".to_string()]),
            ..Default::default()
        };

        assert_eq!(describe_sources(&config)["codex"]["origin"], "config");
        assert_ne!(describe_inherited_sources()["codex"]["origin"], "config");
    }

    #[test]
    fn 受保护来源使用规范化后的路径身份匹配() {
        let home = dirs::home_dir().unwrap();
        let inherited = home.join(".codex").join("sessions");
        let configured = vec!["~/.codex/sessions".to_string(), "/custom-codex".to_string()];

        assert_eq!(
            describe_protected_source_roots(&configured, &[inherited]),
            vec!["~/.codex/sessions".to_string()]
        );

        let relative_name = "allsessions-protected-root-that-does-not-exist";
        let relative = vec![format!("./{relative_name}")];
        let absolute = std::env::current_dir().unwrap().join(relative_name);
        assert_eq!(
            describe_protected_source_roots(&relative, &[absolute]),
            relative
        );
    }

    #[test]
    fn 配置空数组会停用对应来源() {
        let (roots, origin) = resolve_kind(
            Some(&Vec::new()),
            "CODEX_SESSIONS_DIR",
            PathBuf::from("/fallback"),
        );
        assert_eq!(origin, "config");
        assert!(roots.is_empty());
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
    fn 永久删除单条消息只移除对应原始记录() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("session.jsonl");
        let records = [
            json!({ "timestamp": "2026-01-01T00:00:00Z", "type": "session_meta", "payload": { "id": "codex-1", "cwd": "/tmp/project" } }),
            json!({ "timestamp": "2026-01-01T00:00:01Z", "type": "event_msg", "payload": { "type": "user_message", "message": "删除我" } }),
            json!({ "timestamp": "2026-01-01T00:00:02Z", "type": "event_msg", "payload": { "type": "agent_message", "message": "保留我" } }),
        ];
        std::fs::write(
            &path,
            records
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n")
                + "\n",
        )
        .unwrap();
        let source = Source {
            kind: "codex",
            display_name: "Codex",
            root: directory.path().into(),
            format: SourceFormat::Codex,
            archived: false,
        };
        let detail = parse_detail(&path, &source).unwrap();
        let delete_ref = detail["conversation_messages"][0]["_delete_ref"].clone();
        let retained_message_key = detail["conversation_messages"][1]["_message_key"].clone();

        delete_jsonl_message(&path, &delete_ref).unwrap();

        let updated = std::fs::read_to_string(&path).unwrap();
        assert!(!updated.contains("删除我"));
        assert!(updated.contains("保留我"));
        assert!(updated.contains("session_meta"));
        let reparsed = parse_detail(&path, &source).unwrap();
        assert_eq!(
            reparsed["conversation_messages"][0]["_message_key"],
            retained_message_key
        );
    }

    #[test]
    fn 原始记录变化后拒绝使用旧消息标识删除() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("session.jsonl");
        let source = Source {
            kind: "codex",
            display_name: "Codex",
            root: directory.path().into(),
            format: SourceFormat::Codex,
            archived: false,
        };
        std::fs::write(
            &path,
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"codex-1\"}}\n",
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"旧内容\"}}\n"
            ),
        )
        .unwrap();
        let detail = parse_detail(&path, &source).unwrap();
        let delete_ref = detail["conversation_messages"][0]["_delete_ref"].clone();
        std::fs::write(
            &path,
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"codex-1\"}}\n",
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"新内容\"}}\n"
            ),
        )
        .unwrap();

        assert!(delete_jsonl_message(&path, &delete_ref).is_err());
        assert!(std::fs::read_to_string(&path).unwrap().contains("新内容"));
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
    fn 删除混合记录中的文本时同步移除关联工具结果() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("claude.jsonl");
        let records = [
            json!({
                "timestamp": "2026-01-01T00:00:00Z", "type": "assistant", "sessionId": "claude-1",
                "message": { "role": "assistant", "content": [
                    { "type": "text", "text": "删除这段说明" },
                    { "type": "tool_use", "id": "tool-1", "name": "Read", "input": { "path": "a.rs" } }
                ] }
            }),
            json!({
                "timestamp": "2026-01-01T00:00:01Z", "type": "user", "sessionId": "claude-1",
                "message": { "role": "user", "content": [
                    { "type": "tool_result", "tool_use_id": "tool-1", "content": "文件内容" }
                ] }
            }),
        ];
        std::fs::write(
            &path,
            records
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n")
                + "\n",
        )
        .unwrap();
        let source = Source {
            kind: "claude_code",
            display_name: "Claude Code",
            root: directory.path().into(),
            format: SourceFormat::Claude,
            archived: false,
        };
        let detail = parse_detail(&path, &source).unwrap();
        let delete_ref = detail["conversation_messages"][0]["_delete_ref"].clone();

        delete_jsonl_message(&path, &delete_ref).unwrap();

        let updated = std::fs::read_to_string(&path).unwrap();
        assert!(!updated.contains("删除这段说明"));
        assert!(!updated.contains("tool-1"));
        assert!(!updated.contains("文件内容"));
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

        assert_eq!(delete_legacy_session(&path, "s1").unwrap(), 2);
        assert!(!path.exists());
        let history = std::fs::read_to_string(claude_root.join("history.jsonl")).unwrap();
        assert!(history.contains("other"));
        assert!(!history.contains("legacy prompt"));
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
        let mut store = SessionStore {
            summaries: Vec::new(),
            records: HashMap::new(),
            sources: Vec::new(),
            sources_config: codex_roots_config(&[directory.path().into()]),
            index_cache: crate::cache::IndexCache::disabled(),
            detail_cache: DetailCache::new(DETAIL_CACHE_BYTES),
            scan_diagnostics: ScanDiagnostics::default(),
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

    #[test]
    fn incremental_refresh_keeps_source_diagnostics_current() {
        let directory = tempdir().unwrap();
        let first = directory.path().join("first.jsonl");
        let second = directory.path().join("second.jsonl");
        let session = |id: &str| {
            format!(
                "{}\n",
                json!({ "type": "session_meta", "payload": { "id": id } })
            )
        };
        std::fs::write(&first, session("first")).unwrap();
        let mut store = SessionStore {
            summaries: Vec::new(),
            records: HashMap::new(),
            sources: Vec::new(),
            sources_config: codex_roots_config(&[directory.path().into()]),
            index_cache: crate::cache::IndexCache::disabled(),
            detail_cache: DetailCache::new(DETAIL_CACHE_BYTES),
            scan_diagnostics: ScanDiagnostics::default(),
        };
        store.refresh().unwrap();
        assert_eq!(
            store.diagnostics()["sources"]["codex"]["discovered_files"],
            1
        );

        std::fs::write(&second, session("second")).unwrap();
        store
            .refresh_paths(&BTreeSet::from([second.clone()]))
            .unwrap();
        assert_eq!(
            store.diagnostics()["sources"]["codex"]["discovered_files"],
            2
        );

        std::fs::remove_file(&first).unwrap();
        store
            .refresh_paths(&BTreeSet::from([first.clone()]))
            .unwrap();
        let diagnostics = store.diagnostics();
        assert_eq!(diagnostics["sources"]["codex"]["discovered_files"], 1);
        assert_eq!(diagnostics["sources"]["codex"]["error_count"], 0);

        store
            .refresh_paths(&BTreeSet::from([directory.path().to_path_buf()]))
            .unwrap();
        assert_eq!(
            store.diagnostics()["sources"]["codex"]["discovered_files"],
            1
        );
    }

    #[test]
    fn split_path_list_drops_empty_segments() {
        let joined = std::env::join_paths(["/a/b", "", "/c/d"]).unwrap();
        let paths = split_path_list(joined.as_os_str());
        let expected = vec![PathBuf::from("/a/b"), PathBuf::from("/c/d")];
        assert_eq!(paths, expected);

        let single = std::env::join_paths(["/only/one"]).unwrap();
        assert_eq!(split_path_list(single.as_os_str()).len(), 1);
    }

    #[test]
    fn tilde_segments_expand_to_home() {
        let joined = std::env::join_paths(["~/codex/sessions"]).unwrap();
        let paths = split_path_list(joined.as_os_str());
        let home = dirs::home_dir().unwrap();
        assert_eq!(paths, vec![home.join("codex/sessions")]);
    }

    #[cfg(windows)]
    #[test]
    fn windows_backslash_tilde_expands_to_home() {
        let joined = std::env::join_paths(["~\\.codex"]).unwrap();
        let paths = split_path_list(joined.as_os_str());
        let home = dirs::home_dir().unwrap();
        assert_eq!(paths, vec![home.join(".codex")]);
    }

    #[cfg(windows)]
    #[test]
    fn same_file_with_different_path_case_is_indexed_once() {
        let first = tempdir().unwrap();
        std::fs::write(first.path().join("session.jsonl"), "{}\n").unwrap();
        let alternate = PathBuf::from(first.path().to_string_lossy().to_uppercase());
        let mut store = SessionStore {
            summaries: Vec::new(),
            records: HashMap::new(),
            sources: Vec::new(),
            sources_config: codex_roots_config(&[first.path().into(), alternate]),
            index_cache: IndexCache::disabled(),
            detail_cache: DetailCache::new(DETAIL_CACHE_BYTES),
            scan_diagnostics: ScanDiagnostics::default(),
        };

        store.refresh().unwrap();

        assert_eq!(store.summaries.len(), 1);
    }

    #[test]
    fn sources_from_paths_builds_one_source_per_root_in_order() {
        let first = tempdir().unwrap();
        let second = tempdir().unwrap();
        let missing = first.path().join("missing");
        let sources = sources_from_paths(
            &[first.path().into(), second.path().into(), missing.clone()],
            &[],
            &[],
            &[],
        );
        // 尚未创建的目录也要保留，等它出现后 refresh 才能重新发现
        assert_eq!(sources.len(), 3);
        assert_eq!(sources[0].root, first.path());
        assert_eq!(sources[1].root, second.path());
        assert_eq!(sources[2].root, missing);
        assert!(sources.iter().all(|source| source.kind == "codex"));
        assert!(sources.iter().all(|source| !source.archived));

        let archived_sources = sources_from_paths(&[], &[second.path().into()], &[], &[]);
        assert_eq!(archived_sources.len(), 1);
        assert_eq!(archived_sources[0].kind, "codex_archived");
        assert!(archived_sources[0].archived);
    }

    #[test]
    fn sources_from_paths_registers_both_claude_layouts_per_root() {
        let with_projects = tempdir().unwrap();
        let projects = with_projects.path().join("projects");
        std::fs::create_dir_all(&projects).unwrap();
        let legacy = tempdir().unwrap();
        let legacy_sessions = legacy.path().join("sessions");
        std::fs::create_dir_all(&legacy_sessions).unwrap();

        let sources = sources_from_paths(
            &[],
            &[],
            &[with_projects.path().into(), legacy.path().into()],
            &[],
        );
        assert_eq!(sources.len(), 4);
        assert_eq!(sources[0].root, projects);
        assert_eq!(sources[1].root, with_projects.path().join("sessions"));
        assert_eq!(sources[2].root, legacy.path().join("projects"));
        assert_eq!(sources[3].root, legacy_sessions);
        assert!(sources.iter().all(|source| {
            source.kind == "claude_code" && matches!(source.format, SourceFormat::Claude)
        }));
    }

    #[test]
    fn claude_modern_and_legacy_sessions_are_scanned_together() {
        let directory = tempdir().unwrap();
        let claude_root = directory.path().join(".claude");
        let projects_root = claude_root.join("projects");
        let sessions_root = claude_root.join("sessions");
        std::fs::create_dir_all(&projects_root).unwrap();
        std::fs::create_dir_all(&sessions_root).unwrap();
        std::fs::write(
            projects_root.join("modern.jsonl"),
            concat!(
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"modern\"},",
                "\"timestamp\":\"2026-08-20T01:00:00.000Z\",\"cwd\":\"/modern\",\"sessionId\":\"modern\"}\n"
            ),
        )
        .unwrap();
        std::fs::write(
            sessions_root.join("legacy.json"),
            json!({
                "sessionId": "legacy",
                "prompt": "legacy",
                "cwd": "/legacy",
                "startedAt": 1_766_016_000_000_i64
            })
            .to_string(),
        )
        .unwrap();
        std::fs::write(
            sessions_root.join("modern.json"),
            json!({
                "sessionId": "modern",
                "prompt": "legacy duplicate",
                "cwd": "/legacy",
                "startedAt": 1_766_016_000_000_i64
            })
            .to_string(),
        )
        .unwrap();
        let mut store = SessionStore {
            summaries: Vec::new(),
            records: HashMap::new(),
            sources: Vec::new(),
            sources_config: crate::config::SourceRoots {
                claude: Some(vec![claude_root.to_string_lossy().into_owned()]),
                codex: Some(Vec::new()),
                codex_archived: Some(Vec::new()),
                gemini: Some(Vec::new()),
            },
            index_cache: crate::cache::IndexCache::disabled(),
            detail_cache: DetailCache::new(DETAIL_CACHE_BYTES),
            scan_diagnostics: ScanDiagnostics::default(),
        };

        store.refresh().unwrap();

        assert!(store.records.contains_key("claude_code:modern"));
        assert!(store.records.contains_key("claude_code:legacy"));
        assert_eq!(store.records.len(), 2);
        assert_eq!(
            store.records["claude_code:modern"].path,
            projects_root.join("modern.jsonl")
        );
    }

    #[test]
    fn duplicate_session_id_across_roots_keeps_first_root() {
        let first = tempdir().unwrap();
        let second = tempdir().unwrap();
        let session = |message: &str| {
            format!(
                "{}\n{}\n",
                json!({ "type": "session_meta", "payload": { "id": "dup", "model_provider": "custom" } }),
                json!({ "type": "event_msg", "payload": { "type": "user_message", "message": message } })
            )
        };
        std::fs::write(first.path().join("a.jsonl"), session("first root only")).unwrap();
        std::fs::write(second.path().join("b.jsonl"), session("second root copy")).unwrap();
        let mut store = SessionStore {
            summaries: Vec::new(),
            records: HashMap::new(),
            sources: Vec::new(),
            sources_config: codex_roots_config(&[first.path().into(), second.path().into()]),
            index_cache: crate::cache::IndexCache::disabled(),
            detail_cache: DetailCache::new(DETAIL_CACHE_BYTES),
            scan_diagnostics: ScanDiagnostics::default(),
        };
        store.refresh().unwrap();
        assert_eq!(store.records.len(), 1);
        let record = &store.records["codex:dup"];
        assert_eq!(record.source.root, first.path());
        assert!(record.search_text.contains("first root only"));
        assert!(!record.search_text.contains("second root copy"));
    }

    #[test]
    fn nested_roots_index_shared_file_once() {
        let outer = tempdir().unwrap();
        let nested = outer.path().join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        let shared = nested.join("shared.jsonl");
        std::fs::write(
            &shared,
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"shared\",\"model_provider\":\"custom\"}}\n",
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"hello\"}}\n"
            ),
        )
        .unwrap();
        let mut store = SessionStore {
            summaries: Vec::new(),
            records: HashMap::new(),
            sources: Vec::new(),
            sources_config: codex_roots_config(&[outer.path().into(), nested]),
            index_cache: crate::cache::IndexCache::disabled(),
            detail_cache: DetailCache::new(DETAIL_CACHE_BYTES),
            scan_diagnostics: ScanDiagnostics::default(),
        };
        store.refresh().unwrap();
        assert_eq!(store.records.len(), 1);
        assert_eq!(store.records["codex:shared"].source.root, outer.path());
    }

    #[test]
    fn facets_sources_dedupe_kinds_but_keep_all_roots() {
        let first = tempdir().unwrap();
        let second = tempdir().unwrap();
        let session = |id: &str| {
            format!(
                "{}\n",
                json!({ "type": "session_meta", "payload": { "id": id, "model_provider": "custom" } })
            )
        };
        std::fs::write(first.path().join("a.jsonl"), session("a")).unwrap();
        std::fs::write(second.path().join("b.jsonl"), session("b")).unwrap();
        let mut store = SessionStore {
            summaries: Vec::new(),
            records: HashMap::new(),
            sources: Vec::new(),
            sources_config: codex_roots_config(&[first.path().into(), second.path().into()]),
            index_cache: crate::cache::IndexCache::disabled(),
            detail_cache: DetailCache::new(DETAIL_CACHE_BYTES),
            scan_diagnostics: ScanDiagnostics::default(),
        };
        store.refresh().unwrap();
        let facets = store.facets();
        let sources = facets["sources"].as_array().unwrap();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0]["kind"], "codex");
        assert_eq!(facets["session_roots"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn refresh_paths_attributes_shared_file_to_first_declared_root() {
        let outer = tempdir().unwrap();
        let nested = outer.path().join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        let shared = nested.join("shared.jsonl");
        let session = |message: &str| {
            format!(
                "{}\n{}\n",
                json!({ "type": "session_meta", "payload": { "id": "shared", "model_provider": "custom" } }),
                json!({ "type": "event_msg", "payload": { "type": "user_message", "message": message } })
            )
        };
        std::fs::write(&shared, session("before")).unwrap();
        let mut store = SessionStore {
            summaries: Vec::new(),
            records: HashMap::new(),
            sources: Vec::new(),
            sources_config: codex_roots_config(&[outer.path().into(), nested.clone()]),
            index_cache: crate::cache::IndexCache::disabled(),
            detail_cache: DetailCache::new(DETAIL_CACHE_BYTES),
            scan_diagnostics: ScanDiagnostics::default(),
        };
        store.refresh().unwrap();
        std::fs::write(&shared, session("after")).unwrap();
        store
            .refresh_paths(&BTreeSet::from([shared.clone()]))
            .unwrap();
        assert_eq!(store.records.len(), 1);
        let record = &store.records["codex:shared"];
        assert_eq!(record.source.root, outer.path());
        assert!(record.search_text.contains("after"));
    }
}
