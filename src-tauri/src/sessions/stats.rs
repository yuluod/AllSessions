//! 聚合视图:筛选项(facets)、按 Agent/日期/来源统计与项目维度归并。
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;

use serde_json::{json, Value};

use super::helpers::{
    agent_kind, count_values, increment, insert_string, local_date_key, matches_filters,
    timestamp_of,
};
use super::SessionStore;

impl SessionStore {
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

    pub fn stats(
        &self,
        query: &HashMap<String, String>,
        workspace: &crate::workspace::WorkspaceSnapshot,
    ) -> Value {
        let filtered = self.filtered(query, workspace);
        let mut by_date = BTreeMap::new();
        let mut by_agent = HashMap::new();
        let mut by_source_kind = HashMap::new();
        let mut by_provider = HashMap::new();
        let mut by_cwd = HashMap::new();
        let mut total_events = 0_u64;
        let mut total_messages = 0_u64;
        let mut total_tools = 0_u64;
        for summary in &filtered {
            total_events += summary["event_count"].as_u64().unwrap_or_default();
            total_messages += summary["message_count"].as_u64().unwrap_or_default();
            total_tools += summary["tool_count"].as_u64().unwrap_or_default();
            if let Some(date) = local_date_key(timestamp_of(summary)) {
                *by_date.entry(date).or_insert(0_u64) += 1;
            }
            if let Some(agent) = agent_kind(&summary["source_kind"]) {
                *by_agent.entry(agent.into()).or_default() += 1;
            }
            increment(&mut by_source_kind, &summary["source_kind"]);
            increment(&mut by_provider, &summary["model_provider"]);
            increment(&mut by_cwd, &summary["cwd"]);
        }
        let active_days = by_date.len();
        json!({ "total": filtered.len(), "total_events": total_events, "total_messages": total_messages, "total_tools": total_tools, "active_days": active_days, "avg_daily": if active_days == 0 { "0".into() } else { format!("{:.1}", filtered.len() as f64 / active_days as f64) }, "by_date": by_date.into_iter().map(|(label, count)| json!({ "label": label, "count": count })).collect::<Vec<_>>(), "by_agent": count_values(by_agent, usize::MAX), "by_source_kind": count_values(by_source_kind, usize::MAX), "by_provider": count_values(by_provider, usize::MAX), "by_cwd": count_values(by_cwd, 16) })
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
    pub(crate) fn session_roots(&self) -> Vec<String> {
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
