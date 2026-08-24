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
    updater,
    workspace::{WorkspaceSnapshot, WorkspaceStore},
};

#[derive(Clone)]
pub struct BackendState {
    store: Arc<Mutex<SessionStore>>,
    workspace: Arc<Mutex<WorkspaceStore>>,
    config: Arc<Mutex<AppConfig>>,
    config_path: Option<PathBuf>,
    startup_error: Arc<Mutex<Option<String>>>,
    maintenance_enabled: Arc<AtomicBool>,
    maintenance_lock: Arc<Mutex<()>>,
}

impl BackendState {
    pub fn load() -> Result<Self, String> {
        let config_path = config::config_path();
        let (config, startup_error) = match &config_path {
            Some(path) => match config::load(path) {
                Ok(config) => (config, None),
                Err(error) => {
                    eprintln!("读取配置失败，已使用安全默认值启动：{error}");
                    (AppConfig::default(), Some(error))
                }
            },
            None => (AppConfig::default(), None),
        };
        Ok(Self {
            store: Arc::new(Mutex::new(SessionStore::load(&config)?)),
            workspace: Arc::new(Mutex::new(WorkspaceStore::open()?)),
            config: Arc::new(Mutex::new(config)),
            config_path,
            startup_error: Arc::new(Mutex::new(startup_error)),
            maintenance_enabled: Arc::new(AtomicBool::new(false)),
            maintenance_lock: Arc::new(Mutex::new(())),
        })
    }

    fn settings_payload(&self, app: &AppHandle) -> Result<Value, String> {
        let config = self.config.lock().map_err(lock_error)?.clone();
        let recovery_error = self.startup_error.lock().map_err(lock_error)?.clone();
        let workspace = self.workspace_snapshot()?;
        let store = self.store.lock().map_err(lock_error)?;
        let watcher = app
            .try_state::<crate::watcher::WatcherState>()
            .map(|state| state.status())
            .unwrap_or_else(
                || json!({ "active": false, "root_count": 0, "last_error": "监听器尚未初始化" }),
            );
        Ok(json!({
            "version": env!("CARGO_PKG_VERSION"),
            "config_path": self.config_path.as_ref().map(|path| path.to_string_lossy()),
            "sources": serde_json::to_value(&config.sources).map_err(|error| error.to_string())?,
            "preferences": serde_json::to_value(&config.preferences).map_err(|error| error.to_string())?,
            "resolved": crate::sessions::describe_sources(&config.sources),
            "inherited": crate::sessions::describe_inherited_sources(),
            "protected": crate::sessions::describe_protected_sources(&config.sources),
            "cache": store.cache_storage(),
            "diagnostics": store.diagnostics(),
            "watcher": watcher,
            "recovery": {
                "required": recovery_error.is_some(),
                "message": recovery_error,
            },
            "deletion_backup": crate::deletion_backup::storage_info(),
            "workspace_storage": workspace.value()["storage"].clone(),
        }))
    }

    fn workspace_snapshot(&self) -> Result<WorkspaceSnapshot, String> {
        self.workspace.lock().map_err(lock_error)?.snapshot()
    }

    fn clear_startup_error(&self) -> Result<(), String> {
        *self.startup_error.lock().map_err(lock_error)? = None;
        Ok(())
    }

    pub fn keep_running_in_tray(&self) -> Result<bool, String> {
        Ok(self
            .config
            .lock()
            .map_err(lock_error)?
            .preferences
            .keep_running_in_tray)
    }

    pub fn check_updates_on_startup(&self) -> Result<bool, String> {
        Ok(self
            .config
            .lock()
            .map_err(lock_error)?
            .preferences
            .check_updates_on_startup)
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
            let mut capabilities = state
                .store
                .lock()
                .map_err(lock_error)?
                .capabilities(enabled);
            capabilities["recovery_required"] =
                json!(state.startup_error.lock().map_err(lock_error)?.is_some());
            Ok(capabilities)
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
        ("GET", "/api/sessions") => {
            let workspace = state.workspace_snapshot()?;
            Ok(state
                .store
                .lock()
                .map_err(lock_error)?
                .list(&query, &workspace))
        }
        ("GET", "/api/search") => {
            if query.get("q").is_none_or(|value| value.trim().is_empty()) {
                return Err("缺少搜索内容".into());
            }
            let workspace = state.workspace_snapshot()?;
            Ok(state
                .store
                .lock()
                .map_err(lock_error)?
                .search(&query, &workspace))
        }
        ("POST", "/api/sessions/delete") => {
            if request.body.get("confirmed").and_then(Value::as_bool) != Some(true) {
                return Err("永久删除需要显式确认".into());
            }
            let session_key = request
                .body
                .get("sessionKey")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "缺少 sessionKey".to_string())?;
            let result = state
                .store
                .lock()
                .map_err(lock_error)?
                .delete_session(session_key)?;
            if let Err(error) = state
                .workspace
                .lock()
                .map_err(lock_error)?
                .clear_session(session_key)
            {
                eprintln!("清理已删除会话的工作台数据失败：{error}");
            }
            app.emit("sessions-changed", json!({ "type": "session-deleted" }))
                .map_err(|error| error.to_string())?;
            Ok(result)
        }
        ("POST", "/api/sessions/delete-message") => {
            if request.body.get("confirmed").and_then(Value::as_bool) != Some(true) {
                return Err("永久删除需要显式确认".into());
            }
            let session_key = request
                .body
                .get("sessionKey")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "缺少 sessionKey".to_string())?;
            let message_key = request
                .body
                .get("messageKey")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "缺少 messageKey".to_string())?;
            let result = state
                .store
                .lock()
                .map_err(lock_error)?
                .delete_message(session_key, message_key)?;
            if let Err(error) = state
                .workspace
                .lock()
                .map_err(lock_error)?
                .clear_message(session_key, message_key)
            {
                eprintln!("清理已删除消息的工作台数据失败：{error}");
            }
            app.emit("sessions-changed", json!({ "type": "session-updated" }))
                .map_err(|error| error.to_string())?;
            Ok(result)
        }
        ("GET", "/api/settings") => state.settings_payload(&app),
        ("GET", "/api/workspace") => Ok(state.workspace_snapshot()?.value()),
        ("POST", "/api/workspace/session") => state
            .workspace
            .lock()
            .map_err(lock_error)?
            .update_session(&request.body),
        ("POST", "/api/workspace/message") => state
            .workspace
            .lock()
            .map_err(lock_error)?
            .update_message(&request.body),
        ("POST", "/api/workspace/saved-filter") => state
            .workspace
            .lock()
            .map_err(lock_error)?
            .save_filter(&request.body),
        ("POST", "/api/workspace/saved-filter/delete") => state
            .workspace
            .lock()
            .map_err(lock_error)?
            .delete_filter(&request.body),
        ("POST", "/api/workspace/migrate-legacy") => state
            .workspace
            .lock()
            .map_err(lock_error)?
            .migrate_legacy(&request.body),
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
            let config = {
                let mut config = state.config.lock().map_err(lock_error)?;
                config.sources = sources;
                config::save(&config_path, &config)?;
                config.clone()
            };
            {
                let mut store = state.store.lock().map_err(lock_error)?;
                store.reconfigure(&config)?;
            }
            state.clear_startup_error()?;
            // 监听只是自动刷新的辅助能力；失败时保留旧监听，后续刷新会重试。
            state.sync_watcher_roots(&app);
            app.emit("sessions-changed", json!({ "type": "session-updated" }))
                .map_err(|error| error.to_string())?;
            state.settings_payload(&app)
        }
        ("POST", "/api/settings/preferences") => {
            let preferences = config::parse_preferences(
                request
                    .body
                    .get("preferences")
                    .ok_or_else(|| "缺少 preferences 字段".to_string())?,
            )?;
            let config_path = state
                .config_path
                .clone()
                .ok_or_else(|| "无法确定配置文件位置".to_string())?;
            let mut config = state.config.lock().map_err(lock_error)?;
            config.preferences = preferences;
            config::save(&config_path, &config)?;
            drop(config);
            state.clear_startup_error()?;
            state.settings_payload(&app)
        }
        ("POST", "/api/settings/clear-cache") => {
            {
                let mut store = state.store.lock().map_err(lock_error)?;
                store.clear_index_cache();
                store.refresh()?;
            }
            app.emit("sessions-changed", json!({ "type": "session-updated" }))
                .map_err(|error| error.to_string())?;
            state.settings_payload(&app)
        }
        ("POST", "/api/settings/check-update") => {
            updater::check_for_updates(app);
            Ok(json!({ "ok": true }))
        }
        ("GET", "/api/facets") => {
            let workspace = state.workspace_snapshot()?;
            let mut facets = state.store.lock().map_err(lock_error)?.facets();
            facets["workspace_tags"] = json!(workspace.tags());
            Ok(facets)
        }
        ("GET", "/api/stats") => {
            let workspace = state.workspace_snapshot()?;
            Ok(state
                .store
                .lock()
                .map_err(lock_error)?
                .stats(&query, &workspace))
        }
        ("GET", "/api/refresh") => {
            state.refresh_and_emit(&app)?;
            Ok(json!({ "ok": true }))
        }
        ("GET", path) if path.starts_with("/api/sessions/") => {
            let key = percent_decode_str(path.trim_start_matches("/api/sessions/"))
                .decode_utf8()
                .map_err(|_| "会话 ID 编码无效".to_string())?;
            let mut detail = state
                .store
                .lock()
                .map_err(lock_error)?
                .detail(&key)
                .ok_or_else(|| "会话不存在".to_string())?;
            state.workspace_snapshot()?.decorate_detail(&mut detail);
            Ok(detail)
        }
        _ => Err(format!("不支持的请求：{method} {path}")),
    }
}

fn lock_error<T>(_: std::sync::PoisonError<T>) -> String {
    "应用内部状态已损坏".into()
}
