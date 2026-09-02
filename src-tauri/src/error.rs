use serde::Serialize;

/// 跨越 Tauri 边界的结构化错误：`code` 供前端做 i18n 映射，
/// `message` 保留后端的原始描述作为回退文案。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ApiError {
    pub code: &'static str,
    pub message: String,
}

impl ApiError {
    pub const INTERNAL: &'static str = "internal";
    pub const INVALID_REQUEST: &'static str = "invalid_request";
    pub const CONFIRMATION_REQUIRED: &'static str = "confirmation_required";
    pub const SESSION_NOT_FOUND: &'static str = "session_not_found";
    pub const READ_ONLY_SOURCE: &'static str = "read_only_source";
    pub const FILE_CHANGED: &'static str = "file_changed";
    pub const MAINTENANCE_DISABLED: &'static str = "maintenance_disabled";

    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(Self::INVALID_REQUEST, message)
    }
}

impl From<String> for ApiError {
    fn from(message: String) -> Self {
        Self::new(Self::INTERNAL, message)
    }
}

impl From<&str> for ApiError {
    fn from(message: &str) -> Self {
        Self::new(Self::INTERNAL, message)
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

#[cfg(test)]
mod tests {
    use super::ApiError;

    #[test]
    fn 未分类的字符串错误归为内部错误() {
        let error: ApiError = "磁盘读取失败".to_string().into();
        assert_eq!(error.code, ApiError::INTERNAL);
        assert_eq!(error.message, "磁盘读取失败");
    }

    #[test]
    fn 序列化包含错误码与文案() {
        let value =
            serde_json::to_value(ApiError::new(ApiError::READ_ONLY_SOURCE, "只读")).unwrap();
        assert_eq!(value["code"], "read_only_source");
        assert_eq!(value["message"], "只读");
    }
}
