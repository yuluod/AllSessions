//! 内置模型价格表与用量账本的成本估算。
//! 价目是公开牌价的近似值（美元 / 百万 token），随版本更新，只用于估算展示；
//! 未识别模型的用量不计入成本，并汇总为未计价 token 供界面提示覆盖率。
use std::collections::HashMap;

use serde_json::Value;

use super::activity::{has_range, in_range};
use super::usage::TokenUsage;

struct ModelPrice {
    input: f64,
    output: f64,
    cache_read: f64,
    cache_write: f64,
}

impl ModelPrice {
    const fn new(input: f64, output: f64, cache_read: f64, cache_write: f64) -> Self {
        Self {
            input,
            output,
            cache_read,
            cache_write,
        }
    }

    fn cost(&self, usage: TokenUsage) -> f64 {
        (usage.input as f64 * self.input
            + usage.output as f64 * self.output
            + usage.cache_read as f64 * self.cache_read
            + usage.cache_write as f64 * self.cache_write)
            / 1_000_000.0
    }
}

// 模型名前缀 →（输入, 输出, 缓存读, 缓存写）美元 / 百万 token。
// 记录里常见的日期（-20250929）、区域（us.anthropic.）与路由后缀在归一化后
// 仍能命中前缀；同名家族按最长前缀优先（如 gpt-5.1-codex-mini 先于 gpt-5.1）。
const PRICES: &[(&str, ModelPrice)] = &[
    // Anthropic（Claude Code、Claude Cowork、Pi、ZCode 等转发 Claude 的来源）
    ("claude-opus-4-5", ModelPrice::new(5.0, 25.0, 0.5, 6.25)),
    ("claude-opus-4-1", ModelPrice::new(15.0, 75.0, 1.5, 18.75)),
    ("claude-opus-4", ModelPrice::new(15.0, 75.0, 1.5, 18.75)),
    ("claude-sonnet-4-5", ModelPrice::new(3.0, 15.0, 0.3, 3.75)),
    ("claude-sonnet-4", ModelPrice::new(3.0, 15.0, 0.3, 3.75)),
    ("claude-3-7-sonnet", ModelPrice::new(3.0, 15.0, 0.3, 3.75)),
    ("claude-3-5-sonnet", ModelPrice::new(3.0, 15.0, 0.3, 3.75)),
    ("claude-haiku-4-5", ModelPrice::new(1.0, 5.0, 0.1, 1.25)),
    ("claude-3-5-haiku", ModelPrice::new(0.8, 4.0, 0.08, 1.0)),
    ("claude-3-opus", ModelPrice::new(15.0, 75.0, 1.5, 18.75)),
    ("claude-3-haiku", ModelPrice::new(0.25, 1.25, 0.03, 0.3)),
    // OpenAI（Codex）
    ("gpt-5.1-codex-mini", ModelPrice::new(0.25, 2.0, 0.025, 0.0)),
    ("gpt-5.1-codex-max", ModelPrice::new(1.25, 10.0, 0.125, 0.0)),
    ("gpt-5.1-codex", ModelPrice::new(1.25, 10.0, 0.125, 0.0)),
    ("gpt-5.1", ModelPrice::new(1.25, 10.0, 0.125, 0.0)),
    ("gpt-5-codex", ModelPrice::new(1.25, 10.0, 0.125, 0.0)),
    ("gpt-5", ModelPrice::new(1.25, 10.0, 0.125, 0.0)),
    ("codex-mini", ModelPrice::new(1.5, 6.0, 0.375, 0.0)),
    ("o4-mini", ModelPrice::new(1.1, 4.4, 0.275, 0.0)),
    ("o3", ModelPrice::new(2.0, 8.0, 0.5, 0.0)),
    // Google（Gemini CLI chats）
    ("gemini-3-pro", ModelPrice::new(2.0, 12.0, 0.2, 0.0)),
    ("gemini-2.5-pro", ModelPrice::new(1.25, 10.0, 0.31, 0.0)),
    (
        "gemini-2.5-flash-lite",
        ModelPrice::new(0.1, 0.4, 0.025, 0.0),
    ),
    ("gemini-2.5-flash", ModelPrice::new(0.3, 2.5, 0.075, 0.0)),
    ("gemini-2.0-flash", ModelPrice::new(0.1, 0.4, 0.025, 0.0)),
    // DeepSeek（DeepSeek Harness）
    ("deepseek-reasoner", ModelPrice::new(0.55, 2.19, 0.14, 0.0)),
    ("deepseek-chat", ModelPrice::new(0.27, 1.1, 0.07, 0.0)),
    // 智谱 GLM（ZCode、Kimi 等常见编码模型）
    ("glm-4.6", ModelPrice::new(0.6, 2.2, 0.11, 0.0)),
    ("glm-4.5-air", ModelPrice::new(0.2, 1.1, 0.04, 0.0)),
    ("glm-4.5", ModelPrice::new(0.6, 2.2, 0.11, 0.0)),
    ("kimi-k2", ModelPrice::new(0.6, 2.5, 0.15, 0.0)),
];

/// 去掉 provider 前缀后小写化，便于前缀比对：
/// - `anthropic/claude-sonnet-4-5` 形式按 `/` 取末段；
/// - `us.anthropic.claude-...` 区域前缀按 `.` 取末段，但 `gpt-5.1` 这类
///   版本号带点号的名称不受影响（末段以数字开头时保留原名）。
fn normalize_model(model: &str) -> String {
    let tail = model.trim().rsplit('/').next().unwrap_or_default().trim();
    let tail = match tail.rsplit_once('.') {
        Some((_, last)) if !last.as_bytes().first().is_some_and(u8::is_ascii_digit) => last,
        _ => tail,
    };
    tail.to_lowercase()
}

/// 命中最长前缀；`claude-sonnet-4-5-20250929` 这类带日期后缀的名字也能归到
/// `claude-sonnet-4-5`，未知名称返回 None（对应用量记为未计价）。
fn price_for(model: &str) -> Option<&'static ModelPrice> {
    let normalized = normalize_model(model);
    if normalized.is_empty() {
        return None;
    }
    PRICES
        .iter()
        .filter(|(prefix, _)| {
            normalized == *prefix || normalized.starts_with(&format!("{prefix}-"))
        })
        .max_by_key(|(prefix, _)| prefix.len())
        .map(|(_, price)| price)
}

fn tokens(value: &Value) -> TokenUsage {
    TokenUsage {
        input: value["input"].as_u64().unwrap_or_default(),
        output: value["output"].as_u64().unwrap_or_default(),
        cache_read: value["cache_read"].as_u64().unwrap_or_default(),
        cache_write: value["cache_write"].as_u64().unwrap_or_default(),
    }
}

/// 汇总序列化 usage 账本的估算成本。
/// 返回（美元成本, 是否有可计价模型, 未计价 token）。query 带活动范围时按
/// 各模型逐日用量中落在范围内的部分计；无范围时按模型总量（含无日期部分）。
pub(crate) fn usage_cost(usage: &Value, query: &HashMap<String, String>) -> (f64, bool, u64) {
    let mut cost = 0.0;
    let mut priced = false;
    let mut unpriced = 0_u64;
    let scoped = has_range(query);
    let Some(models) = usage["by_model"].as_object() else {
        return (0.0, false, 0);
    };
    for (model, entry) in models {
        let mut bucket = TokenUsage::default();
        if scoped {
            if let Some(days) = entry["by_date"].as_object() {
                for (date, value) in days {
                    if in_range(date, query) {
                        bucket.add(tokens(value));
                    }
                }
            }
        } else {
            bucket = tokens(&entry["totals"]);
        }
        match price_for(model) {
            Some(price) => {
                priced = true;
                cost += price.cost(bucket);
            }
            None => unpriced += bucket.sum(),
        }
    }
    (cost, priced, unpriced)
}

/// 某一天在账本里的估算成本：各模型当日用量按各自价目相加。
pub(crate) fn date_cost(usage: &Value, date: &str) -> f64 {
    let Some(models) = usage["by_model"].as_object() else {
        return 0.0;
    };
    models
        .iter()
        .filter_map(|(model, entry)| {
            price_for(model).map(|price| price.cost(tokens(&entry["by_date"][date])))
        })
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn 模型名归一化覆盖日期后缀与provider前缀() {
        for (name, prefix_hit) in [
            ("claude-sonnet-4-5-20250929", true),
            ("Claude-Sonnet-4-5", true),
            ("anthropic/claude-sonnet-4-5", true),
            ("us.anthropic.claude-sonnet-4-5-20250929-v1:0", true),
            ("claude-sonnet-4-5-other", true),
            ("not-a-model", false),
            ("", false),
        ] {
            assert_eq!(price_for(name).is_some(), prefix_hit, "{name}");
        }
    }

    #[test]
    fn 最长前缀优先匹配细分型号() {
        // gpt-5.1-codex-mini 应命中自身价目而非 gpt-5.1 的。
        let mini = price_for("gpt-5.1-codex-mini").unwrap();
        assert_eq!(mini.input, 0.25);
        let base = price_for("gpt-5.1-codex").unwrap();
        assert_eq!(base.input, 1.25);
        // 版本号带点号的模型名不被 '.' 归一化截断。
        assert!(price_for("gpt-5.1").is_some());
    }

    #[test]
    fn 成本按模型分别计价并统计未计价部分() {
        let usage = json!({
            "by_model": {
                "claude-sonnet-4-5-20250929": {
                    "totals": {"input": 1_000_000, "output": 100_000, "cache_read": 0, "cache_write": 0},
                    "by_date": {
                        "2026-09-01": {"input": 600_000, "output": 60_000, "cache_read": 0, "cache_write": 0},
                        "2026-09-02": {"input": 400_000, "output": 40_000, "cache_read": 0, "cache_write": 0}
                    }
                },
                "custom-local": {
                    "totals": {"input": 500, "output": 50, "cache_read": 0, "cache_write": 0}
                }
            }
        });
        let (cost, priced, unpriced) = usage_cost(&usage, &HashMap::new());
        assert!(priced);
        // 1M 输入 * 3 + 100k 输出 * 15 = 3 + 1.5 美元。
        assert!((cost - 4.5).abs() < 1e-9);
        assert_eq!(unpriced, 550);
        // 范围内只算 9-01 当日用量。
        let query = HashMap::from([
            ("activity_from".to_string(), "2026-09-01".to_string()),
            ("activity_to".to_string(), "2026-09-01".to_string()),
        ]);
        let (cost, priced, _) = usage_cost(&usage, &query);
        assert!(priced);
        // 600k * 3 + 60k * 15 = 1.8 + 0.9 美元。
        assert!((cost - 2.7).abs() < 1e-9);
        assert!((date_cost(&usage, "2026-09-02") - 1.8).abs() < 1e-9);
        assert_eq!(date_cost(&usage, "2026-09-03"), 0.0);
    }
}
