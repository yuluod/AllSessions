//! 可重建的用量账本，保留缓存读写和逐日归属，缺失日期的用量单独呈现。
use std::collections::{BTreeMap, VecDeque};

use serde::{Deserialize, Serialize};

use super::helpers::local_date_key;

const MAX_USAGE_DAYS: usize = 4096;
const MAX_USAGE_EVENTS: usize = 300;

#[derive(Clone, Copy, Default, Serialize, Deserialize)]
pub(super) struct TokenUsage {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

impl TokenUsage {
    pub(super) fn add(&mut self, other: Self) {
        self.input += other.input;
        self.output += other.output;
        self.cache_read += other.cache_read;
        self.cache_write += other.cache_write;
    }
    pub(super) fn sum(&self) -> u64 {
        self.input + self.output + self.cache_read + self.cache_write
    }
}

/// 单个模型的用量分布：总量 + 逐日归属，用于成本估算的按模型计价。
#[derive(Clone, Default, Serialize, Deserialize)]
pub(super) struct ModelUsage {
    pub totals: TokenUsage,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub by_date: BTreeMap<String, TokenUsage>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 事件明细有界且不进入摘要序列化() {
        let mut ledger = UsageLedger::default();
        for _ in 0..350 {
            ledger.record(
                "2026-09-01",
                TokenUsage {
                    input: 10,
                    ..Default::default()
                },
                "claude-sonnet-4-5",
            );
        }
        ledger.record(
            "invalid timestamp",
            TokenUsage {
                input: 7,
                ..Default::default()
            },
            "",
        );
        assert_eq!(ledger.events.len(), MAX_USAGE_EVENTS);
        assert_eq!(ledger.event_count, 350);
        assert_eq!(ledger.undated.input, 7);
        let serialized = serde_json::to_value(&ledger).unwrap();
        assert!(serialized.get("events").is_none());
        assert_eq!(serialized["totals"]["input"], 3507);
    }

    #[test]
    fn 跨日合并保留缓存读写与无日期用量() {
        let mut ledger = UsageLedger::default();
        ledger.record(
            "2026-09-01",
            TokenUsage {
                input: 10,
                cache_read: 30,
                cache_write: 5,
                output: 2,
            },
            "claude-sonnet-4-5",
        );
        let mut other = UsageLedger::default();
        other.record(
            "2026-09-02",
            TokenUsage {
                input: 20,
                ..Default::default()
            },
            "gpt-5",
        );
        other.record(
            "",
            TokenUsage {
                output: 7,
                ..Default::default()
            },
            "",
        );
        ledger.merge(other);
        assert_eq!(ledger.totals.input, 30);
        assert_eq!(ledger.totals.cache_read, 30);
        assert_eq!(ledger.totals.cache_write, 5);
        assert_eq!(ledger.by_date.len(), 2);
        assert_eq!(ledger.undated.output, 7);
        assert_eq!(ledger.by_model.len(), 3);
        assert_eq!(ledger.by_model["claude-sonnet-4-5"].totals.input, 10);
        assert_eq!(ledger.by_model["gpt-5"].by_date["2026-09-02"].input, 20);
        assert_eq!(ledger.by_model[""].totals.output, 7);
        assert!(ledger.by_model[""].by_date.is_empty());
    }

    #[test]
    fn 日期超过上限后保留未分配总量() {
        let mut ledger = UsageLedger::default();
        for day in 0..MAX_USAGE_DAYS {
            ledger
                .by_date
                .insert(format!("date-{day}"), TokenUsage::default());
        }
        ledger.record(
            "2026-09-01",
            TokenUsage {
                input: 11,
                ..Default::default()
            },
            "",
        );
        assert_eq!(ledger.by_date.len(), MAX_USAGE_DAYS);
        assert_eq!(ledger.undated.input, 11);
        assert_eq!(ledger.totals.input, 11);
    }
}

#[derive(Default, Serialize, Deserialize)]
pub(super) struct UsageLedger {
    pub known: bool,
    pub totals: TokenUsage,
    pub by_date: BTreeMap<String, TokenUsage>,
    pub undated: TokenUsage,
    /// 按模型拆分的用量，供查询侧价格表估算成本；空串键表示未能归属模型的
    /// 用量，计价时计入未估算部分。
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub by_model: BTreeMap<String, ModelUsage>,
    // 明细仅随会话详情返回，不进入摘要缓存及列表。
    #[serde(skip)]
    pub events: VecDeque<UsageEvent>,
    #[serde(skip)]
    pub event_count: usize,
}

#[derive(Serialize)]
pub(super) struct UsageEvent {
    timestamp: String,
    usage: TokenUsage,
}

impl UsageLedger {
    /// 记录一次用量事件；`model` 为该次用量归属的模型名，未知传空串。
    pub fn record(&mut self, timestamp: &str, usage: TokenUsage, model: &str) {
        self.known = true;
        self.totals.add(usage);
        let date = local_date_key(timestamp)
            .filter(|value| chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").is_ok());
        if date.is_some()
            && timestamp.len() <= 64
            && [
                usage.input,
                usage.output,
                usage.cache_read,
                usage.cache_write,
            ]
            .iter()
            .any(|value| *value > 0)
        {
            self.event_count += 1;
            if self.events.len() == MAX_USAGE_EVENTS {
                self.events.pop_front();
            }
            self.events.push_back(UsageEvent {
                timestamp: timestamp.to_string(),
                usage,
            });
        }
        // 超长历史保留总量，超出日期上限的部分归入未分配用量。
        if let Some(date) = &date
            && (self.by_date.len() < MAX_USAGE_DAYS || self.by_date.contains_key(date))
        {
            self.by_date.entry(date.clone()).or_default().add(usage);
        } else {
            self.undated.add(usage);
        }
        let entry = self.by_model.entry(model.to_string()).or_default();
        entry.totals.add(usage);
        if let Some(date) = &date
            && (entry.by_date.len() < MAX_USAGE_DAYS || entry.by_date.contains_key(date))
        {
            entry.by_date.entry(date.clone()).or_default().add(usage);
        }
    }

    pub fn merge(&mut self, other: Self) {
        if !other.known {
            return;
        }
        self.known = true;
        self.totals.add(other.totals);
        self.undated.add(other.undated);
        for (date, usage) in other.by_date {
            if self.by_date.len() < MAX_USAGE_DAYS || self.by_date.contains_key(&date) {
                self.by_date.entry(date).or_default().add(usage);
            } else {
                self.undated.add(usage);
            }
        }
        for (model, entry) in other.by_model {
            let target = self.by_model.entry(model).or_default();
            target.totals.add(entry.totals);
            for (date, usage) in entry.by_date {
                if target.by_date.len() < MAX_USAGE_DAYS || target.by_date.contains_key(&date) {
                    target.by_date.entry(date).or_default().add(usage);
                }
            }
        }
        self.event_count += other.event_count;
        self.events.extend(other.events);
        while self.events.len() > MAX_USAGE_EVENTS {
            self.events.pop_front();
        }
    }
}
