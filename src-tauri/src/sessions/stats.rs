//! 聚合视图:筛选项(facets)、按 Agent/日期/来源统计与项目维度归并。
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;

use serde_json::{Value, json};

use super::SessionStore;
use super::helpers::{
    agent_kind, compact, count_values, diagnostic_source_kind, increment, insert_string,
    matches_filters, paginate, timestamp_of,
};

/// 只影响列表可见性、不改变导航维度的查询开关。
const DISPLAY_FLAGS: [&str; 4] = [
    "show_archived",
    "show_codex_archived",
    "show_removed",
    "show_hidden",
];

impl SessionStore {
    pub fn stats_sessions(
        &self,
        query: &HashMap<String, String>,
        workspace: &crate::workspace::WorkspaceSnapshot,
    ) -> Value {
        let mut sessions = self
            .filtered(query, workspace)
            .into_iter()
            .map(|mut summary| {
                super::activity::scope_summary(&mut summary, query);
                let known_usage = summary["usage"]["known"] == true;
                let tokens = ["input_tokens", "output_tokens", "cached_input_tokens"]
                    .iter()
                    .map(|field| summary[*field].as_u64().unwrap_or_default())
                    .sum::<u64>();
                let (cost, priced, _) = super::pricing::usage_cost(&summary["usage"], query);
                let calls = summary["tool_counts"].as_object().map(|counts| {
                    counts.values().filter_map(Value::as_u64).sum::<u64>()
                });
                let known_messages = !super::has_activity_range(query)
                    || summary["activity"].is_object();
                json!({
                    "_key": summary["_key"],
                    "title": summary["title"],
                    "cwd": summary["cwd"],
                    "source_kind": summary["source_kind"],
                    "display_source": summary["display_source"],
                    "last_timestamp": timestamp_of(&summary),
                    "tokens": if known_usage || (!super::has_activity_range(query) && tokens > 0) {
                        json!(tokens)
                    } else { Value::Null },
                    "cost": if priced { json!(cost) } else { Value::Null },
                    "message_count": if known_messages {
                        summary["message_count"].clone()
                    } else { Value::Null },
                    "tool_calls": calls,
                    "workspace": {
                        "favorite": summary["workspace"]["favorite"],
                        "tags": summary["workspace"]["tags"],
                        "note": compact(summary["workspace"]["note"].as_str().unwrap_or_default(), 240)
                    }
                })
            })
            .collect::<Vec<_>>();
        let sort = query.get("sort").map(String::as_str).unwrap_or("recent");
        sessions.sort_by(|a, b| {
            let usage_order = match sort {
                "tokens" => b["tokens"].as_u64().cmp(&a["tokens"].as_u64()),
                // 估算成本为 null 的会话排在末尾，与未知用量同口径。
                "cost" => b["cost"]
                    .as_f64()
                    .unwrap_or(f64::NEG_INFINITY)
                    .partial_cmp(&a["cost"].as_f64().unwrap_or(f64::NEG_INFINITY))
                    .unwrap_or(std::cmp::Ordering::Equal),
                _ => std::cmp::Ordering::Equal,
            };
            usage_order
                .then_with(|| timestamp_of(b).cmp(timestamp_of(a)))
                .then_with(|| a["_key"].as_str().cmp(&b["_key"].as_str()))
        });
        let total = sessions.len();
        paginate(sessions, query, json!({ "total": total, "sort": sort }))
    }

    pub fn facets(
        &self,
        query: &HashMap<String, String>,
        workspace: &crate::workspace::WorkspaceSnapshot,
    ) -> Value {
        let mut providers = BTreeSet::new();
        let mut source_kinds = BTreeSet::new();
        let mut dates = BTreeSet::new();
        let mut cwds = BTreeSet::new();
        let mut hidden_reasons = BTreeSet::new();
        for summary in &self.summaries {
            insert_string(&mut providers, &summary["model_provider"]);
            insert_string(&mut source_kinds, &summary["source_kind"]);
            insert_string(&mut cwds, &summary["cwd"]);
            if summary["hidden"].as_bool() == Some(true) {
                insert_string(&mut hidden_reasons, &summary["hidden_reason"]);
            }
            dates.extend(super::activity::dates(summary));
        }
        // 项目计数应用显示开关：隐藏、归档与本地移除的会话默认不计入，
        // 与列表可见口径一致；来源/项目筛选本身不收窄项目计数。
        let display_query = DISPLAY_FLAGS
            .iter()
            .filter_map(|key| {
                query
                    .get(*key)
                    .map(|value| ((*key).to_string(), value.clone()))
            })
            .collect::<HashMap<String, String>>();
        let mut projects: BTreeMap<String, ProjectFacet> = BTreeMap::new();
        let mut source_counts: BTreeMap<String, u64> = BTreeMap::new();
        for summary in self.filtered(&display_query, workspace) {
            if let Some(kind) = summary["source_kind"]
                .as_str()
                .filter(|value| !value.is_empty())
            {
                *source_counts
                    .entry(diagnostic_source_kind(kind).into())
                    .or_insert(0) += 1;
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
                let timestamp = timestamp_of(&summary).to_string();
                if timestamp > project.last_timestamp {
                    project.last_timestamp = timestamp.clone();
                }
                insert_string(&mut project.providers, &summary["model_provider"]);
                insert_string(&mut project.source_kinds, &summary["source_kind"]);
                if let Some(kind) = summary["source_kind"]
                    .as_str()
                    .filter(|value| !value.is_empty())
                {
                    *project.source_counts.entry(kind.into()).or_insert(0) += 1;
                    let last = project
                        .source_last_timestamps
                        .entry(kind.into())
                        .or_default();
                    if timestamp > *last {
                        *last = timestamp;
                    }
                }
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
        // source_counts 与项目计数同口径：只统计当前显示开关下可见的会话。
        json!({ "session_roots": self.session_roots(), "sources": sources, "providers": providers, "source_kinds": source_kinds, "source_counts": source_counts, "dates": date_values, "cwds": cwds, "hidden_reasons": hidden_reasons, "projects": project_values })
    }

    pub fn stats(
        &self,
        query: &HashMap<String, String>,
        workspace: &crate::workspace::WorkspaceSnapshot,
    ) -> Value {
        let mut filtered = self.filtered(query, workspace);
        for summary in &mut filtered {
            super::activity::scope_summary(summary, query);
        }
        let mut by_date: BTreeMap<String, DayUsage> = BTreeMap::new();
        let mut by_agent = HashMap::new();
        let mut by_agent_tokens: HashMap<String, u64> = HashMap::new();
        let mut by_source_kind = HashMap::new();
        let mut by_provider = HashMap::new();
        let mut by_provider_tokens: HashMap<String, u64> = HashMap::new();
        let mut by_cwd = HashMap::new();
        let mut by_tool: HashMap<String, ActivityCount> = HashMap::new();
        let mut by_command: HashMap<String, ActivityCount> = HashMap::new();
        let mut total_events = 0_u64;
        let mut total_messages = 0_u64;
        let mut total_tools = 0_u64;
        let mut total_tool_calls = 0_u64;
        let mut total_input_tokens = 0_u64;
        let mut total_output_tokens = 0_u64;
        let mut total_cached_input_tokens = 0_u64;
        let mut total_cache_read_tokens = 0_u64;
        let mut total_cache_write_tokens = 0_u64;
        let mut cache_eligible_input_tokens = 0_u64;
        let mut usage_sessions = 0_u64;
        let mut tool_sessions = 0_u64;
        let mut undated_tokens = 0_u64;
        let mut total_cost = 0_f64;
        let mut cost_sessions = 0_u64;
        let mut unpriced_tokens = 0_u64;
        for summary in &filtered {
            total_events += summary["event_count"].as_u64().unwrap_or_default();
            total_messages += summary["message_count"].as_u64().unwrap_or_default();
            total_tools += summary["tool_count"].as_u64().unwrap_or_default();
            if let Some(counts) = summary["tool_counts"].as_object() {
                total_tool_calls += counts.values().filter_map(Value::as_u64).sum::<u64>();
            }
            let input = summary["input_tokens"].as_u64().unwrap_or_default();
            let output = summary["output_tokens"].as_u64().unwrap_or_default();
            let cached = summary["cached_input_tokens"].as_u64().unwrap_or_default();
            total_input_tokens += input;
            total_output_tokens += output;
            total_cached_input_tokens += cached;
            let tokens = input + output + cached;
            let usage = &summary["usage"];
            if usage["known"] == true {
                usage_sessions += 1;
                let totals = &usage["totals"];
                total_cache_read_tokens += totals["cache_read"].as_u64().unwrap_or_default();
                total_cache_write_tokens += totals["cache_write"].as_u64().unwrap_or_default();
                cache_eligible_input_tokens += totals["input"].as_u64().unwrap_or_default()
                    + totals["cache_read"].as_u64().unwrap_or_default()
                    + totals["cache_write"].as_u64().unwrap_or_default();
                undated_tokens += usage_total(&usage["undated"]);
                if let Some(days) = usage["by_date"].as_object() {
                    for (date, value) in days {
                        let day = by_date.entry(date.clone()).or_default();
                        day.tokens += usage_total(value);
                        day.cost += super::pricing::date_cost(usage, date);
                    }
                }
                let (cost, priced, unpriced) = super::pricing::usage_cost(usage, query);
                if priced {
                    cost_sessions += 1;
                    total_cost += cost;
                }
                unpriced_tokens += unpriced;
            } else {
                undated_tokens += if super::has_activity_range(query) {
                    summary["_undated_tokens"].as_u64().unwrap_or_default()
                } else {
                    tokens
                };
            }
            if summary["tool_counts"].is_object() {
                tool_sessions += 1;
            }
            for date in super::activity::dates(summary) {
                if super::in_activity_range(&date, query) {
                    by_date.entry(date).or_default().count += 1;
                }
            }
            if let Some(agent) = agent_kind(&summary["source_kind"]) {
                *by_agent.entry(agent.into()).or_default() += 1;
                // 不支持 token 统计的来源不进入 Token 维度,避免出现 0 占比扇区。
                if tokens > 0 {
                    *by_agent_tokens.entry(agent.into()).or_default() += tokens;
                }
            }
            increment(&mut by_source_kind, &summary["source_kind"]);
            increment(&mut by_provider, &summary["model_provider"]);
            // Provider 同口径提供 token 维度,无 token 统计的条目不进入。
            if tokens > 0
                && let Some(provider) = summary["model_provider"]
                    .as_str()
                    .filter(|value| !value.is_empty())
            {
                *by_provider_tokens.entry(provider.into()).or_default() += tokens;
            }
            increment(&mut by_cwd, &summary["cwd"]);
            // 按名统计来自摘要的 tool_counts/command_counts；
            // 旧缓存或无该字段的来源自然跳过。
            for (target, field, last_field) in [
                (&mut by_tool, "tool_counts", "tool_last_used"),
                (&mut by_command, "command_counts", "command_last_used"),
            ] {
                if let Some(counts) = summary[field].as_object() {
                    for (name, count) in counts {
                        let count = count.as_u64().unwrap_or_default();
                        if count == 0 {
                            continue;
                        }
                        let activity = target.entry(name.clone()).or_default();
                        activity.count += count;
                        activity.session_count += 1;
                        let timestamp = summary[last_field][name].as_str().unwrap_or_default();
                        if timestamp > activity.last_timestamp.as_str() {
                            activity.last_timestamp = timestamp.to_string();
                        }
                    }
                }
            }
        }
        let active_days = by_date.values().filter(|day| day.count > 0).count();
        json!({
            "total": filtered.len(),
            "total_events": if super::has_activity_range(query) { Value::Null } else { json!(total_events) },
            "total_messages": total_messages,
            "total_tools": total_tools,
            "total_tool_calls": total_tool_calls,
            "range": { "start": query.get("activity_from"), "end": query.get("activity_to") },
            "total_input_tokens": total_input_tokens,
            "total_output_tokens": total_output_tokens,
            "total_cached_input_tokens": total_cached_input_tokens,
            "total_cache_read_tokens": total_cache_read_tokens,
            "total_cache_write_tokens": total_cache_write_tokens,
            "cache_eligible_input_tokens": cache_eligible_input_tokens,
            "usage_sessions": usage_sessions,
            "tool_sessions": tool_sessions,
            "undated_tokens": undated_tokens,
            "total_cost": if cost_sessions > 0 { json!(total_cost) } else { Value::Null },
            "cost_sessions": cost_sessions,
            "unpriced_tokens": unpriced_tokens,
            "project_review": query.get("cwd").filter(|cwd| !cwd.is_empty()).map(|cwd| project_review(&filtered, cwd)),
            "total_tokens": total_input_tokens + total_output_tokens + total_cached_input_tokens,
            "active_days": active_days,
            "avg_daily": if active_days == 0 { "0".into() } else { format!("{:.1}", filtered.len() as f64 / active_days as f64) },
            "by_date": by_date.into_iter().map(|(label, day)| json!({ "label": label, "count": day.count, "tokens": day.tokens, "cost": day.cost })).collect::<Vec<_>>(),
            "by_agent": count_values(by_agent, usize::MAX),
            "by_agent_tokens": count_values(by_agent_tokens, usize::MAX),
            "by_source_kind": count_values(by_source_kind, usize::MAX),
            "by_provider": count_values(by_provider, usize::MAX),
            "by_provider_tokens": count_values(by_provider_tokens, usize::MAX),
            "by_cwd": count_values(by_cwd, 16),
            "by_tool": activity_values(by_tool, 32),
            "by_command": activity_values(by_command, 16)
        })
    }

    pub(crate) fn filtered(
        &self,
        query: &HashMap<String, String>,
        workspace: &crate::workspace::WorkspaceSnapshot,
    ) -> Vec<Value> {
        self.summaries
            .iter()
            .cloned()
            .map(|mut summary| {
                workspace.decorate_summary(&mut summary);
                summary
            })
            .filter(|summary| matches_filters(summary, query))
            .collect()
    }
    /// 托盘「最近会话」按默认可见口径取前 N 条；惰性过滤取够即停，
    /// 不需要像 filtered 那样收集全量结果。
    pub(crate) fn recent_summaries(
        &self,
        limit: usize,
        workspace: &crate::workspace::WorkspaceSnapshot,
    ) -> Vec<Value> {
        self.visible_summaries(limit, &HashMap::new(), workspace)
    }

    /// 托盘「收藏会话」：默认可见口径加收藏标记，按最近活动取前 N 条。
    pub(crate) fn favorite_summaries(
        &self,
        limit: usize,
        workspace: &crate::workspace::WorkspaceSnapshot,
    ) -> Vec<Value> {
        self.visible_summaries(
            limit,
            &HashMap::from([("favorite".to_string(), "true".to_string())]),
            workspace,
        )
    }

    fn visible_summaries(
        &self,
        limit: usize,
        query: &HashMap<String, String>,
        workspace: &crate::workspace::WorkspaceSnapshot,
    ) -> Vec<Value> {
        self.summaries
            .iter()
            .cloned()
            .map(|mut summary| {
                workspace.decorate_summary(&mut summary);
                summary
            })
            .filter(|summary| matches_filters(summary, query))
            .take(limit)
            .collect()
    }

    pub(crate) fn session_roots(&self) -> Vec<String> {
        self.sources
            .iter()
            .filter(|source| source.root.exists())
            .map(|source| source.root.to_string_lossy().into_owned())
            .collect()
    }
}

fn usage_total(value: &Value) -> u64 {
    ["input", "output", "cache_read", "cache_write"]
        .iter()
        .map(|field| value[*field].as_u64().unwrap_or_default())
        .sum()
}

#[derive(Default)]
struct ActivityCount {
    count: u64,
    session_count: u64,
    last_timestamp: String,
}

fn project_review(summaries: &[Value], cwd: &str) -> Value {
    let mut recent = summaries.iter().collect::<Vec<_>>();
    recent.sort_by(|a, b| {
        timestamp_of(b)
            .cmp(timestamp_of(a))
            .then_with(|| a["_key"].as_str().cmp(&b["_key"].as_str()))
    });
    let entry = |summary: &&Value| {
        json!({
            "key": summary["_key"], "title": summary["title"],
            "source": summary["display_source"], "timestamp": timestamp_of(summary),
            "favorite": summary["workspace"]["favorite"],
            "tags": summary["workspace"]["tags"],
            "note": super::helpers::compact(summary["workspace"]["note"].as_str().unwrap_or_default(), 240)
        })
    };
    let saved = recent
        .iter()
        .copied()
        .filter(|summary| {
            summary["workspace"]["favorite"] == true
                || summary["workspace"]["note"]
                    .as_str()
                    .is_some_and(|note| !note.is_empty())
                || summary["workspace"]["tags"]
                    .as_array()
                    .is_some_and(|tags| !tags.is_empty())
        })
        .take(8)
        .map(|summary| entry(&summary))
        .collect::<Vec<_>>();
    json!({ "cwd": cwd, "recent": recent.iter().take(8).map(entry).collect::<Vec<_>>(), "saved": saved })
}

fn activity_values(counts: HashMap<String, ActivityCount>, limit: usize) -> Vec<Value> {
    let mut values = counts.into_iter().collect::<Vec<_>>();
    values.sort_by(|a, b| b.1.count.cmp(&a.1.count).then_with(|| a.0.cmp(&b.0)));
    values.truncate(limit);
    values
        .into_iter()
        .map(|(label, item)| {
            json!({
                "label": label, "count": item.count,
                "session_count": item.session_count, "last_timestamp": item.last_timestamp
            })
        })
        .collect()
}

#[derive(Default)]
struct ProjectFacet {
    name: String,
    path: String,
    count: u64,
    last_timestamp: String,
    providers: BTreeSet<String>,
    source_kinds: BTreeSet<String>,
    source_counts: BTreeMap<String, u64>,
    source_last_timestamps: BTreeMap<String, String>,
}

/// 按日聚合的会话数、token 用量（input + output + cached）与估算成本（美元）。
#[derive(Default)]
struct DayUsage {
    count: u64,
    tokens: u64,
    cost: f64,
}
impl ProjectFacet {
    fn value(self) -> Value {
        json!({ "name": self.name, "path": self.path, "count": self.count, "last_timestamp": self.last_timestamp, "providers": self.providers, "source_kinds": self.source_kinds, "source_counts": self.source_counts, "source_last_timestamps": self.source_last_timestamps })
    }
}
