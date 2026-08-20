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
use tauri::{AppHandle, Emitter, Manager, State};
use url::Url;

use crate::{
    config::{self, AppConfig},
    maintenance,
    sessions::SessionStore,
};

#[derive(Clone)]
pub struct BackendState {
    store: Arc<Mutex<SessionStore>>,
    config: Arc<Mutex<AppConfig>>,
    config_path: Option<PathBuf>,
    maintenance_enabled: Arc<AtomicBool>,
    maintenance_lock: Arc<Mutex<()>>,
}

impl BackendState {
    pub fn load() -> Result<Self, String> {
        let config_path = config::config_path();
        let config = match &config_path {
            Some(path) => config::load(path)?,
            None => AppConfig::default(),
        };
        Ok(Self {
            store: Arc::new(Mutex::new(SessionStore::load(&config)?)),
            config: Arc::new(Mutex::new(config)),
            config_path,
            maintenance_enabled: Arc::new(AtomicBool::new(false)),
            maintenance_lock: Arc::new(Mutex::new(())),
        })
    }

    fn settings_payload(&self) -> Result<Value, String> {
        let config = self.config.lock().map_err(lock_error)?.clone();
        let store = self.store.lock().map_err(lock_error)?;
        Ok(json!({
            "version": env!("CARGO_PKG_VERSION"),
            "config_path": self.config_path.as_ref().map(|path| path.to_string_lossy()),
            "sources": serde_json::to_value(&config.sources).map_err(|error| error.to_string())?,
            "resolved": crate::sessions::describe_sources(&config.sources),
            "cache": store.cache_storage(),
        }))
    }

    pub fn refresh_and_emit(&self, app: &AppHandle) -> Result<(), String> {
        self.store.lock().map_err(lock_error)?.refresh()?;
        self.sync_watcher_roots(app);
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
        self.sync_watcher_roots(app);
        if changed {
            app.emit("sessions-changed", json!({ "type": "session-updated" }))
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    /// 来源目录可能在刷新时新建或删除（例如用户首次运行 Codex/Claude/Gemini
    /// 后默认目录才出现），刷新后按当前来源重新同步监听。
    fn sync_watcher_roots(&self, app: &AppHandle) {
        let Some(watcher) = app.try_state::<crate::watcher::WatcherState>() else {
            return;
        };
        match self.watch_roots() {
            Ok(roots) => {
                if let Err(error) = watcher.rewatch(&roots) {
                    eprintln!("更新会话监听目录失败：{error}");
                }
            }
            Err(error) => eprintln!("获取会话监听目录失败：{error}"),
        }
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
        ("GET", "/api/settings") => state.settings_payload(),
        ("POST", "/api/settings") => {
            let sources = config::parse_sources(
                request
                    .body
                    .get("sources")
                    .ok_or_else(|| "缺少 sources 字段".to_string())?,
            )?;
            let config_path = state
                .config_path
                .clone()
                .ok_or_else(|| "无法确定配置文件位置".to_string())?;
            let mut config = state.config.lock().map_err(lock_error)?.clone();
            config.sources = sources;
            config::save(&config_path, &config)?;
            *state.config.lock().map_err(lock_error)? = config.clone();
            {
                let mut store = state.store.lock().map_err(lock_error)?;
                store.reconfigure(&config)?;
            }
            // 监听只是自动刷新的辅助能力；失败时保留旧监听，后续刷新会重试。
            state.sync_watcher_roots(&app);
            app.emit("sessions-changed", json!({ "type": "session-updated" }))
                .map_err(|error| error.to_string())?;
            state.settings_payload()
        }
        ("POST", "/api/settings/clear-cache") => {
            {
                let mut store = state.store.lock().map_err(lock_error)?;
                store.clear_index_cache();
                store.refresh()?;
            }
            app.emit("sessions-changed", json!({ "type": "session-updated" }))
                .map_err(|error| error.to_string())?;
            state.settings_payload()
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
