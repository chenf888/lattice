//! 后台任务注册表：导入/导出等长任务的取消标志与生命周期管理。
//! 任务取消为协作式（批次/行间检查标志）；硬中断仅由驱动层自身处理。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub type StopFlag = Arc<std::sync::atomic::AtomicBool>;

struct TaskEntry {
    cancel: StopFlag,
}

#[derive(Default)]
pub struct TaskRegistry {
    slots: Mutex<HashMap<String, TaskEntry>>,
}

impl TaskRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&self, task_id: &str, cancel: StopFlag) {
        if let Ok(mut slots) = self.slots.lock() {
            slots.insert(task_id.to_owned(), TaskEntry { cancel });
        }
    }

    pub fn unregister(&self, task_id: &str) {
        if let Ok(mut slots) = self.slots.lock() {
            slots.remove(task_id);
        }
    }

    /// 置位停止标志；返回是否命中活动任务
    pub fn cancel(&self, task_id: &str) -> bool {
        use std::sync::atomic::Ordering;
        let entry = match self.slots.lock() {
            Ok(mut slots) => slots.remove(task_id),
            Err(_) => None,
        };
        match entry {
            Some(entry) => {
                entry.cancel.store(true, Ordering::Relaxed);
                true
            }
            None => false,
        }
    }

    #[cfg(test)]
    pub fn is_running(&self, task_id: &str) -> bool {
        self.slots
            .lock()
            .map(|slots| slots.contains_key(task_id))
            .unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    #[test]
    fn register_cancel_roundtrip() {
        let registry = TaskRegistry::new();
        let stop: StopFlag = Arc::new(AtomicBool::new(false));
        registry.register("t1", Arc::clone(&stop));
        assert!(registry.is_running("t1"));
        assert!(registry.cancel("t1"));
        assert!(stop.load(std::sync::atomic::Ordering::Relaxed));
        assert!(!registry.is_running("t1"));
        assert!(!registry.cancel("t1")); // 已注销
    }

    #[test]
    fn unregister_removes_without_cancel() {
        let registry = TaskRegistry::new();
        let stop: StopFlag = Arc::new(AtomicBool::new(false));
        registry.register("t2", stop);
        registry.unregister("t2");
        assert!(!registry.is_running("t2"));
        assert!(!registry.cancel("t2"));
    }
}
