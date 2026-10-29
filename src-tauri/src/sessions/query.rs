//! 会话查询:列表、搜索计划(锁外全文查询)、搜索上下文与详情读取。
use std::collections::{BTreeSet, HashMap};

use serde_json::{Value, json};

use super::helpers::{bool_query, paginate, timestamp_of};
use super::parse::parse_detail;
use super::{
    DetailLocator, SessionStore, SourceFormat, cursor, deepseek, devin, gemini, hermes, opencode,
    zcode,
};

impl SessionStore {
    pub fn list(
        &self,
        query: &HashMap<String, String>,
        workspace: &crate::workspace::WorkspaceSnapshot,
    ) -> Value {
        paginate(
            self.filtered(query, workspace),
            query,
            json!({ "session_roots": self.session_roots(), "scanning": self.scanning() }),
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
        let messages = self.index_cache.search.context(key, ordinal, query)?;
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

    pub fn detail(&mut self, key: &str) -> Result<Value, crate::error::ApiError> {
        use crate::error::ApiError;
        let missing = || ApiError::new(ApiError::SESSION_NOT_FOUND, "会话不存在");
        let resolved = self.resolve_record_key(key).ok_or_else(missing)?;
        if let Some(detail) = self.detail_cache.get(&resolved) {
            return Ok(detail);
        }
        let record = self.records.get(&resolved).ok_or_else(missing)?;
        let detail = if let Some(locator) = &record.detail_locator {
            match locator {
                DetailLocator::Gemini(locator) => gemini::parse_detail(&record.source, locator),
                DetailLocator::OpenCode(locator) => opencode::parse_detail(&record.source, locator),
                DetailLocator::ZCode(locator) => zcode::parse_detail(&record.source, locator),
                DetailLocator::Cursor(locator) => {
                    cursor::visit_detail(&record.source, locator, &mut |_| {})
                }
                DetailLocator::Devin(locator) => devin::parse_detail(&record.source, locator),
                DetailLocator::Hermes(locator) => hermes::parse_detail(&record.source, locator),
            }
        } else {
            parse_detail(&record.path, &record.source)
        }
        .map_err(|error| ApiError::new(ApiError::SESSION_READ_FAILED, error))?;
        let size = serde_json::to_vec(&detail)
            .map(|value| value.len())
            .unwrap_or_default();
        self.detail_cache.insert(resolved, detail.clone(), size);
        Ok(detail)
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
                let augment_fields = filters.roles.is_empty() && filters.tool.is_none();
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
                let matched = if regex_mode {
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
