//! 会话存储契约与核心类型:来源(Source)、统一摘要/记录结构与 Store 生命周期。
//! 各来源格式适配器与解析、扫描、查询、删除等实现按子模块组织。
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::cache::IndexCache;

mod claude_legacy;
mod copilot;
mod cursor;
mod devin;
mod gemini;
mod helpers;
mod hermes;
mod kimi;
mod mutation;
mod opencode;
mod parse;
mod pi;
mod query;
mod roots;
mod scan;
mod stats;
mod vscode_copilot;
mod zcode;

#[cfg(test)]
mod tests;

// 子模块条目经此再导出,保持适配器、后端与测试中 `super::条目` / `crate::sessions::条目`
// 的既有引用路径不变;兄弟子模块之间直接从定义模块导入,不经此枢纽。
pub(crate) use claude_legacy::{legacy_timestamp, timestamp_from_millis};
pub(crate) use helpers::{
    compact, compact_title, diagnostic_entries, diagnostic_source_kind, error_text,
    nullable_string, scan_timestamp,
};
#[cfg(test)]
pub(crate) use helpers::{
    is_synthetic_context, local_date_key, matches_filters, search_fingerprint,
    search_query_matches, timestamp_of,
};
pub(crate) use mutation::replace_file_contents;
#[cfg(test)]
pub(crate) use mutation::{delete_jsonl_message, delete_legacy_session};
pub(crate) use parse::{
    append_limited, attach_message_delete_ref, attach_message_key, extract_text, json_fingerprint,
    message_value, search_text_from_detail, summary_search_text, truncate_message, DetailCache,
    HeadTail, ParseState,
};
#[cfg(test)]
pub(crate) use parse::{generic_conversation_message, parse_detail, parse_summary};
pub(crate) use roots::{
    describe_inherited_sources, describe_protected_sources, describe_sources, expand_tilde,
    opencode_event_matches, path_identity, root_lists, watch_roots_for,
};
#[cfg(test)]
pub(crate) use roots::{
    describe_protected_source_roots, existing_watch_root, existing_watch_root_within, resolve_kind,
    sources_from_paths, split_path_list,
};

const PAGE_LIMIT: usize = 50;
const SEARCH_TEXT_LIMIT: usize = 64_000;
const DETAIL_MESSAGE_LIMIT: usize = 800;
const DETAIL_EVENT_LIMIT: usize = 1_200;
const DETAIL_TEXT_LIMIT: usize = 20_000;
const DETAIL_CACHE_BYTES: usize = 64 * 1024 * 1024;

#[derive(Clone, PartialEq)]
pub(crate) struct Source {
    kind: &'static str,
    display_name: &'static str,
    root: PathBuf,
    format: SourceFormat,
    archived: bool,
}

#[derive(Clone, Copy, PartialEq)]
pub(crate) enum SourceFormat {
    Codex,
    Claude,
    Gemini,
    Pi,
    Kimi,
    OpenCode,
    Kilo,
    ZCode,
    Cursor,
    Devin,
    Copilot,
    Hermes,
    VsCodeCopilot,
}

#[derive(Clone)]
pub(crate) enum DetailLocator {
    Gemini(gemini::DetailLocator),
    OpenCode(opencode::DetailLocator),
    ZCode(zcode::DetailLocator),
    Cursor(cursor::DetailLocator),
    Devin(devin::DetailLocator),
    Hermes(hermes::DetailLocator),
}

#[derive(Clone)]
pub(crate) struct StoredSession {
    summary: Value,
    search_text: String,
    source: Source,
    path: PathBuf,
    detail_locator: Option<DetailLocator>,
}

#[derive(Clone, Default)]
pub(crate) struct SourceScanDiagnostic {
    discovered_paths: BTreeSet<PathBuf>,
    errors: BTreeMap<(PathBuf, String), String>,
    /// 格式暂不支持等预期内的良性情况（如 Cursor 新版正文格式），
    /// 与真实读取异常分开展示，不计入「扫描错误」。
    unsupported: BTreeMap<(PathBuf, String), String>,
    last_error: Option<String>,
}

#[derive(Clone, Default)]
pub(crate) struct ScanDiagnostics {
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
        self.record_session_error(kind, path, "", error);
    }

    fn record_session_error(&mut self, kind: &str, path: &Path, id: &str, error: &str) {
        let diagnostic = self.sources.entry(kind.to_string()).or_default();
        diagnostic
            .errors
            .insert((path.to_path_buf(), id.to_string()), error.to_string());
        diagnostic.last_error = Some(error.to_string());
    }

    fn record_unsupported(&mut self, kind: &str, path: &Path, id: &str, reason: &str) {
        self.sources
            .entry(kind.to_string())
            .or_default()
            .unsupported
            .insert((path.to_path_buf(), id.to_string()), reason.to_string());
    }

    fn clear_error(&mut self, kind: &str, path: &Path) {
        let Some(diagnostic) = self.sources.get_mut(kind) else {
            return;
        };
        diagnostic
            .unsupported
            .retain(|(candidate, _), _| candidate != path);
        diagnostic
            .errors
            .retain(|(candidate, _), _| candidate != path);
        diagnostic.last_error = diagnostic.errors.values().next_back().cloned();
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
        diagnostic
            .unsupported
            .retain(|(candidate, _), _| !matches(candidate));
        let removed_error = diagnostic
            .errors
            .keys()
            .any(|(candidate, _)| matches(candidate));
        diagnostic
            .errors
            .retain(|(candidate, _), _| !matches(candidate));
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
    /// 打开索引缓存但不扫描会话；首次扫描由调用方在后台线程执行，
    /// 避免阻塞窗口创建。
    pub fn open(config: &crate::config::AppConfig) -> Result<Self, String> {
        Ok(Self {
            summaries: Vec::new(),
            records: HashMap::new(),
            sources: Vec::new(),
            sources_config: config.sources.clone(),
            index_cache: IndexCache::open()?,
            detail_cache: DetailCache::new(DETAIL_CACHE_BYTES),
            scan_diagnostics: ScanDiagnostics::default(),
        })
    }
    pub fn clear_index_cache(&mut self) {
        self.index_cache.clear();
    }
    pub fn cache_storage(&self) -> Value {
        self.index_cache.storage_info()
    }
    pub fn diagnostics(&self) -> Value {
        let mut sources = BTreeMap::<String, Value>::new();
        for kind in [
            "codex",
            "codex_archived",
            "claude",
            "gemini",
            "pi",
            "kimi",
            "opencode",
            "kilo",
            "zcode",
            "cursor",
            "devin",
            "copilot",
            "hermes",
            "vscode_copilot",
        ] {
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
                    "unsupported_count": 0,
                    "error_entries": [],
                    "unsupported_entries": [],
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
            ("pi", lists.pi.as_slice()),
            ("kimi", lists.kimi.as_slice()),
            ("opencode", lists.opencode.as_slice()),
            ("kilo", lists.kilo.as_slice()),
            ("zcode", lists.zcode.as_slice()),
            ("cursor", lists.cursor.as_slice()),
            ("devin", lists.devin.as_slice()),
            ("copilot", lists.copilot.as_slice()),
            ("hermes", lists.hermes.as_slice()),
            ("vscode_copilot", lists.vscode_copilot.as_slice()),
        ] {
            let entry = sources.entry(kind.to_string()).or_insert_with(|| json!({}));
            entry["declared_roots"] = json!(roots.len());
            entry["available_roots"] = json!(roots
                .iter()
                .filter(|root| match kind {
                    "opencode" | "kilo" | "zcode" => root.is_file(),
                    "cursor" => root.is_file() || root.is_dir(),
                    _ => root.is_dir(),
                })
                .count());
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
                entry["unsupported_count"] = json!(diagnostic.unsupported.len());
                // 逐条原因只用于设置页展示，数量封顶避免诊断体积失控。
                entry["error_entries"] = diagnostic_entries(&diagnostic.errors);
                entry["unsupported_entries"] = diagnostic_entries(&diagnostic.unsupported);
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

    /// 首次全量扫描尚未完成时为 true，前端据此区分“扫描中”和“确无会话”。
    pub fn scanning(&self) -> bool {
        self.scan_diagnostics.last_scan_at.is_empty()
    }

    pub fn capabilities(&self, maintenance_enabled: bool) -> Value {
        json!({ "service": { "name": "AllSessions", "protocol_version": 2 }, "codex_maintenance": { "enabled": maintenance_enabled } })
    }
}
