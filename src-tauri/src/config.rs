use std::{
    collections::BTreeSet,
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;

const ROOT_LIMIT_PER_KIND: usize = 16;
const ROOT_TEXT_LIMIT: usize = 1024;
const SOURCE_KINDS: [&str; 4] = ["codex", "codex_archived", "claude", "gemini"];

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AppConfig {
    pub sources: SourceRoots,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SourceRoots {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codex: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codex_archived: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claude: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gemini: Option<Vec<String>>,
}

impl SourceRoots {
    pub fn get(&self, kind: &str) -> Option<&Vec<String>> {
        match kind {
            "codex" => self.codex.as_ref(),
            "codex_archived" => self.codex_archived.as_ref(),
            "claude" => self.claude.as_ref(),
            "gemini" => self.gemini.as_ref(),
            _ => None,
        }
    }

    fn set(&mut self, kind: &str, roots: Option<Vec<String>>) {
        match kind {
            "codex" => self.codex = roots,
            "codex_archived" => self.codex_archived = roots,
            "claude" => self.claude = roots,
            "gemini" => self.gemini = roots,
            _ => {}
        }
    }
}

pub fn config_path() -> Option<PathBuf> {
    if let Some(custom) = std::env::var_os("ALLSESSIONS_CONFIG_PATH") {
        return Some(PathBuf::from(custom));
    }
    dirs::config_dir().map(|dir| dir.join("AllSessions").join("config.json"))
}

pub fn load(path: &Path) -> Result<AppConfig, String> {
    match fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text)
            .map_err(|error| format!("配置文件格式无效（{}）：{error}", path.display())),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(AppConfig::default()),
        Err(error) => Err(format!("无法读取配置文件（{}）：{error}", path.display())),
    }
}

pub fn save(path: &Path, config: &AppConfig) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("无法创建配置目录（{}）：{error}", parent.display()))?;
    }
    let text = serde_json::to_string_pretty(config).map_err(|error| error.to_string())?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, format!("{text}\n"))
        .map_err(|error| format!("无法写入配置文件（{}）：{error}", temporary.display()))?;
    fs::rename(&temporary, path)
        .map_err(|error| format!("无法保存配置文件（{}）：{error}", path.display()))
}

fn normalize_root_list(value: &Value, kind: &str) -> Result<Vec<String>, String> {
    let items = value
        .as_array()
        .ok_or_else(|| format!("来源 {kind} 的根目录必须是数组"))?;
    if items.len() > ROOT_LIMIT_PER_KIND {
        return Err(format!("来源 {kind} 的根目录最多 {ROOT_LIMIT_PER_KIND} 个"));
    }
    let mut seen = BTreeSet::new();
    let mut roots = Vec::with_capacity(items.len());
    for item in items {
        let raw = item
            .as_str()
            .ok_or_else(|| format!("来源 {kind} 的根目录必须是字符串"))?;
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Err(format!("来源 {kind} 的根目录不能为空"));
        }
        if trimmed.chars().count() > ROOT_TEXT_LIMIT {
            return Err(format!("来源 {kind} 的根目录过长"));
        }
        if seen.insert(trimmed.to_string()) {
            roots.push(trimmed.to_string());
        }
    }
    Ok(roots)
}

pub fn parse_sources(value: &Value) -> Result<SourceRoots, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "sources 必须是对象".to_string())?;
    for key in object.keys() {
        if !SOURCE_KINDS.contains(&key.as_str()) {
            return Err(format!("未知的来源类型：{key}"));
        }
    }
    let mut roots = SourceRoots::default();
    for kind in SOURCE_KINDS {
        match object.get(kind) {
            None | Some(Value::Null) => roots.set(kind, None),
            Some(list) => roots.set(kind, Some(normalize_root_list(list, kind)?)),
        }
    }
    Ok(roots)
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use tempfile::tempdir;

    use super::{load, parse_sources, save, AppConfig, SourceRoots};

    #[test]
    fn 缺失配置文件时返回默认配置() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("config.json");
        assert_eq!(load(&path).unwrap(), AppConfig::default());
    }

    #[test]
    fn 配置保存后可以原样读回() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("nested").join("config.json");
        let mut config = AppConfig::default();
        config.sources.codex = Some(vec!["~/codex-alt".to_string()]);
        save(&path, &config).unwrap();
        assert_eq!(load(&path).unwrap(), config);
    }

    #[test]
    fn 无效配置文件会报错而不是静默覆盖() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("config.json");
        std::fs::write(&path, "{ not json").unwrap();
        assert!(load(&path).unwrap_err().contains("格式无效"));
    }

    #[test]
    fn 解析来源会修剪去重并接受空数组() {
        let parsed = parse_sources(&json!({
            "codex": [" ~/a ", "~/a", "~/b"],
            "claude": [],
            "gemini": null
        }))
        .unwrap();
        assert_eq!(
            parsed.codex,
            Some(vec!["~/a".to_string(), "~/b".to_string()])
        );
        assert_eq!(parsed.claude, Some(Vec::new()));
        assert_eq!(parsed.gemini, None);
        assert_eq!(parsed.codex_archived, None);
    }

    #[test]
    fn 解析来源拒绝非法输入() {
        assert!(parse_sources(&json!({ "unknown": [] })).is_err());
        assert!(parse_sources(&json!({ "codex": "x" })).is_err());
        assert!(parse_sources(&json!({ "codex": [""] })).is_err());
        assert!(parse_sources(&json!({ "codex": [1] })).is_err());
        assert!(parse_sources(&json!(["codex"])).is_err());
    }

    #[test]
    fn 解析来源限制根目录数量() {
        let too_many = vec!["x"; 17];
        assert!(parse_sources(&json!({ "codex": too_many })).is_err());
    }

    #[test]
    fn 空对象等价于全部跟随默认() {
        assert_eq!(parse_sources(&json!({})).unwrap(), SourceRoots::default());
    }
}
