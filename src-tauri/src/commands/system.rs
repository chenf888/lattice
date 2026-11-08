//! 系统级命令：重启、打开日志目录、更新检查（占位）。

use serde::Serialize;
use tauri::AppHandle;

use crate::error::{AppError, AppResult};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current: String,
    pub latest: String,
    pub has_update: bool,
    /// 占位说明：更新源接入前始终报告已是最新
    pub note: String,
}

fn open_path(path: &std::path::Path) -> AppResult<()> {
    #[cfg(target_os = "windows")]
    let spawn = std::process::Command::new("explorer").arg(path).spawn();
    #[cfg(target_os = "macos")]
    let spawn = std::process::Command::new("open").arg(path).spawn();
    #[cfg(target_os = "linux")]
    let spawn = std::process::Command::new("xdg-open").arg(path).spawn();
    spawn.map(|_| ()).map_err(|err| {
        AppError::Io(std::io::Error::new(
            err.kind(),
            format!("打开目录失败：{err}"),
        ))
    })
}

/// 重启应用（tauri v2 进程级重启）
#[tauri::command]
pub fn restart_app(app: AppHandle) {
    app.restart();
}

#[tauri::command]
pub async fn open_log_dir() -> AppResult<()> {
    let dir = crate::state::data_root().join("logs");
    std::fs::create_dir_all(&dir)?;
    open_path(&dir)
}

#[tauri::command]
pub async fn open_data_dir() -> AppResult<()> {
    let dir = crate::state::data_root();
    open_path(&dir)
}

/// 更新检查（占位实现）：UI 流程完整；真实更新源接入后替换 latest/has_update 逻辑
#[tauri::command]
pub async fn check_update(app: AppHandle) -> AppResult<UpdateInfo> {
    let current = app.package_info().version.to_string();
    Ok(UpdateInfo {
        latest: current.clone(),
        current,
        has_update: false,
        note: "更新检查为占位实现：当前已是最新版本".into(),
    })
}
