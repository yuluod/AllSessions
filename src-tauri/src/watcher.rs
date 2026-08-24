use std::{
    collections::BTreeSet,
    path::PathBuf,
    sync::{mpsc, Mutex},
    thread,
    time::Duration,
};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::backend::BackendState;

pub struct WatcherState {
    sender: mpsc::Sender<PathBuf>,
    watcher: Mutex<Option<(RecommendedWatcher, Vec<PathBuf>)>>,
    last_error: Mutex<Option<String>>,
}

impl WatcherState {
    /// 重新注册监听目录。新 watcher 注册成功后才替换旧 watcher，
    /// 失败时保留原有监听不变。
    /// 目录与当前一致时直接跳过，避免重复重建 watcher。
    pub fn rewatch(&self, roots: &[PathBuf]) -> Result<(), String> {
        let mut guard = self
            .watcher
            .lock()
            .map_err(|_| "文件监听状态已损坏".to_string())?;
        if let Some((_, watched)) = guard.as_ref() {
            if watched.as_slice() == roots {
                *self
                    .last_error
                    .lock()
                    .map_err(|_| "文件监听错误状态已损坏".to_string())? = None;
                return Ok(());
            }
        }
        match arm_watcher(&self.sender, roots) {
            Ok(next) => {
                *guard = Some(next);
                *self
                    .last_error
                    .lock()
                    .map_err(|_| "文件监听错误状态已损坏".to_string())? = None;
                Ok(())
            }
            Err(error) => {
                *self
                    .last_error
                    .lock()
                    .map_err(|_| "文件监听错误状态已损坏".to_string())? = Some(error.clone());
                Err(error)
            }
        }
    }

    pub fn status(&self) -> Value {
        let (active, root_count) = self
            .watcher
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().map(|(_, roots)| (true, roots.len())))
            .unwrap_or((false, 0));
        let last_error = self.last_error.lock().ok().and_then(|value| value.clone());
        json!({
            "active": active,
            "root_count": root_count,
            "last_error": last_error,
        })
    }
}

fn arm_watcher(
    sender: &mpsc::Sender<PathBuf>,
    roots: &[PathBuf],
) -> Result<(RecommendedWatcher, Vec<PathBuf>), String> {
    let event_sender = sender.clone();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        if let Ok(event) = event {
            for path in event.paths {
                let _ = event_sender.send(path);
            }
        }
    })
    .map_err(|error| error.to_string())?;
    let mut watched = Vec::new();
    for root in roots {
        watcher
            .watch(root, RecursiveMode::Recursive)
            .map_err(|error| format!("无法监听会话目录 {}：{error}", root.display()))?;
        watched.push(root.clone());
    }
    Ok((watcher, watched))
}

/// 启动监听。注册失败只记录告警并返回未 armed 的状态（应用仍可启动，
/// 后续重新保存设置时会再次尝试），避免坏配置让应用无法完成初始化。
pub fn start(app: &AppHandle) -> WatcherState {
    let roots = app
        .state::<BackendState>()
        .watch_roots()
        .unwrap_or_else(|error| {
            eprintln!("获取会话监听目录失败：{error}");
            Vec::new()
        });
    let (sender, receiver) = mpsc::channel();
    let (watcher, last_error) = match arm_watcher(&sender, &roots) {
        Ok(watcher) => (Some(watcher), None),
        Err(error) => {
            eprintln!("启动文件监听失败（会话变更将不会自动刷新）：{error}");
            (None, Some(error))
        }
    };

    let app_handle = app.clone();
    thread::spawn(move || {
        while let Ok(first_path) = receiver.recv() {
            let mut paths = BTreeSet::<PathBuf>::from([first_path]);
            while let Ok(path) = receiver.recv_timeout(Duration::from_millis(350)) {
                paths.insert(path);
            }
            if let Err(error) = app_handle
                .state::<BackendState>()
                .refresh_paths_and_emit(&app_handle, &paths)
            {
                eprintln!("刷新会话失败：{error}");
            }
        }
    });
    WatcherState {
        sender,
        watcher: Mutex::new(watcher),
        last_error: Mutex::new(last_error),
    }
}
