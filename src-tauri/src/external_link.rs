use url::Url;

use crate::error::ApiError;

const ALLOWED_SCHEMES: [&str; 3] = ["https", "http", "mailto"];

pub fn validate_external_url(raw: &str) -> Result<String, ApiError> {
    let trimmed = raw.trim();
    let parsed = Url::parse(trimmed).map_err(|_| ApiError::invalid("链接地址无效"))?;
    if !ALLOWED_SCHEMES.contains(&parsed.scheme()) {
        return Err(ApiError::invalid(format!(
            "不支持打开 {} 链接",
            parsed.scheme()
        )));
    }
    if parsed.scheme() != "mailto" && parsed.host_str().is_none_or(str::is_empty) {
        return Err(ApiError::invalid("链接缺少主机名"));
    }
    Ok(parsed.to_string())
}

#[cfg(test)]
mod tests {
    use super::validate_external_url;
    use crate::error::ApiError;

    #[test]
    fn 接受网页与邮件链接() {
        assert_eq!(
            validate_external_url(" https://example.com/a?b=1#c ").unwrap(),
            "https://example.com/a?b=1#c"
        );
        assert_eq!(
            validate_external_url("HTTP://Example.com").unwrap(),
            "http://example.com/"
        );
        assert_eq!(
            validate_external_url("mailto:someone@example.com").unwrap(),
            "mailto:someone@example.com"
        );
    }

    #[test]
    fn 拒绝其他协议与无效地址() {
        for raw in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "vscode://open?file=/tmp/a",
            "ssh://host",
            "http://",
            "/relative/path",
            "#anchor",
            "",
        ] {
            let error = validate_external_url(raw).unwrap_err();
            assert_eq!(error.code, ApiError::INVALID_REQUEST, "{raw}");
        }
    }
}
