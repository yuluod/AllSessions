use std::{
    collections::BTreeSet,
    path::PathBuf,
    sync::{mpsc, Mutex},
    thread,
    time::Duration,
};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Manager};

use crate::backend::BackendState;

pub struct WatcherState {
    _watcher: Mutex<RecommendedWatcher>,
}

pub fn start(app: &AppHandle) -> Result<WatcherState, String> {
    let roots = app.state::<BackendState>().watch_roots()?;
    let (sender, receiver) = mpsc::channel();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        if let Ok(event) = event {
            for path in event.paths {
                let _ = sender.send(path);
            }
        }
    })
    .map_err(|error| error.to_string())?;
    for root in roots {
        watcher
            .watch(&root, RecursiveMode::Recursive)
            .map_err(|error| format!("无法监听会话目录 {}：{error}", root.display()))?;
    }

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
    Ok(WatcherState {
        _watcher: Mutex::new(watcher),
    })
}
