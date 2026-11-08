//! 查询执行注册表：按 queryId 维护取消句柄（PG CancelToken / MySQL 任务
//! 中止 / SQLite InterruptHandle）与协作停止标志。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// 协作停止标志：sink 与语句间隙检查；配合各驱动的硬取消手段
pub type StopFlag = Arc<std::sync::atomic::AtomicBool>;

pub enum CancelKind {
    /// PG：通过 CancelToken 向服务端发送取消
    Postgres(crate::db::postgres::PostgresDriver),
    /// MySQL：中止持有查询的任务（连接随之丢弃）
    Mysql(tokio::task::AbortHandle),
    /// SQLite：中断当前语句执行
    Sqlite(rusqlite::InterruptHandle),
}

struct QueryEntry {
    stop: StopFlag,
    kind: CancelKind,
}

/// 线程安全的注册表（命令与执行任务共享）
#[derive(Default)]
pub struct ExecutionRegistry {
    slots: Mutex<HashMap<String, QueryEntry>>,
}

impl ExecutionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&self, query_id: &str, stop: StopFlag, kind: CancelKind) {
        if let Ok(mut slots) = self.slots.lock() {
            slots.insert(
                query_id.to_owned(),
                QueryEntry {
                    stop,
                    kind,
                },
            );
        }
    }

    pub fn unregister(&self, query_id: &str) {
        if let Ok(mut slots) = self.slots.lock() {
            slots.remove(query_id);
        }
    }

    /// 取消：置位停止标志 + 按驱动触发硬取消。返回是否命中活动查询
    pub fn cancel(&self, query_id: &str) -> Option<StopFlag> {
        use std::sync::atomic::Ordering;
        let entry = {
            let mut slots = self.slots.lock().ok()?;
            slots.remove(query_id)?
        };
        entry.stop.store(true, Ordering::Relaxed);
        match entry.kind {
            CancelKind::Postgres(driver) => {
                let driver = driver;
                tokio::spawn(async move {
                    if let Err(err) = driver.cancel().await {
                        log::warn!("pg 取消请求失败：{err}");
                    }
                });
            }
            CancelKind::Mysql(task) => task.abort(),
            CancelKind::Sqlite(interrupt) => interrupt.interrupt(),
        }
        Some(entry.stop)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    #[test]
    fn register_cancel_unregister_roundtrip() {
        let registry = ExecutionRegistry::new();
        let stop: StopFlag = Arc::new(AtomicBool::new(false));
        registry.register("q1", Arc::clone(&stop), CancelKind::Sqlite(
            // 真实句柄需连接；此处以占位连接构造后立即取消不影响断言
            rusqlite::Connection::open_in_memory()
                .unwrap()
                .get_interrupt_handle(),
        ));
        let flag = registry.cancel("q1").expect("应命中活动查询");
        assert!(flag.load(std::sync::atomic::Ordering::Relaxed));
        assert!(stop.load(std::sync::atomic::Ordering::Relaxed));
        // 二次取消：已注销
        assert!(registry.cancel("q1").is_none());
        assert!(registry.cancel("missing").is_none());
    }

    #[test]
    fn unregister_removes_entry() {
        let registry = ExecutionRegistry::new();
        let stop: StopFlag = Arc::new(AtomicBool::new(false));
        registry.register("q2", stop, CancelKind::Sqlite(
            rusqlite::Connection::open_in_memory()
                .unwrap()
                .get_interrupt_handle(),
        ));
        registry.unregister("q2");
        assert!(registry.cancel("q2").is_none());
    }
}
