//! 会话查询:列表、搜索计划(锁外全文查询)、搜索上下文与详情读取。
use std::collections::{BTreeSet, HashMap};

use serde_json::{Value, json};

use super::helpers::{bool_query, paginate, scan_timestamp, timestamp_of};
use super::parse::parse_detail;
use super::{
    DetailLocator, EXPORT_MESSAGE_LIMIT, EXPORT_MESSAGE_OVERHEAD, EXPORT_TOTAL_LIMIT, SessionStore,
    SourceFormat, cursor, deepseek, devin, gemini, hermes, jetbrains_air, opencode, workbuddy,
    zcode,
};

impl SessionStore {
    pub fn related_sessions(
        &self,
        key: &str,
        workspace: &crate::workspace::WorkspaceSnapshot,
    ) -> Value {
        let Some(key) = self.resolve_record_key(key) else {
            return json!({ "items": [], "total": 0 });
        };
        let current = &self.records[&key].summary;
        let id = current["id"].as_str().unwrap_or_default();
        let parent = current["parent_session_id"].as_str().unwrap_or_default();
        let family_source = |kind: &str| {
            if kind == "codex_archived" {
                "codex".to_string()
            } else {
                kind.to_string()
            }
        };
        let source = family_source(current["source_kind"].as_str().unwrap_or_default());
        let mut items = Vec::new();
        let mut total = 0;
        for summary in &self.summaries {
            if summary["_key"].as_str() == Some(&key)
                || family_source(summary["source_kind"].as_str().unwrap_or_default()) != source
                || workspace
                    .sessions
                    .get(summary["_key"].as_str().unwrap_or_default())
                    .is_some_and(|state| state.removed)
            {
                continue;
            }
            let relation = if !parent.is_empty() && summary["id"] == parent {
                "parent"
            } else if !id.is_empty() && summary["parent_session_id"] == id {
                "child"
            } else {
                continue;
            };
            total += 1;
            if relation == "parent" {
                if items.len() == 32 {
                    items.pop();
                }
                items.insert(0, json!({ "key": summary["_key"], "title": summary["title"], "relation": relation, "source": summary["display_source"] }));
                continue;
            }
            if items.len() < 32 {
                items.push(json!({ "key": summary["_key"], "title": summary["title"], "relation": relation, "source": summary["display_source"] }));
            }
        }
        json!({ "items": items, "total": total })
    }

    pub fn list(
        &self,
        query: &HashMap<String, String>,
        workspace: &crate::workspace::WorkspaceSnapshot,
    ) -> Value {
        let sessions = self.filtered(query, workspace);
        let total = sessions.len();
        paginate(
            sessions,
            query,
            json!({ "session_roots": self.session_roots(), "scanning": self.scanning(), "total": total }),
        )
    }

    /// 搜索分两步执行：先在持有会话锁时收集输入（摘要快照和索引句柄），
    /// 耗时的全文查询在锁外进行，避免搜索阻塞列表和详情读取。
    pub fn prepare_search(
        &self,
        query: &HashMap<String, String>,
        workspace: &crate::workspace::WorkspaceSnapshot,
    ) -> SearchPlan {
        SearchPlan {
            index: self.index_cache.search.clone(),
            summaries: self.filtered(query, workspace),
            scanning: self.scanning(),
            session_roots: self.session_roots(),
        }
    }

    /// 仅测试使用的一步式搜索；运行时后端走 prepare_search + 锁外执行。
    #[cfg(test)]
    pub fn search(
        &self,
        query: &HashMap<String, String>,
        workspace: &crate::workspace::WorkspaceSnapshot,
    ) -> Result<Value, String> {
        self.prepare_search(query, workspace)
            .search(query, workspace)
    }

    pub fn search_context(
        &self,
        key: &str,
        ordinal: i64,
        message_key: Option<&str>,
        query: &str,
    ) -> Result<Value, String> {
        let record = self.records.get(key).ok_or("会话不存在")?;
        let mut messages = self.index_cache.search.context(key, ordinal, query)?;
        for message in &mut messages {
            super::annotate_activity(message);
        }
        if !messages
            .iter()
            .any(|m| m["search_ordinal"].as_i64() == Some(ordinal))
        {
            return Err("搜索位置已失效，请重新搜索".into());
        }
        if message_key
            .filter(|value| !value.is_empty())
            .is_some_and(|expected| {
                !messages.iter().any(|m| {
                    m["search_ordinal"].as_i64() == Some(ordinal)
                        && m["_message_key"].as_str() == Some(expected)
                })
            })
        {
            return Err("搜索位置已失效，请重新搜索".into());
        }
        Ok(
            json!({"summary":record.summary,"conversation_messages":messages,"raw_events":[],"search_context":true,"search_target":ordinal,"truncation":{"truncated":true,"messages":{"omitted":0},"raw_events":{"omitted":0}}}),
        )
    }

    pub fn prepare_detail(&mut self, key: &str) -> Result<DetailRead, crate::error::ApiError> {
        use crate::error::ApiError;
        let resolved = self
            .resolve_record_key(key)
            .ok_or_else(|| ApiError::new(ApiError::SESSION_NOT_FOUND, "会话不存在"))?;
        if let Some(detail) = self.detail_cache.get(&resolved) {
            return Ok(DetailRead::Cached(detail));
        }
        let record = self
            .records
            .get(&resolved)
            .ok_or_else(|| ApiError::new(ApiError::SESSION_NOT_FOUND, "会话不存在"))?;
        Ok(DetailRead::Pending(Box::new(DetailPlan {
            key: resolved,
            generation: self.detail_cache.generation,
            record: super::StoredSession {
                summary: record.summary.clone(),
                search_text: String::new(),
                source: record.source.clone(),
                path: record.path.clone(),
                detail_locator: record.detail_locator.clone(),
            },
        })))
    }

    /// 全量导出不走详情缓存：记录快照在锁内取，解析在锁外进行。
    pub fn prepare_export(&mut self, key: &str) -> Result<ExportPlan, crate::error::ApiError> {
        use crate::error::ApiError;
        let resolved = self
            .resolve_record_key(key)
            .ok_or_else(|| ApiError::new(ApiError::SESSION_NOT_FOUND, "会话不存在"))?;
        let record = self
            .records
            .get(&resolved)
            .ok_or_else(|| ApiError::new(ApiError::SESSION_NOT_FOUND, "会话不存在"))?;
        Ok(ExportPlan {
            record: super::StoredSession {
                summary: record.summary.clone(),
                search_text: String::new(),
                source: record.source.clone(),
                path: record.path.clone(),
                detail_locator: record.detail_locator.clone(),
            },
        })
    }

    pub fn cache_detail(&mut self, plan: &DetailPlan, detail: &Value, size: usize) -> bool {
        if self.detail_cache.generation != plan.generation
            || !self.records.get(&plan.key).is_some_and(|record| {
                record.path == plan.record.path
                    && record.source == plan.record.source
                    && record.summary == plan.record.summary
            })
        {
            return false;
        }
        self.detail_cache
            .insert(plan.key.clone(), detail.clone(), size);
        true
    }

    // 写操作保留锁内读取，以保持删除前校验与写回的原子边界。
    pub fn detail(&mut self, key: &str) -> Result<Value, crate::error::ApiError> {
        match self.prepare_detail(key)? {
            DetailRead::Cached(detail) => Ok(detail),
            DetailRead::Pending(plan) => {
                let (detail, size) = plan.read()?;
                self.cache_detail(&plan, &detail, size);
                Ok(detail)
            }
        }
    }

    /// 按详情里的定位信息回读单张内嵌图片；不重新解析整份会话。
    pub fn read_attachment(
        &self,
        key: &str,
        request: &Value,
    ) -> Result<Value, crate::error::ApiError> {
        use crate::error::ApiError;
        let missing = || ApiError::new(ApiError::SESSION_NOT_FOUND, "会话不存在");
        let resolved = self.resolve_record_key(key).ok_or_else(missing)?;
        let record = self.records.get(&resolved).ok_or_else(missing)?;
        let result = match &record.detail_locator {
            Some(DetailLocator::ZCode(locator)) => zcode::read_attachment(locator, request),
            Some(DetailLocator::Devin(locator)) => devin::read_attachment(locator, request),
            Some(_) => Err("当前来源暂不支持图片预览".into()),
            None if record.source.format == SourceFormat::DeepSeek => {
                deepseek::read_attachment(&record.path, &record.source, request)
            }
            None if record.source.format == SourceFormat::JetBrainsAir => {
                jetbrains_air::read_attachment(&record.path, &record.source, request)
            }
            None if record.source.format == SourceFormat::WorkBuddy => {
                workbuddy::read_attachment(&record.path, &record.source, request)
            }
            None => super::attachment::read_image(record, request),
        };
        result.map_err(|error| ApiError::new(ApiError::SESSION_READ_FAILED, error))
    }

    /// 仅取摘要（不解析详情），供恢复会话这类只需要 id/cwd/source_kind 的操作使用。
    pub fn summary_for_key(&self, key: &str) -> Option<Value> {
        let resolved = self.resolve_record_key(key)?;
        Some(self.records.get(&resolved)?.summary.clone())
    }

    pub(crate) fn resolve_record_key(&self, key: &str) -> Option<String> {
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
}

/// 从会话锁内取出的搜索输入；耗时的全文查询可在会话锁外执行。
pub(crate) struct SearchPlan {
    index: std::sync::Arc<crate::search::SearchIndex>,
    summaries: Vec<Value>,
    scanning: bool,
    session_roots: Vec<String>,
}

impl SearchPlan {
    pub(crate) fn search(
        self,
        query: &HashMap<String, String>,
        workspace: &crate::workspace::WorkspaceSnapshot,
    ) -> Result<Value, String> {
        let index = std::sync::Arc::clone(&self.index);
        index.read_snapshot(|snapshot| {
        let needle = query
            .get("q")
            .map(|value| value.to_lowercase())
            .unwrap_or_default();
        let terms = crate::search::terms(&needle);
        // 正则模式：查询串整体作为一个正则；索引正文已小写化，统一加不区分大小写。
        let regex_mode = bool_query(query, "regex");
        let pattern = if regex_mode {
            let source = query.get("q").map(String::as_str).unwrap_or_default();
            Some(
                regex::Regex::new(&format!("(?i){source}"))
                    .map_err(|error| format!("正则表达式无效：{error}"))?,
            )
        } else {
            None
        };
        // 会话时间范围（本地日期键，含首尾）。
        let from = query
            .get("from")
            .map(String::as_str)
            .filter(|value| !value.is_empty());
        let to = query
            .get("to")
            .map(String::as_str)
            .filter(|value| !value.is_empty());
        let in_range = |summary: &Value| {
            let date = match super::helpers::local_date_key(timestamp_of(summary)) {
                Some(date) => date,
                None => return from.is_none() && to.is_none(),
            };
            from.map(|start| date.as_str() >= start).unwrap_or(true)
                && to.map(|end| date.as_str() <= end).unwrap_or(true)
        };
        let keys: BTreeSet<String> = self
            .summaries
            .iter()
            .filter(|summary| in_range(summary))
            .filter_map(|summary| summary["_key"].as_str().map(String::from))
            .collect();
        let filters = crate::search::SearchFilters::from_query(query);
        let mut indexed = if let Some(pattern) = &pattern {
            snapshot.query_regex(pattern, &filters, |key, message| {
                keys.contains(key)
                    && (bool_query(query, "show_removed") || !workspace.message_removed(key, message))
            })?
        } else {
            snapshot.query_hits_filtered(&needle, &filters, |key, message| {
                keys.contains(key)
                    && (bool_query(query, "show_removed") || !workspace.message_removed(key, message))
            })?
        };
        let mut filtered: Vec<Value> = self
            .summaries
            .into_iter()
            .filter_map(|summary| {
                let key = summary["_key"].as_str()?;
                // 时间范围等条件在构建 keys 时已过滤；标题/备注等字段命中
                // 也必须落在同一集合内，否则范围外的会话会经字段命中回流。
                if !keys.contains(key) {
                    return None;
                }
                let mut hits = indexed.remove(key).unwrap_or_default();
                hits.retain(|hit| bool_query(query,"show_removed") || !workspace.message_removed(key,hit["message_key"].as_str().unwrap_or_default()));
                // 指定了角色或工具筛选时，只在消息正文里匹配；标题等摘要字段
                // 的命中不参与，避免“只搜用户提问”被标题匹配绕过。
                let augment_fields = filters.roles.is_empty() && filters.tool.is_none() && !filters.activity_only();
                if augment_fields {
                for (field, text, score) in [
                    ("title",summary["title"].as_str().unwrap_or_default().to_string(),5.0),
                    ("path",["id","cwd","file_path","source_kind","model_provider"].iter().filter_map(|field|summary[*field].as_str()).collect::<Vec<_>>().join("\n"),1.0),
                    ("note",summary["workspace"]["note"].as_str().unwrap_or_default().to_string(),4.0),
                    ("tag",summary["workspace"]["tags"].as_array().map(|tags|tags.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" ")).unwrap_or_default(),4.0),
                ] {
                    let lower = text.to_lowercase();
                    if let Some(pattern) = &pattern {
                        if let Some(matched) = pattern.find(&lower) {
                            hits.push(json!({"field":field,"term":matched.as_str(),"snippet":crate::search::snippet(&text,matched.as_str()),"score":score}));
                        }
                    } else {
                        for term in &terms {
                            if lower.contains(term) { hits.push(json!({"field":field,"term":term,"snippet":crate::search::snippet(&text,term),"score":score})); }
                        }
                    }
                }
                }
                let matched = if regex_mode || (terms.is_empty() && filters.activity_only()) {
                    !hits.is_empty()
                } else {
                    !terms.is_empty() && terms.iter().all(|term|hits.iter().any(|hit|hit["term"].as_str()==Some(term)))
                };
                if !matched {return None;}
                hits.sort_by(|a,b|b["score"].as_f64().unwrap_or_default().total_cmp(&a["score"].as_f64().unwrap_or_default()));
                let score = hits.first().and_then(|hit|hit["score"].as_f64()).unwrap_or_default();
                let mut seen = BTreeSet::new();
                hits.retain(|hit|seen.insert((hit["field"].to_string(),hit["ordinal"].to_string())));
                let message_hit = hits.iter().find(|hit| hit["ordinal"].is_i64()).cloned();
                hits.truncate(2);
                if !hits.iter().any(|hit| hit["ordinal"].is_i64())
                    && let Some(hit) = message_hit { hits.truncate(1); hits.push(hit); }
                let mut result = summary;
                result["search_snippet"] = hits.first().map(|hit|hit["snippet"].clone()).unwrap_or_default();
                result["search_hits"] = json!(hits);
                result["search_score"] = json!(score);
                Some(result)
            })
            .collect();
        if query.get("sort").map(String::as_str) != Some("recent") {
            filtered.sort_by(|a, b| {
                b["search_score"]
                    .as_f64()
                    .unwrap_or_default()
                    .total_cmp(&a["search_score"].as_f64().unwrap_or_default())
                    .then_with(|| timestamp_of(b).cmp(timestamp_of(a)))
                    .then_with(|| a["_key"].as_str().cmp(&b["_key"].as_str()))
            });
        }
        let total = filtered.len();
        let mut page = paginate(
            filtered,
            query,
            json!({ "session_roots": self.session_roots, "total":total, "scanning":self.scanning, "query": query.get("q").cloned().unwrap_or_default() }),
        );
        if let Some(sessions) = page["sessions"].as_array_mut() {
            for summary in sessions {
                if let Some(hits) = summary["search_hits"].as_array_mut() {
                    for hit in hits {
                        snapshot.hydrate_hit(hit)?;
                    }
                }
                summary["search_snippet"] = summary["search_hits"][0]["snippet"].clone();
            }
        }
        Ok(page)
        })
    }
}

pub(crate) enum DetailRead {
    Cached(Value),
    Pending(Box<DetailPlan>),
}
pub(crate) struct DetailPlan {
    key: String,
    generation: u64,
    record: super::StoredSession,
}

fn detail_stamp(path: &std::path::Path) -> Vec<Option<(u64, std::time::SystemTime)>> {
    [
        path.to_path_buf(),
        std::path::PathBuf::from(format!("{}-wal", path.display())),
    ]
    .iter()
    .map(|path| {
        let metadata = std::fs::metadata(path).ok()?;
        Some((metadata.len(), metadata.modified().ok()?))
    })
    .collect()
}
impl DetailPlan {
    pub fn read(&self) -> Result<(Value, usize), crate::error::ApiError> {
        use crate::error::ApiError;
        let (detail, size, changed) = self.read_with_change_flag()?;
        if changed {
            return Err(ApiError::new("detail_changed", "会话正在更新，请重试"));
        }
        Ok((detail, size))
    }

    /// 与 read 相同，但解析窗口内文件又变化时不报错，以 changed 标志
    /// 交还调用方：详情读取对持续写入的活跃会话可在末次尝试接受
    /// 略旧结果，而不是反复报错。
    pub fn read_with_change_flag(&self) -> Result<(Value, usize, bool), crate::error::ApiError> {
        use crate::error::ApiError;
        crate::request_control::check()?;
        let before = detail_stamp(&self.record.path);
        let mut detail = if let Some(locator) = &self.record.detail_locator {
            match locator {
                DetailLocator::Gemini(locator) => {
                    gemini::parse_detail(&self.record.source, locator)
                }
                DetailLocator::OpenCode(locator) => {
                    opencode::parse_detail(&self.record.source, locator)
                }
                DetailLocator::ZCode(locator) => zcode::parse_detail(&self.record.source, locator),
                DetailLocator::Cursor(locator) => {
                    cursor::visit_detail(&self.record.source, locator, &mut |_| {})
                }
                DetailLocator::Devin(locator) => devin::parse_detail(&self.record.source, locator),
                DetailLocator::Hermes(locator) => {
                    hermes::parse_detail(&self.record.source, locator)
                }
            }
        } else {
            parse_detail(&self.record.path, &self.record.source)
        }
        .map_err(|error| ApiError::new(ApiError::SESSION_READ_FAILED, error))?;
        // 与列表摘要一致的最近写入时间，供"进行中"标记与实时刷新判断。
        if let Some(ms) = std::fs::metadata(&self.record.path)
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .and_then(|duration| i64::try_from(duration.as_millis()).ok())
        {
            detail["summary"]["file_mtime_ms"] = json!(ms);
        }
        if let Some(messages) = detail["conversation_messages"].as_array_mut() {
            for message in messages {
                super::annotate_activity(message);
            }
        }
        let size = serde_json::to_vec(&detail)
            .map(|value| value.len())
            .unwrap_or_default();

        crate::request_control::check()?;
        let changed = before != detail_stamp(&self.record.path);
        Ok((detail, size, changed))
    }
}

/// 全量导出的解析计划；与 DetailPlan 相同持有记录快照，但产出不受
/// 展示截断（条数、正文长度、头尾保留）约束的完整消息流。
pub(crate) struct ExportPlan {
    record: super::StoredSession,
}

impl ExportPlan {
    /// 重新遍历来源生成完整导出：visitor 看到的是截断与头尾丢弃之前的
    /// 完整消息，导出只受 EXPORT_* 硬上限约束；已软移除的消息不进入导出。
    pub fn read(
        &self,
        workspace: &crate::workspace::WorkspaceSnapshot,
    ) -> Result<Value, crate::error::ApiError> {
        use crate::error::ApiError;
        crate::request_control::check()?;
        let before = detail_stamp(&self.record.path);
        let mut collected: Vec<Value> = Vec::new();
        let mut visited = 0_usize;
        let mut collected_bytes = 0_usize;
        let mut export_limited = false;
        let mut detail = {
            let visitor = &mut |message: &Value| {
                visited += 1;
                if export_limited {
                    return;
                }
                let cost = message["text"]
                    .as_str()
                    .map_or(0, str::len)
                    .saturating_add(EXPORT_MESSAGE_OVERHEAD);
                if collected.len() >= EXPORT_MESSAGE_LIMIT
                    || collected_bytes.saturating_add(cost) > EXPORT_TOTAL_LIMIT
                {
                    export_limited = true;
                    return;
                }
                collected_bytes += cost;
                collected.push(message.clone());
            };
            match &self.record.detail_locator {
                Some(DetailLocator::Gemini(locator)) => {
                    // Gemini 的 visit_detail 只回放消息、不产出详情骨架，
                    // 需要 parse_detail 补齐 summary 与原始事件。
                    gemini::visit_detail(&self.record.source, locator, visitor)
                        .and_then(|_| gemini::parse_detail(&self.record.source, locator))
                }
                Some(DetailLocator::OpenCode(locator)) => {
                    opencode::visit_detail(&self.record.source, locator, visitor)
                }
                Some(DetailLocator::ZCode(locator)) => {
                    zcode::visit_detail(&self.record.source, locator, visitor)
                }
                Some(DetailLocator::Cursor(locator)) => {
                    cursor::visit_detail(&self.record.source, locator, visitor)
                }
                Some(DetailLocator::Devin(locator)) => {
                    devin::visit_detail(&self.record.source, locator, visitor)
                }
                Some(DetailLocator::Hermes(locator)) => {
                    hermes::visit_detail(&self.record.source, locator, visitor)
                }
                None => super::parse::visit_detail(&self.record.path, &self.record.source, visitor),
            }
        }
        .map_err(|error| ApiError::new(ApiError::SESSION_READ_FAILED, error))?;
        crate::request_control::check()?;

        let session_key = detail["summary"]["_key"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        let omitted = visited - collected.len();
        let mut removed = 0_usize;
        collected.retain(|message| {
            let dropped = message["_message_key"]
                .as_str()
                .is_some_and(|key| workspace.message_removed(&session_key, key));
            removed += usize::from(dropped);
            !dropped
        });
        let parse_errors = detail["raw_events"]
            .as_array()
            .map(|events| {
                events
                    .iter()
                    .filter(|event| event["type"].as_str() == Some("parse_error"))
                    .count()
            })
            .unwrap_or_default();
        let changed = before != detail_stamp(&self.record.path);
        if let Some(summary) = detail["summary"].as_object_mut() {
            // detail_truncated 描述的是「详情展示被截断」；完整导出的完整性
            // 以 export_info 为准，不继承该标记。
            summary.remove("detail_truncated");
            if let Ok(metadata) = std::fs::metadata(&self.record.path) {
                summary.insert("file_size_bytes".into(), json!(metadata.len()));
                if let Some(ms) = metadata
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .and_then(|duration| i64::try_from(duration.as_millis()).ok())
                {
                    summary.insert("file_mtime_ms".into(), json!(ms));
                }
            }
        }
        let exported = collected.len();
        detail["conversation_messages"] = json!(collected);
        detail["export_info"] = json!({
            "scope": "full_session",
            // partial 只描述「导出内容不完整」：达到导出硬上限、原始记录
            // 解析失败或读取窗口内来源仍在写入。软移除是刻意排除，不算缺失；
            // 原始事件只提供有界视图，条数单列不算不完整。
            "partial": export_limited || changed || parse_errors > 0,
            "message_count": exported,
            "total_messages": visited,
            "omitted_messages": omitted,
            "removed_messages": removed,
            "export_limited": export_limited,
            "changed_during_read": changed,
            "parse_errors": parse_errors,
            "raw_events_omitted": detail["truncation"]["raw_events"]["omitted"]
                .as_u64()
                .unwrap_or_default(),
            "generated_at": scan_timestamp(),
        });
        Ok(detail)
    }
}
