//! 逐日活动摘要，为跨天会话和调用排行提供统一的时间范围口径。
use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use serde_json::json;

use super::helpers::{local_date_key, timestamp_of};
use super::parse::{is_tool_call, tool_call_command};
use super::usage::TokenUsage;

const MAX_ACTIVITY_DAYS: usize = 4096;

#[derive(Default, Serialize, Deserialize)]
pub(super) struct CallCount {
    pub count: u64,
    pub last_timestamp: String,
}

#[derive(Default, Serialize, Deserialize)]
pub(super) struct ActivityDay {
    pub messages: u64,
    pub tool_calls: u64,
    pub tools: BTreeMap<String, CallCount>,
    pub commands: BTreeMap<String, CallCount>,
}

impl ActivityDay {
    fn merge(&mut self, other: Self) {
        self.messages += other.messages;
        self.tool_calls += other.tool_calls;
        for (target, counts) in [
            (&mut self.tools, other.tools),
            (&mut self.commands, other.commands),
        ] {
            for (name, count) in counts {
                let current = target.entry(name).or_default();
                current.count += count.count;
                current.last_timestamp = current.last_timestamp.clone().max(count.last_timestamp);
            }
        }
    }
}

#[derive(Default, Serialize, Deserialize)]
pub(super) struct ActivityLedger {
    pub by_date: BTreeMap<String, ActivityDay>,
    pub undated: ActivityDay,
}

impl ActivityLedger {
    pub fn record(&mut self, message: &Value) {
        let timestamp = message["timestamp"].as_str().unwrap_or_default();
        let day = if let Some(date) = local_date_key(timestamp)
            && chrono::NaiveDate::parse_from_str(&date, "%Y-%m-%d").is_ok()
            && (self.by_date.len() < MAX_ACTIVITY_DAYS || self.by_date.contains_key(&date))
        {
            self.by_date.entry(date).or_default()
        } else {
            &mut self.undated
        };
        day.messages += 1;
        if !is_tool_call(message) {
            return;
        }
        day.tool_calls += 1;
        for (target, name) in [
            (
                &mut day.tools,
                message["tool_name"].as_str().map(str::to_lowercase),
            ),
            (&mut day.commands, tool_call_command(message)),
        ] {
            if let Some(name) = name.filter(|value| !value.is_empty()) {
                let count = target.entry(name).or_default();
                count.count += 1;
                if timestamp > count.last_timestamp.as_str() {
                    count.last_timestamp = timestamp.into();
                }
            }
        }
    }

    pub fn merge(&mut self, other: Self) {
        self.undated.merge(other.undated);
        for (date, day) in other.by_date {
            if self.by_date.len() < MAX_ACTIVITY_DAYS || self.by_date.contains_key(&date) {
                self.by_date.entry(date).or_default().merge(day);
            } else {
                self.undated.merge(day);
            }
        }
    }
}

pub(crate) fn has_range(query: &HashMap<String, String>) -> bool {
    ["activity_from", "activity_to"]
        .iter()
        .any(|field| query.get(*field).is_some_and(|value| !value.is_empty()))
}

pub(crate) fn in_range(date: &str, query: &HashMap<String, String>) -> bool {
    query
        .get("activity_from")
        .filter(|value| !value.is_empty())
        .is_none_or(|start| date >= start.as_str())
        && query
            .get("activity_to")
            .filter(|value| !value.is_empty())
            .is_none_or(|end| date <= end.as_str())
}

pub(crate) fn validate_range(query: &HashMap<String, String>) -> Result<(), String> {
    for field in ["activity_from", "activity_to"] {
        if let Some(value) = query.get(field).filter(|value| !value.is_empty())
            && (value.len() != 10 || chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").is_err())
        {
            return Err("活动日期范围无效".into());
        }
    }
    if let (Some(start), Some(end)) = (query.get("activity_from"), query.get("activity_to"))
        && !start.is_empty()
        && !end.is_empty()
        && start > end
    {
        return Err("活动开始日期不能晚于结束日期".into());
    }
    Ok(())
}

pub(super) fn dates(summary: &Value) -> BTreeSet<String> {
    let mut dates = BTreeSet::new();
    for ledger in ["activity", "usage"] {
        if let Some(days) = summary[ledger]["by_date"].as_object() {
            dates.extend(days.keys().cloned());
        }
    }
    if (dates.is_empty() || !summary["activity"]["by_date"].is_object())
        && let Some(date) = local_date_key(timestamp_of(summary))
    {
        dates.insert(date);
    }
    dates
}

pub(super) fn scoped_usage(summary: &Value, query: &HashMap<String, String>) -> Option<TokenUsage> {
    let usage = &summary["usage"];
    if usage["known"] != true {
        return None;
    }
    let mut totals = TokenUsage::default();
    if !has_range(query) {
        return Some(tokens(&usage["totals"]));
    }
    let mut known = false;
    if let Some(days) = usage["by_date"].as_object() {
        for (date, value) in days {
            if in_range(date, query) {
                totals.add(tokens(value));
                known = true;
            }
        }
    }
    known.then_some(totals)
}

fn tokens(value: &Value) -> TokenUsage {
    TokenUsage {
        input: value["input"].as_u64().unwrap_or_default(),
        output: value["output"].as_u64().unwrap_or_default(),
        cache_read: value["cache_read"].as_u64().unwrap_or_default(),
        cache_write: value["cache_write"].as_u64().unwrap_or_default(),
    }
}

pub(super) fn scope_summary(summary: &mut Value, query: &HashMap<String, String>) {
    if !has_range(query) {
        return;
    }
    let unknown = tokens(&summary["usage"]["undated"]);
    summary["_undated_tokens"] =
        json!(unknown.input + unknown.output + unknown.cache_read + unknown.cache_write);
    let usage = scoped_usage(summary, query);
    let totals = usage.unwrap_or_default();
    summary["input_tokens"] = json!(totals.input);
    summary["output_tokens"] = json!(totals.output);
    summary["cached_input_tokens"] = json!(totals.cache_read + totals.cache_write);
    if summary["usage"].is_object() {
        summary["usage"]["known"] = json!(usage.is_some());
        summary["usage"]["totals"] = json!(totals);
        if let Some(days) = summary["usage"]["by_date"].as_object_mut() {
            days.retain(|date, _| in_range(date, query));
        }
    }
    let mut messages = 0;
    let mut calls = 0;
    let mut tools = BTreeMap::<String, u64>::new();
    let mut commands = BTreeMap::<String, u64>::new();
    let mut tool_times = BTreeMap::<String, String>::new();
    let mut command_times = BTreeMap::<String, String>::new();
    if let Some(days) = summary["activity"]["by_date"].as_object() {
        for (date, day) in days {
            if !in_range(date, query) {
                continue;
            }
            messages += day["messages"].as_u64().unwrap_or_default();
            calls += day["tool_calls"].as_u64().unwrap_or_default();
            for (counts, times, field) in [
                (&mut tools, &mut tool_times, "tools"),
                (&mut commands, &mut command_times, "commands"),
            ] {
                if let Some(values) = day[field].as_object() {
                    for (name, value) in values {
                        *counts.entry(name.clone()).or_default() +=
                            value["count"].as_u64().unwrap_or_default();
                        let timestamp = value["last_timestamp"].as_str().unwrap_or_default();
                        let latest = times.entry(name.clone()).or_default();
                        if timestamp > latest.as_str() {
                            *latest = timestamp.into();
                        }
                    }
                }
            }
        }
        summary["tool_counts"] = json!(tools);
        summary["command_counts"] = json!(commands);
        summary["tool_last_used"] = json!(tool_times);
        summary["command_last_used"] = json!(command_times);
    } else {
        summary["tool_counts"] = Value::Null;
        summary["command_counts"] = Value::Null;
    }
    summary["message_count"] = json!(messages);
    summary["tool_count"] = json!(calls);
}
