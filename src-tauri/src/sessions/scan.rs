//! 扫描与刷新:全量/增量元数据刷新、来源解析与搜索索引重建。
use std::collections::{hash_map::Entry, BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

use super::helpers::{
    diagnostic_source_kind, error_text, is_placeholder_session, search_fingerprint, timestamp_of,
};
use super::mutation::session_backup_paths;
use super::parse::{parse_summary, visit_detail};
use super::roots::{
    configured_sources, discover_files, opencode_event_matches, path_identity, source_matches_path,
};
use super::{
    cursor, devin, gemini, hermes, opencode, vscode_copilot, zcode, DetailLocator, ScanDiagnostics,
    SessionStore, SourceFormat, StoredSession,
};

impl SessionStore {
    /// 仅测试使用：同步完成摘要刷新和索引重建。后端运行时走
    /// scan_locked 的两阶段路径，不在会话锁内做全量重建。
    #[cfg(test)]
    pub fn refresh(&mut self) -> Result<(), String> {
        self.refresh_metadata()?;
        self.rebuild_search_index()
    }

    pub fn refresh_metadata(&mut self) -> Result<(), String> {
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
                        detail_locator: Some(DetailLocator::Gemini(session.detail_locator)),
                    });
                }
                continue;
            }
            if matches!(source.format, SourceFormat::Cursor) {
                if !source.root.exists() {
                    continue;
                }
                match cursor::parse_source(source) {
                    Ok(parsed) => {
                        for (path, id, error) in parsed.errors {
                            diagnostics.record_session_error(&diagnostic_kind, &path, &id, &error);
                        }
                        for (path, id, reason) in parsed.unsupported {
                            diagnostics.record_unsupported(&diagnostic_kind, &path, &id, &reason);
                        }
                        for record in parsed.records {
                            diagnostics.discover(&diagnostic_kind, &record.path);
                            active_paths.insert(record.path.to_string_lossy().into_owned());
                            let key = record.summary["_key"]
                                .as_str()
                                .unwrap_or_default()
                                .to_string();
                            next.entry(key).or_insert(record);
                        }
                    }
                    Err(error) => diagnostics.record_error(&diagnostic_kind, &source.root, &error),
                }
                continue;
            }
            if matches!(source.format, SourceFormat::OpenCode | SourceFormat::Kilo) {
                if !source.root.exists() {
                    continue;
                }
                let parsed = match opencode::parse_source(source) {
                    Ok(parsed) => parsed,
                    Err(error) => {
                        diagnostics.record_error(&diagnostic_kind, &source.root, &error);
                        eprintln!("无法解析 {} 来源：{error}", source.display_name);
                        continue;
                    }
                };
                for path in &parsed.active_paths {
                    diagnostics.discover(&diagnostic_kind, Path::new(path));
                    active_paths.insert(path.clone());
                    active_paths.insert(path_identity(Path::new(path)));
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
                        detail_locator: Some(DetailLocator::OpenCode(session.detail_locator)),
                    });
                }
                continue;
            }
            if matches!(source.format, SourceFormat::ZCode) {
                if !source.root.exists() {
                    continue;
                }
                let parsed = match zcode::parse_source(source) {
                    Ok(parsed) => parsed,
                    Err(error) => {
                        diagnostics.record_error(&diagnostic_kind, &source.root, &error);
                        eprintln!("无法解析 ZCode 来源：{error}");
                        continue;
                    }
                };
                for path in &parsed.active_paths {
                    diagnostics.discover(&diagnostic_kind, Path::new(path));
                    active_paths.insert(path.clone());
                    active_paths.insert(path_identity(Path::new(path)));
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
                        detail_locator: Some(DetailLocator::ZCode(session.detail_locator)),
                    });
                }
                continue;
            }
            if matches!(source.format, SourceFormat::Devin) {
                if !source.root.exists() {
                    continue;
                }
                match devin::parse_source(source) {
                    Ok(parsed) => {
                        for (path, id, error) in parsed.errors {
                            diagnostics.record_session_error(&diagnostic_kind, &path, &id, &error);
                        }
                        for path in &parsed.active_paths {
                            diagnostics.discover(&diagnostic_kind, Path::new(path));
                            active_paths.insert(path.clone());
                            active_paths.insert(path_identity(Path::new(path)));
                        }
                        for session in parsed.sessions {
                            let key = session.summary["_key"]
                                .as_str()
                                .unwrap_or_default()
                                .to_string();
                            let cli = session.detail_locator.cli;
                            let record = StoredSession {
                                search_text: session.search_text,
                                summary: session.summary,
                                source: source.clone(),
                                path: session.path,
                                detail_locator: Some(DetailLocator::Devin(session.detail_locator)),
                            };
                            match next.entry(key) {
                                Entry::Vacant(slot) => {
                                    slot.insert(record);
                                }
                                Entry::Occupied(mut slot) => {
                                    // 桌面版镜像的 CLI 会话与 CLI 库记录冲突时，
                                    // 以 CLI 聚合库为准（镜像可能滞后）。
                                    let mirror_only = matches!(
                                        slot.get().detail_locator,
                                        Some(DetailLocator::Devin(ref locator))
                                            if !locator.cli
                                    );
                                    if cli && mirror_only {
                                        slot.insert(record);
                                    }
                                }
                            }
                        }
                    }
                    Err(error) => diagnostics.record_error(&diagnostic_kind, &source.root, &error),
                }
                continue;
            }
            if matches!(source.format, SourceFormat::Hermes) {
                if !source.root.exists() {
                    continue;
                }
                match hermes::parse_source(source) {
                    Ok(parsed) => {
                        for (path, id, error) in parsed.errors {
                            diagnostics.record_session_error(&diagnostic_kind, &path, &id, &error);
                        }
                        for path in &parsed.active_paths {
                            diagnostics.discover(&diagnostic_kind, Path::new(path));
                            active_paths.insert(path.clone());
                            active_paths.insert(path_identity(Path::new(path)));
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
                                detail_locator: Some(DetailLocator::Hermes(session.detail_locator)),
                            });
                        }
                    }
                    Err(error) => diagnostics.record_error(&diagnostic_kind, &source.root, &error),
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
                let parsed = if matches!(source.format, SourceFormat::Kimi | SourceFormat::Copilot)
                {
                    // Kimi 的标题来自 state.json，目录来自 kimi.json 或 session_index.jsonl；
                    // Copilot 的标题/工作目录保存在相邻 workspace.yaml。
                    // 仅使用事件文件指纹会让这些元数据变化后继续命中旧缓存。
                    parse_summary(&path, source)
                } else {
                    self.index_cache
                        .get(&path, source.kind, &metadata)
                        .map(|cached| (cached.summary, cached.search_text))
                        .map(Ok)
                        .unwrap_or_else(|| parse_summary(&path, source))
                };
                match parsed {
                    Ok((summary, search_text)) => {
                        self.index_cache
                            .put(&path, source.kind, &metadata, &summary, &search_text);
                        if is_placeholder_session(source, &summary) {
                            continue;
                        }
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
        self.rebuild_summary_list();
        Ok(())
    }

    pub fn refresh_paths(&mut self, paths: &BTreeSet<PathBuf>) -> Result<bool, String> {
        let changed = self.refresh_paths_metadata(paths)?;
        if changed {
            self.rebuild_search_index()?;
        }
        Ok(changed)
    }

    pub fn refresh_paths_metadata(&mut self, paths: &BTreeSet<PathBuf>) -> Result<bool, String> {
        // 来源集合变化时，事件路径无法可靠匹配新旧来源，继续走增量更新
        // 会让旧目录的 records 残留（新旧会话混列、已删文件变幽灵会话），
        // 直接全量重建。
        if self.resolve_sources() {
            self.refresh_metadata()?;
            return Ok(true);
        }
        // Gemini 会话可能跨文件，Claude 新旧布局也可能包含相同会话 ID。
        // 单路径更新无法可靠重建聚合结果或来源优先级，因此复用缓存全量刷新。
        if paths.iter().any(|path| {
            self.sources.iter().any(|source| {
                let belongs_to_source = if matches!(source.format, SourceFormat::Cursor) {
                    cursor::matches_path(&source.root, path)
                } else if matches!(source.format, SourceFormat::Devin) {
                    devin::matches_path(&source.root, path)
                } else if matches!(source.format, SourceFormat::Hermes) {
                    hermes::matches_path(&source.root, path)
                } else if matches!(
                    source.format,
                    SourceFormat::OpenCode | SourceFormat::Kilo | SourceFormat::ZCode
                ) {
                    opencode_event_matches(&source.root, path)
                } else {
                    path.starts_with(&source.root)
                };
                (matches!(
                    source.format,
                    SourceFormat::Gemini
                        | SourceFormat::Claude
                        | SourceFormat::OpenCode
                        | SourceFormat::Kilo
                        | SourceFormat::ZCode
                        | SourceFormat::Cursor
                        | SourceFormat::Devin
                        | SourceFormat::Hermes
                ) || matches!(source.format, SourceFormat::Kimi)
                    && path.file_name().and_then(|value| value.to_str()) != Some("wire.jsonl")
                    || matches!(source.format, SourceFormat::Copilot)
                        && path.file_name().and_then(|value| value.to_str())
                            == Some("workspace.yaml")
                    || matches!(source.format, SourceFormat::VsCodeCopilot)
                        && path.file_name().and_then(|value| value.to_str())
                            == Some("workspace.json"))
                    && belongs_to_source
            })
        }) {
            // VS Code Copilot Chat 的 cwd 取自会话同级 workspace.json，
            // 事件文件指纹不覆盖它；全量重建前按目录失效对应缓存。
            for path in paths {
                if path.file_name().and_then(|v| v.to_str()) != Some("workspace.json")
                    || !self.sources.iter().any(|source| {
                        matches!(source.format, SourceFormat::VsCodeCopilot)
                            && path.starts_with(&source.root)
                    })
                {
                    continue;
                }
                let Some(dir) = path.parent() else {
                    continue;
                };
                for record in self.records.values() {
                    if record.path.starts_with(dir) {
                        self.index_cache.remove(&record.path);
                    }
                }
            }
            self.refresh_metadata()?;
            return Ok(true);
        }

        self.scan_diagnostics.touch();
        let mut changed = false;
        for path in paths {
            let Some(source) = self
                .sources
                .iter()
                .find(|source| {
                    !matches!(
                        source.format,
                        SourceFormat::Gemini
                            | SourceFormat::OpenCode
                            | SourceFormat::Kilo
                            | SourceFormat::ZCode
                            | SourceFormat::Cursor
                            | SourceFormat::Devin
                            | SourceFormat::Hermes
                    ) && path.starts_with(&source.root)
                })
                .cloned()
            else {
                continue;
            };
            let diagnostic_kind = diagnostic_source_kind(source.kind);
            // VsCodeCopilot 的 .jsonl 追加日志取代同 id 的 .json 平铺文件；
            // 旧记录的路径不等于当前 path，需要一并纳入受影响集合。
            let shadowed = if matches!(source.format, SourceFormat::VsCodeCopilot) {
                vscode_copilot::shadowed_flat_path(path)
            } else {
                None
            };
            let affected = self
                .records
                .iter()
                .filter(|(_, record)| {
                    record.path == *path
                        || shadowed.as_deref() == Some(record.path.as_path())
                        || (!path.exists() && record.path.starts_with(path))
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
            // 监听事件可能在文件写入到一半时触发；单个文件读取或解析失败
            // 只记录诊断并保留旧记录，等下次变更事件重试，不能让同批次
            // 其他文件的更新一起丢失。
            let metadata = match fs::metadata(path) {
                Ok(metadata) => metadata,
                Err(error) => {
                    self.scan_diagnostics.record_error(
                        diagnostic_kind,
                        path,
                        &format!("无法读取文件元数据：{}", error_text(error)),
                    );
                    continue;
                }
            };
            let (summary, search_text) = match parse_summary(path, &source) {
                Ok(parsed) => parsed,
                Err(error) => {
                    self.scan_diagnostics
                        .record_error(diagnostic_kind, path, &error);
                    continue;
                }
            };
            self.scan_diagnostics.clear_error(diagnostic_kind, path);
            for (key, record_path) in &affected {
                self.records.remove(key);
                self.index_cache.remove(record_path);
            }
            self.index_cache
                .put(path, source.kind, &metadata, &summary, &search_text);
            // 占位会话不进列表；若顶掉了旧记录仍需标记变更。
            if is_placeholder_session(&source, &summary) {
                changed |= !affected.is_empty();
                continue;
            }
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
            self.rebuild_summary_list();
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

    pub(crate) fn rebuild_summaries(&mut self) -> Result<(), String> {
        self.rebuild_summary_list();
        self.rebuild_search_index()
    }

    pub(crate) fn rebuild_summary_list(&mut self) {
        self.summaries = self
            .records
            .values()
            .map(|record| record.summary.clone())
            .collect();
        self.summaries
            .sort_by(|left, right| timestamp_of(right).cmp(timestamp_of(left)));
        self.detail_cache.clear();
    }

    pub fn publish_metadata_from(&mut self, working: &Self) {
        self.summaries = working.summaries.clone();
        self.records = working.records.clone();
        self.sources = working.sources.clone();
        self.sources_config = working.sources_config.clone();
        self.scan_diagnostics = working.scan_diagnostics.clone();
        self.detail_cache.clear();
    }

    pub fn rebuild_search_index(&mut self) -> Result<(), String> {
        self.rebuild_search_index_with_progress(|_, _| Ok(()))
    }

    pub fn rebuild_search_index_with_progress(
        &mut self,
        mut progress: impl FnMut(usize, usize) -> Result<(), String>,
    ) -> Result<(), String> {
        let total = self.records.len();
        progress(0, total)?;
        for (position, (key, record)) in self.records.iter().enumerate() {
            let content_fingerprint = match &record.detail_locator {
                Some(DetailLocator::OpenCode(locator)) => Some(&locator.content_fingerprint),
                Some(DetailLocator::ZCode(locator)) => Some(&locator.content_fingerprint),
                Some(DetailLocator::Cursor(locator)) => Some(&locator.content_fingerprint),
                Some(DetailLocator::Devin(locator)) => Some(&locator.content_fingerprint),
                Some(DetailLocator::Hermes(locator)) => Some(&locator.content_fingerprint),
                _ => None,
            };
            let paths = match &record.detail_locator {
                Some(DetailLocator::Gemini(locator)) => {
                    match gemini::session_backup_paths(&record.source, locator) {
                        Ok(paths) => paths,
                        Err(error) => {
                            self.scan_diagnostics.record_error(
                                diagnostic_source_kind(record.source.kind),
                                &record.path,
                                &format!("搜索索引：{error}"),
                            );
                            self.index_cache.search.invalidate(key)?;
                            progress(position + 1, total)?;
                            continue;
                        }
                    }
                }
                _ if content_fingerprint.is_some() => Vec::new(),
                _ => session_backup_paths(&record.path),
            };
            let mut stamps = Vec::new();
            for path in paths
                .into_iter()
                .chain((content_fingerprint.is_none()).then(|| record.path.clone()))
            {
                for suffix in ["", "-wal"] {
                    let mut name = path.as_os_str().to_os_string();
                    name.push(suffix);
                    let metadata = fs::metadata(&name).ok();
                    stamps.push(format!(
                        "{:?}:{:?}",
                        name,
                        metadata.map(|m| (m.len(), m.modified().ok()))
                    ));
                }
            }
            let fingerprint = search_fingerprint(
                &record.summary,
                &record.search_text,
                &stamps,
                content_fingerprint.map(String::as_str),
            );
            let result = self
                .index_cache
                .search
                .refresh(key, &fingerprint, |visitor| {
                    match &record.detail_locator {
                        Some(DetailLocator::Gemini(locator)) => {
                            gemini::visit_detail(&record.source, locator, visitor)
                        }
                        Some(DetailLocator::OpenCode(locator)) => {
                            opencode::visit_detail(&record.source, locator, visitor)
                        }
                        Some(DetailLocator::ZCode(locator)) => {
                            zcode::visit_detail(&record.source, locator, visitor)
                        }
                        Some(DetailLocator::Cursor(locator)) => {
                            cursor::visit_detail(&record.source, locator, visitor)
                        }
                        Some(DetailLocator::Devin(locator)) => {
                            devin::visit_detail(&record.source, locator, visitor)
                        }
                        Some(DetailLocator::Hermes(locator)) => {
                            hermes::visit_detail(&record.source, locator, visitor)
                        }
                        None => visit_detail(&record.path, &record.source, visitor),
                    }
                    .map(|_| ())
                });
            match result {
                Ok(()) => {}
                Err(crate::search::RefreshError::Source(error)) => {
                    self.scan_diagnostics.record_error(
                        diagnostic_source_kind(record.source.kind),
                        &record.path,
                        &format!("搜索索引：{error}"),
                    );
                    self.index_cache.search.invalidate(key)?;
                }
                Err(crate::search::RefreshError::Database(error)) => return Err(error),
            }
            progress(position + 1, total)?;
        }
        self.index_cache
            .search
            .prune(&self.records.keys().cloned().collect())?;
        Ok(())
    }
}
