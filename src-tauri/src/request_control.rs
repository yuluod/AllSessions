//! 只读 IPC 的协作取消。令牌仅在当前阻塞任务线程内生效，不影响扫描和写入。
use crate::error::ApiError;
use std::{
    cell::RefCell,
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

#[derive(Default)]
pub struct ReadRequests {
    active: HashMap<String, Arc<AtomicBool>>,
    early: HashMap<String, Instant>,
}
thread_local! { static CURRENT: RefCell<Option<Arc<AtomicBool>>> = const { RefCell::new(None) }; }

impl ReadRequests {
    pub fn register(&mut self, id: &str) -> Result<Arc<AtomicBool>, ApiError> {
        self.early
            .retain(|_, time| time.elapsed() < Duration::from_secs(30));
        if id.is_empty()
            || id.len() > 128
            || self.active.contains_key(id)
            || self.active.len() >= 64
        {
            return Err(ApiError::invalid("只读请求标识无效或并发过多"));
        }
        let token = Arc::new(AtomicBool::new(self.early.remove(id).is_some()));
        self.active.insert(id.into(), token.clone());
        Ok(token)
    }
    pub fn cancel(&mut self, id: &str) {
        if let Some(token) = self.active.get(id) {
            token.store(true, Ordering::Relaxed);
        } else if !id.is_empty() && id.len() <= 128 {
            self.early
                .retain(|_, time| time.elapsed() < Duration::from_secs(30));
            if self.early.len() < 128 {
                self.early.insert(id.into(), Instant::now());
            }
        }
    }
}

pub fn cancelled_error() -> ApiError {
    ApiError::new("request_cancelled", "请求已取消")
}

// 显式开启时仅输出固定阶段名与耗时，不输出文件路径、查询词或正文。
pub fn trace_duration(stage: &'static str, started: Instant) {
    if std::env::var_os("ALLSESSIONS_PERF").is_some() {
        eprintln!("perf {stage} {}us", started.elapsed().as_micros());
    }
}
pub fn check() -> Result<(), String> {
    if CURRENT.with(|slot| {
        slot.borrow()
            .as_ref()
            .is_some_and(|token| token.load(Ordering::Relaxed))
    }) {
        Err("请求已取消".into())
    } else {
        Ok(())
    }
}

pub struct ReadGuard {
    registry: Arc<Mutex<ReadRequests>>,
    id: String,
    token: Arc<AtomicBool>,
    previous: Option<Arc<AtomicBool>>,
}
impl ReadGuard {
    pub fn enter(registry: Arc<Mutex<ReadRequests>>, id: String, token: Arc<AtomicBool>) -> Self {
        let previous = CURRENT.with(|slot| slot.replace(Some(token.clone())));
        Self {
            registry,
            id,
            token,
            previous,
        }
    }
    pub fn cancelled(&self) -> bool {
        self.token.load(Ordering::Relaxed)
    }
}
impl Drop for ReadGuard {
    fn drop(&mut self) {
        CURRENT.with(|slot| slot.replace(self.previous.take()));
        if let Ok(mut registry) = self.registry.lock() {
            registry.active.remove(&self.id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancellation_before_registration_and_task_cleanup() {
        let registry = Arc::new(Mutex::new(ReadRequests::default()));
        registry.lock().unwrap().cancel("early");
        let token = registry.lock().unwrap().register("early").unwrap();
        {
            let guard = ReadGuard::enter(registry.clone(), "early".into(), token);
            assert!(guard.cancelled());
            assert!(check().is_err());
        }
        assert!(check().is_ok());
        assert!(registry.lock().unwrap().active.is_empty());
    }
    #[test]
    fn cancellation_is_local_to_registered_reader() {
        let registry = Arc::new(Mutex::new(ReadRequests::default()));
        let token = registry.lock().unwrap().register("one").unwrap();
        let guard = ReadGuard::enter(registry.clone(), "one".into(), token);
        registry.lock().unwrap().cancel("other");
        assert!(!guard.cancelled());
        registry.lock().unwrap().cancel("one");
        assert!(check().is_err());
        assert!(std::thread::spawn(check).join().unwrap().is_ok());
    }
}
