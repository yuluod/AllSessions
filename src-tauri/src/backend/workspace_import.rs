use super::{BackendState, lock_error};
use crate::{error::ApiError, workspace::WorkspaceTransfer};
use serde_json::{Value, json};

pub(super) enum ImportAction {
    Preview,
    Apply,
}

impl BackendState {
    pub(super) fn workspace_import(
        &self,
        action: ImportAction,
        body: &Value,
    ) -> Result<Value, ApiError> {
        let transfer = WorkspaceTransfer::parse(
            body["file"]
                .as_str()
                .ok_or_else(|| ApiError::invalid("缺少工作台文件内容"))?,
        )
        .map_err(ApiError::invalid)?;
        let choices = body
            .get("choices")
            .map(|value| {
                serde_json::from_value(value.clone())
                    .map_err(|_| ApiError::invalid("会话匹配选项无效"))
            })
            .transpose()?
            .unwrap_or_default();
        let matches = {
            let store = self.store.lock().map_err(lock_error)?;
            if store.scanning() && transfer.session_keys().next().is_some() {
                return Err(ApiError::new(
                    "workspace_scan_required",
                    "请完成会话扫描后再导入工作台数据",
                ));
            }
            store
                .workspace_matches(transfer.session_keys(), &choices)
                .map_err(ApiError::invalid)?
        };
        let target_session = |key: &str| matches.targets.get(key).cloned();
        let replacements = body
            .get("replacements")
            .map(|value| {
                serde_json::from_value(value.clone())
                    .map_err(|_| ApiError::invalid("导入冲突选项无效"))
            })
            .transpose()?
            .unwrap_or_default();
        if matches!(action, ImportAction::Preview) {
            let mut preview = self
                .workspace
                .lock()
                .map_err(lock_error)?
                .preview_transfer(
                    &transfer,
                    target_session,
                    &replacements,
                    body["previous_token"].as_str(),
                )?;
            preview["ambiguous"] = json!(matches.ambiguous);
            preview["omitted_candidates"] = json!(matches.omitted_candidates);
            return Ok(preview);
        }
        let token = body["token"]
            .as_str()
            .filter(|value| value.len() == 64)
            .ok_or_else(|| ApiError::invalid("请先预览并确认导入"))?;
        Ok(self.workspace.lock().map_err(lock_error)?.import_transfer(
            &transfer,
            target_session,
            &replacements,
            token,
        )?)
    }
}
