use std::{
    collections::{BTreeSet, HashMap},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

use percent_encoding::percent_decode_str;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};
use url::Url;

use crate::{maintenance, sessions::SessionStore};

#[derive(Clone)]
pub struct BackendState {
    store: Arc<Mutex<SessionStore>>,
    maintenance_enabled: Arc<AtomicBool>,
    maintenance_lock: Arc<Mutex<()>>,
}

impl BackendState {
    pub fn load() -> Result<Self, String> {
        Ok(Self {
            store: Arc::new(Mutex::new(SessionStore::load()?)),
            maintenance_enabled: Arc::new(AtomicBool::new(false)),
            maintenance_lock: Arc::new(Mutex::new(())),
        })
    }

    pub fn refresh_and_emit(&self, app: &AppHandle) -> Result<(), String> {
        self.store.lock().map_err(lock_error)?.refresh()?;
        app.emit("sessions-changed", json!({ "type": "session-updated" }))
            .map_err(|error| error.to_string())
    }

    pub fn refresh_paths_and_emit(
        &self,
        app: &AppHandle,
        paths: &BTreeSet<PathBuf>,
    ) -> Result<(), String> {
        let changed = self
            .store
            .lock()
            .map_err(lock_error)?
            .refresh_paths(paths)?;
        if changed {
            app.emit("sessions-changed", json!({ "type": "session-updated" }))
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    pub fn watch_roots(&self) -> Result<Vec<std::path::PathBuf>, String> {
        Ok(self.store.lock().map_err(lock_error)?.watch_roots())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendRequest {
    url: String,
    #[serde(default = "default_method")]
    method: String,
    #[serde(default)]
    body: Value,
}

fn default_method() -> String {
    "GET".into()
}

#[tauri::command]
pub async fn request_json(
    app: AppHandle,
    state: State<'_, BackendState>,
    request: FrontendRequest,
) -> Result<Value, String> {
    let backend = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || route_request(app, backend, request))
        .await
        .map_err(|error| format!("后端任务异常结束：{error}"))?
}

fn route_request(
    app: AppHandle,
    state: BackendState,
    request: FrontendRequest,
) -> Result<Value, String> {
    let parsed = Url::parse(&format!("http://allsessions.local{}", request.url))
        .map_err(|_| "请求地址无效".to_string())?;
    let path = parsed.path();
    let query = parsed.query_pairs().into_owned().collect::<HashMap<_, _>>();
    let method = request.method.to_uppercase();

    match (method.as_str(), path) {
        ("GET", "/api/capabilities") => {
            let enabled = state.maintenance_enabled.load(Ordering::SeqCst);
            Ok(state
                .store
                .lock()
                .map_err(lock_error)?
                .capabilities(enabled))
        }
        ("POST", "/api/codex-maintenance") => {
            let enabled = request
                .body
                .get("enabled")
                .and_then(Value::as_bool)
                .ok_or_else(|| "enabled 必须是布尔值".to_string())?;
            if !enabled {
                state.maintenance_enabled.store(false, Ordering::SeqCst);
            } else {
                let _guard = state.maintenance_lock.lock().map_err(lock_error)?;
                state.maintenance_enabled.store(true, Ordering::SeqCst);
            }
            Ok(json!({ "enabled": enabled }))
        }
        (_, path) if path.starts_with("/api/codex-provider-migration/") => {
            if !state.maintenance_enabled.load(Ordering::SeqCst) {
                return Err("Codex 维护模式未开启".into());
            }
            let _guard = state.maintenance_lock.lock().map_err(lock_error)?;
            if !state.maintenance_enabled.load(Ordering::SeqCst) {
                return Err("Codex 维护模式已关闭".into());
            }
            let result = match (method.as_str(), path) {
                ("GET", "/api/codex-provider-migration/preview") => maintenance::preview(
                    query.get("providers").map(String::as_str),
                    &state.maintenance_enabled,
                ),
                ("POST", "/api/codex-provider-migration/apply") => {
                    maintenance::apply(&request.body)
                }
                ("POST", "/api/codex-provider-migration/rollback") => {
                    maintenance::rollback(&request.body)
                }
                _ => Err("不支持的维护请求".into()),
            }?;
            if path != "/api/codex-provider-migration/preview" {
                state.refresh_and_emit(&app)?;
            }
            Ok(result)
        }
        ("GET", "/api/sessions") => Ok(state.store.lock().map_err(lock_error)?.list(&query)),
        ("GET", "/api/search") => {
            if query.get("q").is_none_or(|value| value.trim().is_empty()) {
                return Err("缺少搜索内容".into());
            }
            Ok(state.store.lock().map_err(lock_error)?.search(&query))
        }
        ("GET", "/api/facets") => Ok(state.store.lock().map_err(lock_error)?.facets()),
        ("GET", "/api/stats") => Ok(state.store.lock().map_err(lock_error)?.stats(&query)),
        ("GET", "/api/refresh") => {
            state.refresh_and_emit(&app)?;
            Ok(json!({ "ok": true }))
        }
        ("GET", path) if path.starts_with("/api/sessions/") => {
            let key = percent_decode_str(path.trim_start_matches("/api/sessions/"))
                .decode_utf8()
                .map_err(|_| "会话 ID 编码无效".to_string())?;
            state
                .store
                .lock()
                .map_err(lock_error)?
                .detail(&key)
                .ok_or_else(|| "会话不存在".into())
        }
        _ => Err(format!("不支持的请求：{method} {path}")),
    }
}

fn lock_error<T>(_: std::sync::PoisonError<T>) -> String {
    "应用内部状态已损坏".into()
}
