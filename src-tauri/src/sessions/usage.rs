//! 可重建的用量账本，保留缓存读写和逐日归属，缺失日期的用量单独呈现。
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::helpers::local_date_key;

const MAX_USAGE_DAYS: usize = 4096;

#[derive(Clone, Copy, Default, Serialize, Deserialize)]
pub(super) struct TokenUsage {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

impl TokenUsage {
    fn add(&mut self, other: Self) {
        self.input += other.input;
        self.output += other.output;
        self.cache_read += other.cache_read;
        self.cache_write += other.cache_write;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        );
        let mut other = UsageLedger::default();
        other.record(
            "2026-09-02",
            TokenUsage {
                input: 20,
                ..Default::default()
            },
        );
        other.record(
            "",
            TokenUsage {
                output: 7,
                ..Default::default()
            },
        );
        ledger.merge(other);
        assert_eq!(ledger.totals.input, 30);
        assert_eq!(ledger.totals.cache_read, 30);
        assert_eq!(ledger.totals.cache_write, 5);
        assert_eq!(ledger.by_date.len(), 2);
        assert_eq!(ledger.undated.output, 7);
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
}

impl UsageLedger {
    pub fn record(&mut self, timestamp: &str, usage: TokenUsage) {
        self.known = true;
        self.totals.add(usage);
        // 超长历史保留总量，超出日期上限的部分归入未分配用量。
        if let Some(date) = local_date_key(timestamp)
            && (self.by_date.len() < MAX_USAGE_DAYS || self.by_date.contains_key(&date))
        {
            self.by_date.entry(date).or_default().add(usage);
        } else {
            self.undated.add(usage);
        }
    }

    pub fn merge(&mut self, other: Self) {
        if !other.known {
            return;
        }
        for (date, usage) in other.by_date {
            self.record(&date, usage);
        }
        self.record("", other.undated);
    }
}
