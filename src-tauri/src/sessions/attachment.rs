//! 按需读取会话内嵌图片：详情只带定位信息，这里校验后单独返回 data URL。
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::Path;

use serde_json::{json, Value};

use super::{json_fingerprint, StoredSession};

/// 单张图片解码后的字节上限；超过时不传输，避免详情通道被大图拖垮。
pub(crate) const MAX_IMAGE_BYTES: usize = 8 * 1024 * 1024;
/// 定位路径只允许字符串键与数组下标，长度封顶防止构造异常请求。
const MAX_LOCATOR_DEPTH: usize = 8;
const MAX_KEY_CHARS: usize = 64;
const MAX_ARRAY_INDEX: u64 = 100_000;

enum Segment {
    Key(String),
    Index(usize),
}

pub(crate) fn read_image(record: &StoredSession, locator: &Value) -> Result<Value, String> {
    read_image_with_limit(record, locator, MAX_IMAGE_BYTES)
}

pub(crate) fn read_image_with_limit(
    record: &StoredSession,
    locator: &Value,
    limit: usize,
) -> Result<Value, String> {
    if record.detail_locator.is_some() {
        return Err("当前来源暂不支持图片预览".into());
    }
    if record.path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
        return Err("当前来源暂不支持图片预览".into());
    }
    let line_number = locator["line_number"]
        .as_u64()
        .filter(|value| *value > 0)
        .ok_or_else(|| "图片定位信息无效".to_string())?;
    let fingerprint = locator["record_fingerprint"]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "图片定位信息无效".to_string())?;
    let segments = parse_path(&locator["path"])?;

    let line = read_line(&record.path, line_number)?;
    let record_value: Value =
        serde_json::from_str(&line).map_err(|error| format!("会话记录解析失败：{error}"))?;
    if json_fingerprint(&record_value) != fingerprint {
        return Err("会话内容已变化，请刷新后重试".into());
    }
    let block = navigate(&record_value, &segments)?;
    let (media_type, data) = image_payload(block)?;
    let media_type = normalize_media_type(&media_type)?;
    let data = strip_data_url_prefix(&data)?;
    finish_image(media_type, data, limit)
}

/// 读取本地图片文件：兼容 data URL 文本、纯 base64 文本和二进制图片。
pub(crate) fn image_value_from_path(
    path: &Path,
    limit: usize,
    media_hint: Option<&str>,
) -> Result<Value, String> {
    let metadata = fs::metadata(path).map_err(|error| format!("读取图片文件失败：{error}"))?;
    if !metadata.is_file() {
        return Err("图片文件不存在".into());
    }
    // base64 文本约为原图的 4/3，先按两倍上限拦截，避免读入异常大文件。
    if metadata.len() > limit.saturating_mul(2) as u64 {
        return Err(format!("图片体积超过 {} MB 上限", limit / 1024 / 1024));
    }
    let bytes = fs::read(path).map_err(|error| format!("读取图片文件失败：{error}"))?;
    image_value_from_bytes(&bytes, limit, media_hint)
}

fn image_value_from_bytes(
    bytes: &[u8],
    limit: usize,
    media_hint: Option<&str>,
) -> Result<Value, String> {
    if let Ok(text) = std::str::from_utf8(bytes) {
        let trimmed = text.trim();
        if trimmed.starts_with("data:") {
            let (media_type, data) = parse_data_url(trimmed)?;
            return finish_image(normalize_media_type(&media_type)?, data, limit);
        }
        if media_hint.is_some() && is_plain_base64(trimmed) {
            return finish_image(
                normalize_media_type(media_hint.unwrap_or_default())?,
                trimmed.to_string(),
                limit,
            );
        }
    }
    let media_type = sniff_image_type(bytes)?;
    if bytes.len() > limit {
        return Err(format!("图片体积超过 {} MB 上限", limit / 1024 / 1024));
    }
    Ok(json!({
        "media_type": media_type,
        "data_url": format!("data:{media_type};base64,{}", encode_base64(bytes)),
        "bytes": bytes.len(),
    }))
}

fn finish_image(media_type: &str, data: String, limit: usize) -> Result<Value, String> {
    let mut data = data.trim().to_string();
    let padding = (4 - data.len() % 4) % 4;
    data.push_str(&"=".repeat(padding));
    let bytes = validate_base64(&data)?;
    if bytes > limit {
        return Err(format!("图片体积超过 {} MB 上限", limit / 1024 / 1024));
    }
    Ok(json!({
        "media_type": media_type,
        "data_url": format!("data:{media_type};base64,{data}"),
        "bytes": bytes,
    }))
}

/// 直接解析字符串形式的图片数据：data URL 或纯 base64。
pub(crate) fn image_value_from_data(
    data: &str,
    media_hint: Option<&str>,
    limit: usize,
) -> Result<Value, String> {
    let trimmed = data.trim();
    if trimmed.starts_with("data:") {
        let (media_type, data) = parse_data_url(trimmed)?;
        return finish_image(normalize_media_type(&media_type)?, data, limit);
    }
    if is_plain_base64(trimmed) {
        let media_type =
            normalize_media_type(media_hint.ok_or_else(|| "图片缺少媒体类型".to_string())?)?;
        return finish_image(media_type, trimmed.to_string(), limit);
    }
    // 部分来源会把 base64 折行存储，去掉空白后再判断。
    let compact: String = trimmed
        .chars()
        .filter(|value| !value.is_whitespace())
        .collect();
    if is_plain_base64(&compact) {
        let media_type =
            normalize_media_type(media_hint.ok_or_else(|| "图片缺少媒体类型".to_string())?)?;
        return finish_image(media_type, compact, limit);
    }
    Err("图片数据格式无效".into())
}

fn is_plain_base64(value: &str) -> bool {
    value.len() >= 8
        && value.len() % 4 != 1
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || byte == b'+' || byte == b'/' || byte == b'='
        })
}

fn sniff_image_type(bytes: &[u8]) -> Result<&'static str, String> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Ok("image/png");
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Ok("image/jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Ok("image/gif");
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Ok("image/webp");
    }
    Err("图片数据格式无效".into())
}

fn encode_base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let first = chunk[0] as u32;
        let second = chunk.get(1).copied().unwrap_or(0) as u32;
        let third = chunk.get(2).copied().unwrap_or(0) as u32;
        let value = (first << 16) | (second << 8) | third;
        output.push(TABLE[(value >> 18) as usize & 63] as char);
        output.push(TABLE[(value >> 12) as usize & 63] as char);
        output.push(if chunk.len() > 1 {
            TABLE[(value >> 6) as usize & 63] as char
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            TABLE[value as usize & 63] as char
        } else {
            '='
        });
    }
    output
}

/// 按详情里的路径定位记录内节点；供各来源复用同一套路径校验。
pub(crate) fn value_at_path<'a>(value: &'a Value, path: &Value) -> Result<&'a Value, String> {
    let segments = parse_path(path)?;
    navigate(value, &segments)
}

fn parse_path(value: &Value) -> Result<Vec<Segment>, String> {
    let segments = value
        .as_array()
        .ok_or_else(|| "图片定位信息无效".to_string())?;
    if segments.is_empty() || segments.len() > MAX_LOCATOR_DEPTH {
        return Err("图片定位信息无效".into());
    }
    segments
        .iter()
        .map(|segment| match segment {
            Value::String(key) if key.chars().count() <= MAX_KEY_CHARS => {
                Ok(Segment::Key(key.clone()))
            }
            Value::Number(number) => number
                .as_u64()
                .filter(|index| *index < MAX_ARRAY_INDEX)
                .map(|index| Segment::Index(index as usize))
                .ok_or_else(|| "图片定位信息无效".to_string()),
            _ => Err("图片定位信息无效".into()),
        })
        .collect()
}

fn read_line(path: &Path, line_number: u64) -> Result<String, String> {
    let file = File::open(path).map_err(|error| format!("读取会话文件失败：{error}"))?;
    for (index, line) in BufReader::new(file).lines().enumerate() {
        if index as u64 + 1 == line_number {
            return line.map_err(|error| format!("读取会话记录失败：{error}"));
        }
    }
    Err("图片所在记录已不存在，请刷新会话".into())
}

fn navigate<'a>(record: &'a Value, segments: &[Segment]) -> Result<&'a Value, String> {
    let mut current = record;
    for segment in segments {
        current = match segment {
            Segment::Key(key) => current
                .get(key)
                .ok_or_else(|| "图片所在内容已变化，请刷新会话".to_string())?,
            Segment::Index(index) => current
                .get(*index)
                .ok_or_else(|| "图片所在内容已变化，请刷新会话".to_string())?,
        };
    }
    Ok(current)
}

fn image_payload(block: &Value) -> Result<(String, String), String> {
    let kind = block["type"].as_str().unwrap_or_default();
    if kind == "image" {
        let media_type = block["source"]["media_type"]
            .as_str()
            .or_else(|| block["mimeType"].as_str())
            .or_else(|| block["mime_type"].as_str())
            .ok_or_else(|| "图片缺少媒体类型".to_string())?;
        let data = block["source"]["data"]
            .as_str()
            .or_else(|| block["data"].as_str())
            .ok_or_else(|| "图片缺少内嵌数据".to_string())?;
        return Ok((media_type.into(), data.into()));
    }
    if matches!(kind, "input_image" | "image_url") {
        let url = block["image_url"]
            .as_str()
            .or_else(|| block["image_url"]["url"].as_str())
            .or_else(|| block["imageUrl"]["url"].as_str())
            .or_else(|| block["url"].as_str())
            .ok_or_else(|| "图片缺少地址".to_string())?;
        return parse_data_url(url);
    }
    let inline = block
        .get("inlineData")
        .or_else(|| block.get("inline_data"))
        .ok_or_else(|| "该附件不是内嵌图片".to_string())?;
    let media_type = inline["mimeType"]
        .as_str()
        .or_else(|| inline["mime_type"].as_str())
        .unwrap_or("image/png");
    let data = inline["data"]
        .as_str()
        .ok_or_else(|| "图片缺少内嵌数据".to_string())?;
    Ok((media_type.into(), data.into()))
}

fn parse_data_url(url: &str) -> Result<(String, String), String> {
    let rest = url
        .strip_prefix("data:")
        .ok_or_else(|| "仅支持内嵌图片，不加载远程地址".to_string())?;
    let (meta, data) = rest
        .split_once(',')
        .ok_or_else(|| "图片数据格式无效".to_string())?;
    let media_type = meta
        .strip_suffix(";base64")
        .ok_or_else(|| "图片数据不是 base64 编码".to_string())?;
    Ok((media_type.to_string(), data.to_string()))
}

fn strip_data_url_prefix(value: &str) -> Result<String, String> {
    if value.starts_with("data:") {
        return parse_data_url(value).map(|(_, data)| data);
    }
    Ok(value.to_string())
}

fn normalize_media_type(value: &str) -> Result<&'static str, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "image/png" => Ok("image/png"),
        "image/jpeg" | "image/jpg" => Ok("image/jpeg"),
        "image/webp" => Ok("image/webp"),
        "image/gif" => Ok("image/gif"),
        "image/svg+xml" => Err("出于安全考虑不显示 SVG 图片".into()),
        other if other.starts_with("image/") => Err(format!("暂不支持 {other} 图片")),
        _ => Err("附件不是图片".into()),
    }
}

/// 只做格式与体积校验，不在这里解码；浏览器负责最终渲染。
fn validate_base64(data: &str) -> Result<usize, String> {
    if data.is_empty() || data.len() % 4 == 1 {
        return Err("图片数据不是有效的 base64".into());
    }
    let padding = data.bytes().rev().take_while(|byte| *byte == b'=').count();
    if padding > 2 {
        return Err("图片数据不是有效的 base64".into());
    }
    let body = &data[..data.len() - padding];
    if body.contains('=')
        || !(body.len() + padding).is_multiple_of(4)
        || !body
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'+' || byte == b'/')
    {
        return Err("图片数据不是有效的 base64".into());
    }
    let remainder = body.len() % 4;
    if remainder == 1 {
        return Err("图片数据不是有效的 base64".into());
    }
    Ok(body.len() / 4 * 3 + remainder.saturating_sub(1))
}
