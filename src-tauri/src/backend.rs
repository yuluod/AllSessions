use std::{
    collections::{BTreeSet, HashMap},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Instant,
};

use percent_encoding::percent_decode_str;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use url::Url;

use crate::{
    config::{self, AppConfig},
    error::ApiError,
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
    scan_lock: Arc<Mutex<()>>,
    search_indexing: Arc<AtomicBool>,
    search_index_error: Arc<Mutex<Option<String>>>,
    index_progress: Arc<Mutex<Value>>,
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
            store: Arc::new(Mutex::new(SessionStore::open(&config)?)),
            workspace: Arc::new(Mutex::new(WorkspaceStore::open()?)),
            config: Arc::new(Mutex::new(config)),
            config_path,
            startup_error: Arc::new(Mutex::new(startup_error)),
            maintenance_enabled: Arc::new(AtomicBool::new(false)),
            maintenance_lock: Arc::new(Mutex::new(())),
            scan_lock: Arc::new(Mutex::new(())),
            search_indexing: Arc::new(AtomicBool::new(true)),
            search_index_error: Arc::new(Mutex::new(None)),
            index_progress: Arc::new(Mutex::new(json!({"phase":"scanning"}))),
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
            "terminal_options": crate::resume::terminal_options(),
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

    /// 在后台线程执行首次全量扫描，完成后通知前端刷新列表，
    /// 让窗口不必等待扫描结束即可显示。
    pub fn spawn_initial_scan(&self, app: &AppHandle) {
        let state = self.clone();
        let app = app.clone();
        std::thread::spawn(move || {
            if let Err(error) = state.refresh_and_emit(&app) {
                eprintln!("首次扫描会话失败：{error}");
            }
        });
    }

    fn scan_and_publish(
        &self,
        app: &AppHandle,
        paths: Option<&BTreeSet<PathBuf>>,
    ) -> Result<(), String> {
        let _scan = self.scan_lock.lock().map_err(lock_error)?;
        self.scan_locked(app, paths)
    }

    /// 调用方必须已持有 scan_lock（修改类路由在入口处获取）。
    /// 摘要扫描和全文索引构建都在独立的工作副本上进行，不持有界面
    /// 读取的会话锁；先发布摘要列表让界面立即可读，索引构建完成后
    /// 再短暂加锁把工作副本整体换入。
    pub fn scan_locked(
        &self,
        app: &AppHandle,
        paths: Option<&BTreeSet<PathBuf>>,
    ) -> Result<(), String> {
        self.search_indexing.store(true, Ordering::SeqCst);
        let started = Instant::now();
        *self.index_progress.lock().map_err(lock_error)? = json!({"phase":"scanning"});
        let result = (|| {
            let config = self.config.lock().map_err(lock_error)?.clone();
            let mut working = SessionStore::open(&config)?;
            if let Some(paths) = paths {
                {
                    let live = self.store.lock().map_err(lock_error)?;
                    working.publish_metadata_from(&live);
                }
                if !working.refresh_paths_metadata(paths)? {
                    return Ok(());
                }
            } else {
                working.refresh_metadata()?;
            }
            self.store
                .lock()
                .map_err(lock_error)?
                .publish_metadata_from(&working);
            self.sync_watcher_roots(app);
            app.emit("sessions-changed", json!({"type":"session-updated"}))
                .map_err(|e| e.to_string())?;
            let metadata_ms = started.elapsed().as_millis();
            let indexing = Instant::now();
            working.rebuild_search_index_with_progress(|processed, total| {
                // 进度使用独立锁，不等待会话列表锁或 SQLite 查询。
                *self.index_progress.lock().map_err(lock_error)? =
                    json!({"phase":"indexing", "processed":processed, "total":total});
                Ok(())
            })?;
            eprintln!(
                "工作区耗时：模式={}，摘要={}ms，索引={}ms",
                if paths.is_some() { "增量" } else { "全量" },
                metadata_ms,
                indexing.elapsed().as_millis()
            );
            *self.store.lock().map_err(lock_error)? = working;
            Ok::<(), String>(())
        })();
        *self.search_index_error.lock().map_err(lock_error)? = result.as_ref().err().cloned();
        self.search_indexing.store(false, Ordering::SeqCst);
        *self.index_progress.lock().map_err(lock_error)? = json!({
            "phase": if result.is_ok() { "ready" } else { "error" },
            "error": result.as_ref().err(),
            "elapsed_ms": started.elapsed().as_millis()
        });
        app.emit("sessions-changed", json!({"type":"session-updated"}))
            .map_err(|e| e.to_string())?;
        result
    }

    pub fn refresh_and_emit(&self, app: &AppHandle) -> Result<(), String> {
        self.scan_and_publish(app, None)
    }

    pub fn refresh_paths_and_emit(
        &self,
        app: &AppHandle,
        paths: &BTreeSet<PathBuf>,
    ) -> Result<(), String> {
        self.scan_and_publish(app, Some(paths))
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
) -> Result<Value, ApiError> {
    let backend = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || route_request(app, backend, request))
        .await
        .map_err(|error| ApiError::from(format!("后端任务异常结束：{error}")))?
}

fn route_request(
    app: AppHandle,
    state: BackendState,
    request: FrontendRequest,
) -> Result<Value, ApiError> {
    let parsed = Url::parse(&format!("http://allsessions.local{}", request.url))
        .map_err(|_| ApiError::invalid("请求地址无效"))?;
    let path = parsed.path();
    let query = parsed.query_pairs().into_owned().collect::<HashMap<_, _>>();
    let method = request.method.to_uppercase();

    // 修改来源或索引的操作与扫描串行；普通读取不等待全文索引。
    let _scan = if method == "POST"
        && matches!(
            path,
            "/api/settings"
                | "/api/settings/clear-cache"
                | "/api/sessions/delete"
                | "/api/sessions/delete-message"
        ) {
        Some(state.scan_lock.lock().map_err(lock_error)?)
    } else {
        None
    };

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
                .ok_or_else(|| ApiError::invalid("enabled 必须是布尔值"))?;
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
                return Err(ApiError::new(
                    ApiError::MAINTENANCE_DISABLED,
                    "Codex 维护模式未开启",
                ));
            }
            let _guard = state.maintenance_lock.lock().map_err(lock_error)?;
            if !state.maintenance_enabled.load(Ordering::SeqCst) {
                return Err(ApiError::new(
                    ApiError::MAINTENANCE_DISABLED,
                    "Codex 维护模式已关闭",
                ));
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
                _ => Err("不支持的维护请求".to_string()),
            }?;
            if path != "/api/codex-provider-migration/preview" {
                state.refresh_and_emit(&app)?;
            }
            Ok(result)
        }
        ("GET", "/api/sessions") => {
            if let Some(error) = state
                .search_index_error
                .lock()
                .map_err(lock_error)?
                .as_ref()
            {
                if state.store.lock().map_err(lock_error)?.scanning() {
                    return Err(ApiError::from(error.clone()));
                }
            }
            let workspace = state.workspace_snapshot()?;
            Ok(state
                .store
                .lock()
                .map_err(lock_error)?
                .list(&query, &workspace))
        }
        ("GET", "/api/search") => {
            let started = Instant::now();
            if let Some(error) = state
                .search_index_error
                .lock()
                .map_err(lock_error)?
                .as_ref()
            {
                return Err(ApiError::from(format!("全文索引构建失败：{error}")));
            }
            if query.get("q").is_none_or(|value| value.trim().is_empty()) {
                return Err(ApiError::invalid("缺少搜索内容"));
            }
            let workspace = state.workspace_snapshot()?;
            // 摘要快照在会话锁内快速取样；耗时的全文查询在锁外执行，
            // 搜索期间列表和详情读取不被阻塞。
            let plan = {
                let store = state.store.lock().map_err(lock_error)?;
                store.prepare_search(&query, &workspace)
            };
            let mut result = plan.search(&query, &workspace)?;
            eprintln!("搜索耗时：{}ms", started.elapsed().as_millis());
            result["scanning"] = json!(state.search_indexing.load(Ordering::SeqCst));
            Ok(result)
        }
        ("POST", "/api/sessions/delete") => {
            if request.body.get("confirmed").and_then(Value::as_bool) != Some(true) {
                return Err(ApiError::new(
                    ApiError::CONFIRMATION_REQUIRED,
                    "永久删除需要显式确认",
                ));
            }
            let session_key = request
                .body
                .get("sessionKey")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| ApiError::invalid("缺少 sessionKey"))?;
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
        ("POST", "/api/sessions/resume") => {
            let session_key = request
                .body
                .get("sessionKey")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| ApiError::invalid("缺少 sessionKey"))?;
            let summary = state
                .store
                .lock()
                .map_err(lock_error)?
                .summary_for_key(session_key)
                .ok_or_else(|| ApiError::new(ApiError::SESSION_NOT_FOUND, "会话不存在"))?;
            let (terminal, custom) = {
                let config = state.config.lock().map_err(lock_error)?;
                (
                    config.preferences.terminal_app.clone(),
                    config.preferences.terminal_custom.clone(),
                )
            };
            crate::resume::resume_session(&summary, &terminal, &custom)
        }
        ("POST", "/api/sessions/delete-message") => {
            if request.body.get("confirmed").and_then(Value::as_bool) != Some(true) {
                return Err(ApiError::new(
                    ApiError::CONFIRMATION_REQUIRED,
                    "永久删除需要显式确认",
                ));
            }
            let session_key = request
                .body
                .get("sessionKey")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| ApiError::invalid("缺少 sessionKey"))?;
            let message_key = request
                .body
                .get("messageKey")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| ApiError::invalid("缺少 messageKey"))?;
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
        ("GET", "/api/index-status") => {
            Ok(state.index_progress.lock().map_err(lock_error)?.clone())
        }
        ("GET", "/api/settings") => Ok(state.settings_payload(&app)?),
        ("GET", "/api/workspace") => Ok(state.workspace_snapshot()?.value()),
        ("POST", "/api/workspace/session") => Ok(state
            .workspace
            .lock()
            .map_err(lock_error)?
            .update_session(&request.body)?),
        ("POST", "/api/workspace/message") => Ok(state
            .workspace
            .lock()
            .map_err(lock_error)?
            .update_message(&request.body)?),
        ("POST", "/api/workspace/saved-filter") => Ok(state
            .workspace
            .lock()
            .map_err(lock_error)?
            .save_filter(&request.body)?),
        ("POST", "/api/workspace/saved-filter/delete") => Ok(state
            .workspace
            .lock()
            .map_err(lock_error)?
            .delete_filter(&request.body)?),
        ("POST", "/api/workspace/migrate-legacy") => Ok(state
            .workspace
            .lock()
            .map_err(lock_error)?
            .migrate_legacy(&request.body)?),
        ("POST", "/api/settings") => {
            let sources = config::parse_sources(
                request
                    .body
                    .get("sources")
                    .ok_or_else(|| ApiError::invalid("缺少 sources 字段"))?,
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
            drop(config);
            state.clear_startup_error()?;
            // 来源可能已变化，重扫复用后台路径（发布摘要在前、索引重建在后），
            // 不在会话锁内做全量刷新。设置保存本身已成功，重扫失败只记录到
            // 索引状态并在 /api/search 上报，不当作保存失败。
            if let Err(error) = state.scan_locked(&app, None) {
                eprintln!("保存设置后的会话重扫失败：{error}");
            }
            Ok(state.settings_payload(&app)?)
        }
        ("POST", "/api/settings/preferences") => {
            let preferences = config::parse_preferences(
                request
                    .body
                    .get("preferences")
                    .ok_or_else(|| ApiError::invalid("缺少 preferences 字段"))?,
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
            Ok(state.settings_payload(&app)?)
        }
        ("POST", "/api/settings/clear-cache") => {
            state.store.lock().map_err(lock_error)?.clear_index_cache();
            // 清空后需要全量重扫和索引重建，同样走后台路径避免阻塞界面读取。
            state.scan_locked(&app, None)?;
            Ok(state.settings_payload(&app)?)
        }
        ("POST", "/api/settings/check-update") => {
            updater::check_for_updates(app);
            Ok(json!({ "ok": true }))
        }
        ("POST", "/api/settings/install-update") => {
            updater::install_update(app)?;
            Ok(json!({ "ok": true }))
        }
        ("POST", "/api/settings/update-ready") => {
            if !cfg!(debug_assertions) && state.check_updates_on_startup()? {
                updater::check_for_updates_silently(app);
            }
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
                .map_err(|_| ApiError::invalid("会话 ID 编码无效"))?;
            let mut store = state.store.lock().map_err(lock_error)?;
            let mut detail = if let Some(around) = query.get("around") {
                let ordinal = around
                    .parse::<i64>()
                    .map_err(|_| ApiError::invalid("消息位置无效"))?;
                store.search_context(
                    &key,
                    ordinal,
                    query.get("message").map(String::as_str),
                    query.get("term").map(String::as_str).unwrap_or_default(),
                )?
            } else {
                store
                    .detail(&key)
                    .ok_or_else(|| ApiError::new(ApiError::SESSION_NOT_FOUND, "会话不存在"))?
            };
            drop(store);
            state.workspace_snapshot()?.decorate_detail(&mut detail);
            Ok(detail)
        }
        _ => Err(ApiError::invalid(format!("不支持的请求：{method} {path}"))),
    }
}

fn lock_error<T>(_: std::sync::PoisonError<T>) -> String {
    "应用内部状态已损坏".into()
}
