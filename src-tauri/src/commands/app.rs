use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::error::AppResult;
use crate::state::AppState;

#[derive(Serialize)]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub platform: String,
    pub arch: String,
    pub data_dir: String,
    pub log_dir: String,
}

#[tauri::command]
pub fn get_app_info(app: AppHandle) -> AppResult<AppInfo> {
    let package = app.package_info();
    let data_dir = app.path().app_data_dir()?;
    let log_dir = app.path().app_log_dir()?;
    Ok(AppInfo {
        name: app
            .config()
            .product_name
            .clone()
            .unwrap_or_else(|| package.name.clone()),
        version: package.version.to_string(),
        platform: std::env::consts::OS.into(),
        arch: std::env::consts::ARCH.into(),
        data_dir: data_dir.to_string_lossy().into_owned(),
        log_dir: log_dir.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub fn get_setting(state: State<AppState>, key: String) -> AppResult<Option<String>> {
    state.meta.get_setting(&key)
}

#[tauri::command]
pub fn set_setting(state: State<AppState>, key: String, value: String) -> AppResult<()> {
    state.meta.set_setting(&key, &value)
}
