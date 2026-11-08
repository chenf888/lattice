use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::driver::DatabaseDriver as _;
use crate::db::postgres::{PostgresDriver, TestError, CONNECT_TIMEOUT};
use crate::db::ConnectionMeta;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::store::meta::{new_id, ConnectionRow};
use crate::store::secrets;

const SSL_MODES: [&str; 5] = ["disable", "prefer", "require", "verify-ca", "verify-full"];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInput {
    pub name: String,
    pub driver: String,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub username: String,
    pub password: Option<String>,
    pub ssl_mode: String,
    pub color: Option<String>,
    pub group_name: Option<String>,
    pub read_only: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionSummary {
    pub id: String,
    pub name: String,
    pub driver: String,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub database: Option<String>,
    pub username: Option<String>,
    pub ssl_mode: Option<String>,
    pub color: Option<String>,
    pub group_name: Option<String>,
    pub read_only: bool,
    pub favorite: bool,
    pub connected: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub ok: bool,
    pub latency_ms: u64,
    pub error: Option<TestError>,
}

fn validate_input(input: &ConnectionInput) -> AppResult<()> {
    if input.name.trim().is_empty() {
        return Err(AppError::Input("连接名称不能为空".into()));
    }
    match input.driver.as_str() {
        "postgres" | "mysql" => {
            if !SSL_MODES.contains(&input.ssl_mode.as_str()) {
                return Err(AppError::Input(format!("非法 SSL 模式：{}", input.ssl_mode)));
            }
            if input.host.trim().is_empty() {
                return Err(AppError::Input("主机不能为空".into()));
            }
            if input.username.trim().is_empty() {
                return Err(AppError::Input("用户名不能为空".into()));
            }
            if input.database.trim().is_empty() {
                return Err(AppError::Input("数据库名不能为空".into()));
            }
        }
        "sqlite" => {
            if input.database.trim().is_empty() {
                return Err(AppError::Input("数据库文件路径不能为空".into()));
            }
        }
        other => {
            return Err(AppError::Input(format!("不支持的驱动：{other}")));
        }
    }
    Ok(())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn row_from_input(id: String, input: &ConnectionInput, previous: Option<&ConnectionRow>) -> ConnectionRow {
    let now = now_ms();
    ConnectionRow {
        id,
        name: input.name.trim().to_owned(),
        driver: input.driver.clone(),
        host: Some(input.host.trim().to_owned()),
        port: Some(i64::from(input.port)),
        database: Some(input.database.trim().to_owned()),
        username: Some(input.username.trim().to_owned()),
        ssl_mode: Some(input.ssl_mode.clone()),
        color: input.color.clone(),
        group_name: input
            .group_name
            .as_deref()
            .map(str::trim)
            .filter(|group| !group.is_empty())
            .map(ToOwned::to_owned),
        read_only: input.read_only,
        created_at: previous.map_or(now, |row| row.created_at),
        updated_at: now,
    }
}

fn summary(row: &ConnectionRow, favorite: bool, connected: bool) -> ConnectionSummary {
    ConnectionSummary {
        id: row.id.clone(),
        name: row.name.clone(),
        driver: row.driver.clone(),
        host: row.host.clone(),
        port: row.port.and_then(|port| u16::try_from(port).ok()),
        database: row.database.clone(),
        username: row.username.clone(),
        ssl_mode: row.ssl_mode.clone(),
        color: row.color.clone(),
        group_name: row.group_name.clone(),
        read_only: row.read_only,
        favorite,
        connected,
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

fn require_row(state: &AppState, id: &str) -> AppResult<ConnectionRow> {
    state
        .meta
        .get_connection(id)?
        .ok_or_else(|| AppError::NotFound(format!("连接 {id}")))
}

#[tauri::command]
pub async fn list_connections(state: State<'_, AppState>) -> AppResult<Vec<ConnectionSummary>> {
    let rows = state.meta.list_connections()?;
    let mut out = Vec::with_capacity(rows.len());
    for row in &rows {
        let favorite = state.meta.is_favorite(&row.id)?;
        let connected = state.connections.is_connected(&row.id).await;
        out.push(summary(row, favorite, connected));
    }
    Ok(out)
}

#[tauri::command]
pub async fn create_connection(
    state: State<'_, AppState>,
    input: ConnectionInput,
) -> AppResult<ConnectionSummary> {
    validate_input(&input)?;
    let row = row_from_input(new_id("conn"), &input, None);
    state.meta.insert_connection(&row)?;
    if let Some(password) = input.password.as_deref().filter(|p| !p.is_empty()) {
        if let Err(err) = secrets::save_password(&row.id, password) {
            let _ = state.meta.delete_connection(&row.id); // 回滚半成品
            return Err(err);
        }
    }
    Ok(summary(&row, false, false))
}

#[tauri::command]
pub async fn update_connection(
    state: State<'_, AppState>,
    id: String,
    input: ConnectionInput,
) -> AppResult<ConnectionSummary> {
    validate_input(&input)?;
    let previous = require_row(&state, &id)?;
    let row = row_from_input(id.clone(), &input, Some(&previous));
    state.meta.update_connection(&row)?;
    if let Some(password) = input.password.as_deref().filter(|p| !p.is_empty()) {
        secrets::save_password(&id, password)?;
    }
    // 配置已变更，旧句柄整体失效；下次浏览/执行时重建
    state.connections.disconnect(&id).await?;
    let favorite = state.meta.is_favorite(&id)?;
    let connected = state.connections.is_connected(&id).await;
    Ok(summary(&row, favorite, connected))
}

#[tauri::command]
pub async fn delete_connection(state: State<'_, AppState>, id: String) -> AppResult<()> {
    require_row(&state, &id)?;
    state.connections.disconnect(&id).await?;
    secrets::delete_password(&id)?;
    state.meta.set_connection_favorite(&id, false)?;
    state.meta.delete_connection(&id)?;
    Ok(())
}

#[tauri::command]
pub async fn set_connection_favorite(
    state: State<'_, AppState>,
    id: String,
    favorite: bool,
) -> AppResult<ConnectionSummary> {
    let row = require_row(&state, &id)?;
    state.meta.set_connection_favorite(&id, favorite)?;
    let connected = state.connections.is_connected(&id).await;
    Ok(summary(&row, favorite, connected))
}

#[tauri::command]
pub async fn test_connection(input: ConnectionInput, id: Option<String>) -> AppResult<TestResult> {
    validate_input(&input)?;
    let started = std::time::Instant::now();
    let latency_ms = || {
        u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
    };

    if input.driver == "sqlite" {
        return match crate::db::sqlite::SqliteDriver::connect(input.database.trim(), false) {
            Ok(driver) => match driver.ping().await {
                Ok(()) => Ok(TestResult { ok: true, latency_ms: latency_ms(), error: None }),
                Err(err) => Ok(TestResult {
                    ok: false,
                    latency_ms: latency_ms(),
                    error: Some(TestError {
                        kind: crate::db::postgres::TestErrorKind::Unknown,
                        message: err.to_string(),
                    }),
                }),
            },
            Err(err) => Ok(TestResult {
                ok: false,
                latency_ms: latency_ms(),
                error: Some(TestError {
                    kind: crate::db::postgres::TestErrorKind::Database,
                    message: err.to_string(),
                }),
            }),
        };
    }

    let password = match input.password.as_deref().filter(|p| !p.is_empty()) {
        Some(password) => password.to_owned(),
        // 编辑态密码留空：沿用已保存凭据
        None => {
            let saved = match id.as_deref() {
                Some(saved_id) => secrets::load_password(saved_id)?,
                None => None,
            };
            saved.ok_or_else(|| AppError::Input("请填写密码，或先保存该连接".into()))?
        }
    };
    let row = row_from_input("test".to_owned(), &input, None);
    let meta = ConnectionMeta::from_row_with_default_port(
        &row,
        input.database.trim(),
        if input.driver == "mysql" { 3306 } else { 5432 },
    );
    let result = match input.driver.as_str() {
        "mysql" => crate::db::mysql::MysqlDriver::connect(&meta, &password, CONNECT_TIMEOUT)
            .await
            .map(|_| ()),
        _ => PostgresDriver::connect(&meta, &password, CONNECT_TIMEOUT)
            .await
            .map(|_| ()),
    };
    match result {
        Ok(()) => Ok(TestResult {
            ok: true,
            latency_ms: latency_ms(),
            error: None,
        }),
        Err(classified) => Ok(TestResult {
            ok: false,
            latency_ms: latency_ms(),
            error: Some(TestError::from(classified)),
        }),
    }
}

#[tauri::command]
pub async fn connect_database(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let row = require_row(&state, &id)?;
    let database = row.database.clone().unwrap_or_else(|| "postgres".into());
    state.connections.get_or_connect(&row, &database).await?;
    Ok(())
}

#[tauri::command]
pub async fn disconnect_database(state: State<'_, AppState>, id: String) -> AppResult<()> {
    require_row(&state, &id)?;
    state.connections.disconnect(&id).await?;
    Ok(())
}
