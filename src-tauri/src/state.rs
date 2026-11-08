use std::sync::Arc;

use crate::db::execution::ExecutionRegistry;
use crate::db::manager::ConnectionManager;
use crate::store::meta::MetaStore;
use crate::tasks::TaskRegistry;

/// 全局托管状态：meta/queries/tasks 为 Arc 以便后台任务克隆到 'static
pub struct AppState {
    pub meta: Arc<MetaStore>,
    pub connections: ConnectionManager,
    pub queries: Arc<ExecutionRegistry>,
    pub tasks: Arc<TaskRegistry>,
}

static DATA_ROOT: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

/// setup 时记录数据根目录（日志目录打开等使用）
pub fn set_data_root(path: std::path::PathBuf) {
    let _ = DATA_ROOT.set(path);
}

pub fn data_root() -> std::path::PathBuf {
    DATA_ROOT.get().cloned().unwrap_or_else(|| std::path::PathBuf::from("."))
}
