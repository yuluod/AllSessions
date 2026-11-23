use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use serde_json::Value;

const MAX_RULES: usize = 12;
const MAX_PATTERN_BYTES: usize = 512;
const MAX_TEST_BYTES: usize = 32 * 1024;
const MAX_EXPORT_BYTES: usize = 128 * 1024 * 1024;
const MAX_SCAN_BYTES_PER_VALUE: usize = 256 * 1024 * 1024;
const REPLACEMENT: &str = "[redacted]";

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ExportRedaction {
    pub enabled: bool,
    patterns: Vec<String>,
}

impl ExportRedaction {
    pub fn parse(value: Value) -> Result<Self, String> {
        let config: Self = serde_json::from_value(value).map_err(|_| "自定义脱敏设置格式无效")?;
        config.compile()?;
        Ok(config)
    }

    fn compile(&self) -> Result<Vec<Regex>, String> {
        if self.patterns.len() > MAX_RULES {
            return Err(format!("最多可设置 {MAX_RULES} 条脱敏规则"));
        }
        if self.enabled && self.patterns.is_empty() {
            return Err("请至少添加一条脱敏规则".into());
        }
        self.patterns
            .iter()
            .enumerate()
            .map(|(index, pattern)| {
                if pattern.trim().is_empty() || pattern.len() > MAX_PATTERN_BYTES {
                    return Err(format!(
                        "第 {} 条规则不能为空或超过 {MAX_PATTERN_BYTES} 字节",
                        index + 1
                    ));
                }
                RegexBuilder::new(pattern)
                    .size_limit(256 * 1024)
                    .dfa_size_limit(1024 * 1024)
                    .build()
                    .map_err(|_| format!("第 {} 条规则不是有效的受支持正则", index + 1))
            })
            .collect()
    }

    pub fn test(&self, sample: &str) -> Result<String, String> {
        if sample.len() > MAX_TEST_BYTES {
            return Err("测试文本不能超过 32 KB".into());
        }
        redact(sample, &self.compile()?, MAX_TEST_BYTES * 10)
    }

    pub fn apply(&self, mut document: Value) -> Result<Value, String> {
        if !self.enabled {
            return Err("自定义脱敏设置已变化，请重新打开导出预览".into());
        }
        let mut input = MAX_EXPORT_BYTES;
        let mut output = MAX_EXPORT_BYTES;
        visit(&mut document, &self.compile()?, &mut input, &mut output)?;
        Ok(document)
    }
}

fn visit(
    value: &mut Value,
    rules: &[Regex],
    input: &mut usize,
    output: &mut usize,
) -> Result<(), String> {
    match value {
        Value::String(text) => {
            *input = input.checked_sub(text.len()).ok_or_else(size_error)?;
            *text = redact(text, rules, *output)?;
            *output = output.checked_sub(text.len()).ok_or_else(size_error)?;
        }
        Value::Array(values) => {
            for value in values {
                visit(value, rules, input, output)?;
            }
        }
        Value::Object(entries) => {
            for value in entries.values_mut() {
                visit(value, rules, input, output)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn redact(text: &str, rules: &[Regex], limit: usize) -> Result<String, String> {
    let mut result = std::borrow::Cow::Borrowed(text);
    for rule in rules {
        let mut next = String::new();
        let mut end = 0;
        let mut search_start = 0;
        let mut remaining = MAX_SCAN_BYTES_PER_VALUE;
        for hit in rule.find_iter(&result) {
            // 反复从后续位置搜索时，单次搜索可能读取剩余的全部文本。
            remaining = remaining
                .checked_sub(result.len() - search_start)
                .ok_or_else(|| "单个文本值的脱敏匹配过多，请缩小规则的匹配范围".to_string())?;
            search_start = hit.end();
            if hit.is_empty() {
                continue;
            }
            let prefix = &result[end..hit.start()];
            if next.len() + prefix.len() + REPLACEMENT.len() > limit {
                return Err(size_error());
            }
            next.push_str(prefix);
            next.push_str(REPLACEMENT);
            end = hit.end();
        }
        if end == 0 {
            continue;
        }
        let tail = &result[end..];
        if next.len() + tail.len() > limit {
            return Err(size_error());
        }
        next.push_str(tail);
        result = std::borrow::Cow::Owned(next);
    }
    Ok(result.into_owned())
}

fn size_error() -> String {
    "脱敏内容超过大小上限，请缩小导出范围或调整规则".into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn 逐条脱敏正文和嵌套字符串并且保留结构() {
        let settings = ExportRedaction::parse(json!({
            "enabled": true, "patterns": ["(?i)company\\d+", "\"private\"\\nnext", "^"]
        }))
        .unwrap();
        assert_eq!(
            settings
                .apply(json!({"company7": ["Company36", "\"private\"\nnext", 3]}))
                .unwrap(),
            json!({"company7": ["[redacted]", "[redacted]", 3]})
        );
        assert_eq!(settings.test("Company36").unwrap(), "[redacted]");
    }

    #[test]
    fn 拒绝无效正则和结果膨胀() {
        assert!(ExportRedaction::parse(json!({"patterns": ["("]})).is_err());
        assert!(ExportRedaction::parse(json!({"enabled": true})).is_err());
        assert!(redact("xxxx", &[Regex::new("x").unwrap()], 10).is_err());
    }
}
