//! 查询执行命令：execute_query 立即返回并后台流式执行（事件分批推送），
//! cancel_query 按驱动触发取消，describe_table 供补全与阶段四复用。

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::db::driver::{Cell, ColumnMeta, DriverHandle, RowSink};
use crate::db::execution::{CancelKind, ExecutionRegistry, StopFlag};
use crate::db::sql_split::split_statements;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::store::meta::new_id;

pub const BATCH_SIZE: usize = 500;
/// max_rows 缺省值（设置键 query.max_rows 阶段五出 UI 前的固定默认）
pub const DEFAULT_MAX_ROWS: usize = 50_000;
const MAX_ROWS_LIMIT: usize = 1_000_000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryStarted {
    pub query_id: String,
    pub statement_count: usize,
    /// 全部语句均为纯读取（截断后「加载更多」可安全重跑）
    pub rerunnable: bool,
}

// ── 事件载荷（camelCase；与前端类型镜像）──────────────────────

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct StartedPayload {
    query_id: String,
    statement_count: usize,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ColumnsPayload {
    query_id: String,
    statement_index: usize,
    columns: Vec<ColumnMeta>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RowsPayload {
    query_id: String,
    statement_index: usize,
    rows: Vec<Vec<Cell>>,
    batch_index: usize,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct StatementPayload {
    query_id: String,
    statement_index: usize,
    status: &'static str, // ok | error | cancelled
    rows: u64,
    rows_affected: u64,
    truncated: bool,
    duration_ms: u64,
    error: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DonePayload {
    query_id: String,
    status: &'static str, // completed | cancelled | error
    error: Option<String>,
    duration_ms: u64,
}

fn emit(app: &AppHandle, event: &str, payload: &impl Serialize) {
    if let Err(err) = app.emit(event, payload) {
        log::warn!("事件 {event} 发送失败：{err}");
    }
}

/// sink：把行批次转成 query:rows 事件；stop 置位后叫停驱动拉取
struct EventSink {
    app: AppHandle,
    query_id: String,
    statement_index: usize,
    batch_index: usize,
    stop: StopFlag,
}

impl RowSink for EventSink {
    fn columns(&mut self, columns: Vec<ColumnMeta>) {
        self.batch_index = 0;
        emit(
            &self.app,
            "query:columns",
            &ColumnsPayload {
                query_id: self.query_id.clone(),
                statement_index: self.statement_index,
                columns,
            },
        );
    }

    fn rows(&mut self, rows: Vec<Vec<Cell>>) -> bool {
        if self.stop.load(std::sync::atomic::Ordering::Relaxed) {
            return false;
        }
        emit(
            &self.app,
            "query:rows",
            &RowsPayload {
                query_id: self.query_id.clone(),
                statement_index: self.statement_index,
                rows,
                batch_index: self.batch_index,
            },
        );
        self.batch_index += 1;
        true
    }
}

/// max_rows：入参 0/None → 设置 query.max_rows 或默认值，夹取合法区间
fn resolve_max_rows(meta: &crate::store::meta::MetaStore, max_rows: Option<i64>) -> AppResult<usize> {
    let value = match max_rows {
        Some(v) if v > 0 => v,
        _ => meta
            .get_setting("query.max_rows")?
            .and_then(|raw| raw.parse::<i64>().ok())
            .filter(|v| *v > 0)
            .unwrap_or(DEFAULT_MAX_ROWS as i64),
    };
    usize::try_from(value)
        .ok()
        .map(|v| v.min(MAX_ROWS_LIMIT))
        .ok_or_else(|| AppError::Input("max_rows 超出范围".into()))
}

#[allow(clippy::too_many_arguments)]
fn write_history(
    meta: &crate::store::meta::MetaStore,
    query_id: &str,
    connection_id: &str,
    sql: &str,
    status: &str,
    rows: u64,
    duration_ms: u64,
    error: Option<&str>,
) {
    let record = crate::store::meta::HistoryRecord {
        id: new_id("qh"),
        connection_id: connection_id.to_owned(),
        sql: sql.to_owned(),
        status: status.to_owned(),
        rows: Some(i64::try_from(rows).unwrap_or(0)),
        duration_ms: Some(i64::try_from(duration_ms).unwrap_or(0)),
        error: error.map(ToOwned::to_owned),
    };
    if let Err(err) = meta.insert_query_history(&record) {
        log::warn!("query_history 写入失败（query={query_id}）：{err}");
    }
}

/// 语句循环：逐条执行，失败即停；只发逐语句事件，历史与 done 由外层统一。
/// timeout 到点后触发注册表硬取消并返回超时错误。
#[allow(clippy::too_many_arguments)]
async fn statement_loop(
    app: AppHandle,
    query_id: String,
    registry: std::sync::Arc<ExecutionRegistry>,
    handle: DriverHandle,
    statements: Vec<String>,
    max_rows: usize,
    timeout: Option<std::time::Duration>,
    stop: StopFlag,
) -> (&'static str, Option<String>, u64) {
    use std::sync::atomic::Ordering;

    let mut total_rows: u64 = 0;
    for (index, statement_sql) in statements.iter().enumerate() {
        if stop.load(Ordering::Relaxed) {
            break;
        }
        let mut sink = EventSink {
            app: app.clone(),
            query_id: query_id.clone(),
            statement_index: index,
            batch_index: 0,
            stop: stop.clone(),
        };
        let execution = handle.execute(statement_sql, max_rows, BATCH_SIZE, &mut sink);
        let outcome = match timeout {
            Some(limit) => match tokio::time::timeout(limit, execution).await {
                Ok(result) => result,
                Err(_) => {
                    registry.cancel(&query_id);
                    return (
                        "error",
                        Some(format!("查询超时（{}秒），已发送取消", limit.as_secs())),
                        total_rows,
                    );
                }
            },
            None => execution.await,
        };
        match outcome {
            Ok(outcome) => {
                let cancelled = stop.load(Ordering::Relaxed);
                total_rows += outcome.rows_total;
                emit(
                    &app,
                    "query:statement",
                    &StatementPayload {
                        query_id: query_id.clone(),
                        statement_index: index,
                        status: if cancelled { "cancelled" } else { "ok" },
                        rows: outcome.rows_total,
                        rows_affected: outcome.rows_affected,
                        truncated: outcome.truncated,
                        duration_ms: outcome.duration_ms,
                        error: None,
                    },
                );
                if cancelled {
                    break;
                }
            }
            Err(err) => {
                let cancelled =
                    matches!(err, AppError::Cancelled) || stop.load(Ordering::Relaxed);
                let message = err.to_string();
                emit(
                    &app,
                    "query:statement",
                    &StatementPayload {
                        query_id: query_id.clone(),
                        statement_index: index,
                        status: if cancelled { "cancelled" } else { "error" },
                        rows: 0,
                        rows_affected: 0,
                        truncated: false,
                        duration_ms: 0,
                        error: if cancelled { None } else { Some(message.clone()) },
                    },
                );
                if cancelled {
                    return ("cancelled", None, total_rows);
                }
                return ("error", Some(message), total_rows);
            }
        }
    }
    if stop.load(Ordering::Relaxed) {
        ("cancelled", None, total_rows)
    } else {
        ("completed", None, total_rows)
    }
}

/// 后台执行任务：注册取消句柄 → 语句循环 → 写历史 + done 事件。
/// MySQL 走内层任务（取消 = abort 内层，经 JoinError 捕获后同样收尾）。
#[allow(clippy::too_many_arguments)]
async fn run_execution(
    meta: std::sync::Arc<crate::store::meta::MetaStore>,
    registry: std::sync::Arc<ExecutionRegistry>,
    app: AppHandle,
    query_id: String,
    connection_id: String,
    sql: String,
    statements: Vec<String>,
    handle: DriverHandle,
    max_rows: usize,
    stop: StopFlag,
) {
    let started = std::time::Instant::now();
    emit(
        &app,
        "query:started",
        &StartedPayload {
            query_id: query_id.clone(),
            statement_count: statements.len(),
        },
    );

    // 数据设置：查询超时（0/缺省 = 不限）与自动提交（false = 事务包裹）
    let timeout_seconds = meta
        .get_setting("query.timeout_seconds")
        .ok()
        .flatten()
        .and_then(|raw| raw.parse::<u64>().ok())
        .filter(|seconds| *seconds > 0);
    let timeout = timeout_seconds.map(std::time::Duration::from_secs);
    let autocommit = meta
        .get_setting("data.autocommit")
        .ok()
        .flatten()
        .map(|raw| raw != "false")
        .unwrap_or(true);

    // 事务包裹：失败/取消回滚，成功提交（驱动均为自动提交语义，BEGIN/COMMIT 三驱动通用）
    let (status, error, total_rows) = if !autocommit {
        if let Err(err) = handle.execute("BEGIN", 1, 1, &mut crate::db::driver::NullRowSink).await {
            log::warn!("开启事务失败：{err}");
        }
        let result = statement_loop(
            app.clone(),
            query_id.clone(),
            registry.clone(),
            handle.clone(),
            statements,
            max_rows,
            timeout,
            stop.clone(),
        )
        .await;
        let closing = if result.0 == "completed" { "COMMIT" } else { "ROLLBACK" };
        if let Err(err) = handle.execute(closing, 1, 1, &mut crate::db::driver::NullRowSink).await {
            log::warn!("结束事务（{closing}）失败：{err}");
        }
        result
    } else if matches!(handle, DriverHandle::Mysql(_)) {
        let inner = tokio::spawn(statement_loop(
            app.clone(),
            query_id.clone(),
            registry.clone(),
            handle.clone(),
            statements,
            max_rows,
            timeout,
            stop.clone(),
        ));
        registry.register(
            &query_id,
            stop.clone(),
            CancelKind::Mysql(inner.abort_handle()),
        );
        let joined = inner.await;
        registry.unregister(&query_id);
        match joined {
            Ok(result) => result,
            Err(_) => ("cancelled", None, 0), // abort：收尾仍由本任务完成
        }
    } else {
        registry.register(&query_id, stop.clone(), CancelKind::from_handle(&handle));
        let result = statement_loop(
            app.clone(),
            query_id.clone(),
            registry.clone(),
            handle,
            statements,
            max_rows,
            timeout,
            stop.clone(),
        )
        .await;
        registry.unregister(&query_id);
        result
    };

    let duration_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    let history_status = match status {
        "completed" => "ok",
        "cancelled" => "cancelled",
        _ => "error",
    };
    write_history(
        &meta,
        &query_id,
        &connection_id,
        &sql,
        history_status,
        total_rows,
        duration_ms,
        error.as_deref(),
    );
    emit(
        &app,
        "query:done",
        &DonePayload {
            query_id,
            status,
            error,
            duration_ms,
        },
    );
}

impl CancelKind {
    fn from_handle(handle: &DriverHandle) -> CancelKind {
        match handle {
            DriverHandle::Postgres(driver) => CancelKind::Postgres(driver.clone()),
            DriverHandle::Sqlite(driver) => CancelKind::Sqlite(driver.interrupt_handle()),
            DriverHandle::Mysql(_) => unreachable!("MySQL 走内层任务路径"),
        }
    }
}

#[tauri::command]
pub async fn execute_query(
    state: State<'_, AppState>,
    app: AppHandle,
    connection_id: String,
    database: Option<String>,
    sql: String,
    max_rows: Option<i64>,
) -> AppResult<QueryStarted> {
    let row = state
        .meta
        .get_connection(&connection_id)?
        .ok_or_else(|| AppError::NotFound(format!("连接 {connection_id}")))?;
    let statements: Vec<String> = split_statements(&sql)
        .into_iter()
        .map(|spanned| spanned.sql)
        .collect();
    if statements.is_empty() {
        return Err(AppError::Input("没有可执行的 SQL 语句".into()));
    }
    let rerunnable = crate::db::sql_classify::classify_all(&statements)
        == crate::db::sql_classify::StatementClass::Read;
    // 提前建连：连接错误同步暴露给调用方（而非埋在后台事件里）
    let database_name = match database.filter(|db| !db.is_empty()) {
        Some(db) => db,
        None => match row.driver.as_str() {
            "sqlite" => row.database.clone().unwrap_or_else(|| "main".into()),
            _ => row.database.clone().unwrap_or_else(|| "postgres".into()),
        },
    };
    let handle = state
        .connections
        .get_or_connect(&row, &database_name)
        .await?;
    let max_rows = resolve_max_rows(&state.meta, max_rows)?;

    let query_id = new_id("q");
    let statement_count = statements.len();
    let stop: StopFlag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    tauri::async_runtime::spawn(run_execution(
        state.meta.clone(),
        state.queries.clone(),
        app,
        query_id.clone(),
        connection_id,
        sql,
        statements,
        handle,
        max_rows,
        stop,
    ));
    Ok(QueryStarted {
        query_id,
        statement_count,
        rerunnable,
    })
}

#[tauri::command]
pub async fn cancel_query(
    state: State<'_, AppState>,
    query_id: String,
) -> AppResult<()> {
    // 置位停止标志 + 驱动硬取消（PG CancelToken / MySQL abort / SQLite interrupt）。
    // 收尾（历史 + done 事件）统一由执行任务完成：MySQL abort 经 JoinError 捕获。
    if state.queries.cancel(&query_id).is_none() {
        return Err(AppError::NotFound(format!("活动查询 {query_id}")));
    }
    Ok(())
}

#[tauri::command]
pub async fn describe_erd(
    state: State<'_, AppState>,
    connection_id: String,
    database: Option<String>,
    schema: String,
) -> AppResult<Vec<crate::db::driver::ErdTable>> {
    let row = state
        .meta
        .get_connection(&connection_id)?
        .ok_or_else(|| AppError::NotFound(format!("连接 {connection_id}")))?;
    let database_name = database.filter(|db| !db.is_empty()).unwrap_or_else(|| {
        match row.driver.as_str() {
            "sqlite" => "main".to_owned(),
            _ => row.database.clone().unwrap_or_else(|| "postgres".into()),
        }
    });
    let handle = state.connections.get_or_connect(&row, &database_name).await?;
    handle.describe_erd(&schema).await
}

#[tauri::command]
pub async fn describe_table(
    state: State<'_, AppState>,
    connection_id: String,
    database: Option<String>,
    schema: String,
    table: String,
) -> AppResult<Vec<ColumnMeta>> {
    let row = state
        .meta
        .get_connection(&connection_id)?
        .ok_or_else(|| AppError::NotFound(format!("连接 {connection_id}")))?;
    let database_name = database.filter(|db| !db.is_empty()).unwrap_or_else(|| {
        match row.driver.as_str() {
            "sqlite" => "main".to_owned(),
            _ => row.database.clone().unwrap_or_else(|| "postgres".into()),
        }
    });
    let handle = state.connections.get_or_connect(&row, &database_name).await?;
    handle.describe_table(&schema, &table).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_max_rows_defaults_and_clamps() {
        // 无设置、无入参 → 默认值
        // resolve_max_rows 需要 MetaStore；此处经内存库构造
        let meta = crate::store::meta::MetaStore::open(std::path::Path::new(":memory:")).unwrap();
        assert_eq!(resolve_max_rows(&meta, None).unwrap(), DEFAULT_MAX_ROWS);
        assert_eq!(resolve_max_rows(&meta, Some(0)).unwrap(), DEFAULT_MAX_ROWS);
        assert_eq!(resolve_max_rows(&meta, Some(100)).unwrap(), 100);
        assert_eq!(
            resolve_max_rows(&meta, Some(MAX_ROWS_LIMIT as i64 + 1)).unwrap(),
            MAX_ROWS_LIMIT
        );
        meta.set_setting("query.max_rows", "2000").unwrap();
        assert_eq!(resolve_max_rows(&meta, None).unwrap(), 2000);
    }
}
