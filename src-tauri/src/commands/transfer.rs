//! 导入导出：预览、原生保存对话框、后台流式导出与 CSV 导入（任务化 + 进度事件）。
//! 导出经 db::export 写入器直写文件（无行上限）；导入按批插入，
//! 冲突策略：error（中止）/ skip（批失败后逐行抢救）/ overwrite（替换语义）。

use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::sync::Arc;

use csv::ReaderBuilder;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::db::driver::{Cell, NullRowSink, RowSink};
use crate::db::export::{
    mysql_ident, quoted_ident, sql_value, CsvWriter, ExportEncoding, ExportFormat, InsertWriter,
    JsonWriter, LineSeparator, RowsWriter,
};
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::store::meta::new_id;
use crate::tasks::StopFlag;

const IMPORT_PREVIEW_ROWS: usize = 20;
/// 导出进度事件节流（每 N 行）
const EXPORT_PROGRESS_EVERY: u64 = 2_000;
/// 导入进度事件节流（每 N 行）
const IMPORT_PROGRESS_EVERY: u64 = 500;
/// 错误行报告上限（避免巨型数组冲击 IPC）
const SKIPPED_REPORT_LIMIT: usize = 100;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportInput {
    pub format: String, // csv | json | insert
    pub columns: Option<Vec<String>>,
    pub encoding: String, // utf8 | utf8-bom | gbk
    pub line_separator: String,
    pub file_path: String,
    pub table: Option<String>,
    pub max_rows: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMapping {
    pub source: String,
    pub target: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportInput {
    pub file_path: String,
    pub delimiter: String,
    pub has_header: bool,
    pub column_mapping: Vec<ColumnMapping>,
    pub conflict: String, // error | skip | overwrite
    pub batch_size: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStarted {
    pub task_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvPreview {
    pub headers: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub total_rows: u64,
}

// ── 事件载荷 ────────────────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProgressPayload {
    task_id: String,
    kind: &'static str,
    done: u64,
    total: Option<u64>,
    message: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TaskResult {
    rows: u64,
    skipped_rows: Vec<u64>,
    duration_ms: u64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DonePayload {
    task_id: String,
    status: &'static str, // completed | cancelled | error
    error: Option<String>,
    result: Option<TaskResult>,
}

fn emit_progress(app: &AppHandle, task_id: &str, kind: &'static str, done: u64, total: Option<u64>) {
    if let Err(err) = app.emit(
        "task:progress",
        &ProgressPayload {
            task_id: task_id.to_owned(),
            kind,
            done,
            total,
            message: None,
        },
    ) {
        log::warn!("task:progress 发送失败：{err}");
    }
}

fn emit_done(app: &AppHandle, payload: &DonePayload) {
    if let Err(err) = app.emit("task:done", payload) {
        log::warn!("task:done 发送失败：{err}");
    }
}

/// 任务完成系统通知（失败/完成两态）
fn notify(app: &AppHandle, title: &str, body: &str) {
    use tauri_plugin_notification::NotificationExt;
    if let Err(err) = app.notification().builder().title(title).body(body).show() {
        log::warn!("系统通知发送失败：{err}");
    }
}

fn parse_encoding(raw: &str) -> AppResult<ExportEncoding> {
    match raw {
        "utf8" => Ok(ExportEncoding::Utf8),
        "utf8-bom" => Ok(ExportEncoding::Utf8Bom),
        "gbk" => Ok(ExportEncoding::Gbk),
        other => Err(AppError::Input(format!("未知编码：{other}"))),
    }
}

fn parse_separator(raw: &str) -> AppResult<LineSeparator> {
    match raw {
        "\n" => Ok(LineSeparator::Lf),
        "\r\n" => Ok(LineSeparator::Crlf),
        other => Err(AppError::Input(format!(
            "未知行分隔符（支持 \\n 与 \\r\\n）：{other:?}"
        ))),
    }
}

fn parse_format(raw: &str) -> AppResult<ExportFormat> {
    match raw {
        "csv" => Ok(ExportFormat::Csv),
        "json" => Ok(ExportFormat::Json),
        "insert" => Ok(ExportFormat::Insert),
        other => Err(AppError::Input(format!("未知导出格式：{other}"))),
    }
}

/// 与 query::execute_query 一致的库名解析
fn resolve_database(row: &crate::store::meta::ConnectionRow, database: Option<String>) -> String {
    match database.filter(|db| !db.is_empty()) {
        Some(db) => db,
        None => match row.driver.as_str() {
            "sqlite" => row.database.clone().unwrap_or_else(|| "main".into()),
            _ => row.database.clone().unwrap_or_else(|| "postgres".into()),
        },
    }
}

fn require_row(state: &AppState, id: &str) -> AppResult<crate::store::meta::ConnectionRow> {
    state
        .meta
        .get_connection(id)?
        .ok_or_else(|| AppError::NotFound(format!("连接 {id}")))
}

// ── 预览 / 保存对话框 ───────────────────────────────────────

#[tauri::command]
pub async fn preview_csv(
    path: String,
    delimiter: String,
    has_header: bool,
) -> AppResult<CsvPreview> {
    let delimiter_byte = delimiter.bytes().next().ok_or_else(|| {
        AppError::Input("分隔符不能为空".into())
    })?;
    let result = tauri::async_runtime::spawn_blocking(move || -> AppResult<CsvPreview> {
        let mut reader = ReaderBuilder::new()
            .delimiter(delimiter_byte)
            .has_headers(false)
            .from_path(&path)
            .map_err(|err| AppError::Input(format!("无法读取 CSV：{err}")))?;
        let mut headers: Vec<String> = Vec::new();
        let mut rows: Vec<Vec<String>> = Vec::new();
        let mut total: u64 = 0;
        for record in reader.records() {
            let record = record.map_err(|err| AppError::Input(format!("CSV 解析失败：{err}")))?;
            total += 1;
            let fields: Vec<String> = record.iter().map(ToOwned::to_owned).collect();
            if rows.len() < IMPORT_PREVIEW_ROWS {
                if total == 1 && has_header {
                    headers = fields;
                } else {
                    rows.push(fields);
                }
            }
            if total > 10_000_000 {
                return Err(AppError::Input("文件超过一千万行，拒绝导入".into()));
            }
        }
        if !has_header && !rows.is_empty() {
            // 无表头：以列序号命名
            let width = rows[0].len();
            headers = (0..width).map(|index| format!("列{index}")).collect();
        }
        Ok(CsvPreview {
            headers,
            rows,
            total_rows: if has_header { total.saturating_sub(1) } else { total },
        })
    })
    .await
    .map_err(|err| AppError::Internal(format!("预览任务异常：{err}")))?;
    result
}

#[tauri::command]
pub async fn pick_save_path(default_name: String) -> AppResult<Option<String>> {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        rfd::FileDialog::new()
            .set_file_name(&default_name)
            .save_file()
            .map(|path| path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|err| AppError::Internal(format!("保存对话框异常：{err}")))?;
    Ok(picked)
}

/// 打开文件对话框（导入选 CSV 用）
#[tauri::command]
pub async fn pick_open_path() -> AppResult<Option<String>> {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        rfd::FileDialog::new()
            .add_filter("CSV", &["csv", "txt"])
            .pick_file()
            .map(|path| path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|err| AppError::Internal(format!("打开对话框异常：{err}")))?;
    Ok(picked)
}

/// 前端导出 PNG/SVG 字节落盘（路径来自 pick_save_path）
#[tauri::command]
pub async fn save_binary_file(path: String, bytes: Vec<u8>) -> AppResult<()> {
    tauri::async_runtime::spawn_blocking(move || -> AppResult<()> {
        std::fs::write(&path, &bytes).map_err(|err| {
            AppError::Io(std::io::Error::new(
                err.kind(),
                format!("写入 {path} 失败：{err}"),
            ))
        })
    })
    .await
    .map_err(|err| AppError::Internal(format!("写盘任务异常：{err}")))?
}

// ── 导出 ────────────────────────────────────────────────────

struct ExportSink {
    writer: Box<dyn RowsWriter>,
    app: AppHandle,
    task_id: String,
    stop: StopFlag,
    table: Option<String>,
    selected: Option<Vec<String>>,
    count: u64,
    /// 列选择结果（columns 事件到达时解析）
    indices: Option<Vec<usize>>,
    names: Vec<String>,
    error: Option<String>,
}

impl RowSink for ExportSink {
    fn columns(&mut self, columns: Vec<crate::db::driver::ColumnMeta>) {
        let all_names: Vec<String> = columns.iter().map(|column| column.name.clone()).collect();
        let (names, indices) = match &self.selected {
            None => (all_names.clone(), (0..all_names.len()).collect()),
            Some(selected) => {
                let mut names = Vec::new();
                let mut indices = Vec::new();
                for name in selected {
                    if let Some(index) = all_names.iter().position(|candidate| candidate == name) {
                        names.push(name.clone());
                        indices.push(index);
                    }
                }
                (names, indices)
            }
        };
        self.names = names;
        self.indices = Some(indices);
        if let Err(err) = self.writer.start(&self.names.clone(), self.table.as_deref()) {
            self.error = Some(format!("写入文件头失败：{err}"));
        }
    }

    fn rows(&mut self, rows: Vec<Vec<Cell>>) -> bool {
        if self.stop.load(AtomicOrdering::Relaxed) || self.error.is_some() {
            return false;
        }
        let indices = self.indices.clone().unwrap_or_default();
        for row in rows {
            let cells: Vec<Cell> = indices.iter().map(|index| row[*index].clone()).collect();
            if let Err(err) = self.writer.write_row(&cells) {
                self.error = Some(format!("写入第 {} 行失败：{err}", self.count + 1));
                return false;
            }
            self.count += 1;
            if self.count % EXPORT_PROGRESS_EVERY == 0 {
                emit_progress(&self.app, &self.task_id, "export", self.count, None);
            }
        }
        true
    }
}

#[tauri::command]
pub async fn export_query(
    state: State<'_, AppState>,
    app: AppHandle,
    connection_id: String,
    database: Option<String>,
    sql: String,
    input: ExportInput,
) -> AppResult<TaskStarted> {
    if sql.trim().is_empty() {
        return Err(AppError::Input("导出 SQL 不能为空".into()));
    }
    if input.file_path.trim().is_empty() {
        return Err(AppError::Input("导出路径不能为空".into()));
    }
    let format = parse_format(&input.format)?;
    let encoding = parse_encoding(&input.encoding)?;
    let separator = parse_separator(&input.line_separator)?;
    let max_rows = input.max_rows.and_then(|value| usize::try_from(value).ok());

    let row = require_row(&state, &connection_id)?;
    let database_name = resolve_database(&row, database);
    let handle = state
        .connections
        .get_or_connect(&row, &database_name)
        .await?;

    let file = std::fs::File::create(&input.file_path).map_err(|err| {
        AppError::Io(std::io::Error::new(
            err.kind(),
            format!("无法创建 {}：{err}", input.file_path),
        ))
    })?;
    let writer: Box<dyn RowsWriter> = match format {
        ExportFormat::Csv => Box::new(CsvWriter::new(file, encoding, separator)),
        ExportFormat::Json => Box::new(JsonWriter::new(file, encoding, separator)),
        ExportFormat::Insert => Box::new(InsertWriter::new(file, encoding, separator)),
    };

    let task_id = new_id("task");
    let stop: StopFlag = Arc::new(AtomicBool::new(false));
    state.tasks.register(&task_id, stop.clone());

    let task_id_for_task = task_id.clone();
    let registry = state.tasks.clone();
    let file_path = input.file_path.clone();
    tauri::async_runtime::spawn(async move {
        let started = std::time::Instant::now();
        let mut sink = ExportSink {
            writer,
            app: app.clone(),
            task_id: task_id_for_task.clone(),
            stop,
            table: input.table.clone(),
            selected: input.columns.clone(),
            count: 0,
            indices: None,
            names: Vec::new(),
            error: None,
        };
        let cap = max_rows.unwrap_or(usize::MAX);
        let outcome = handle.execute(&sql, cap, 1_000, &mut sink).await;
        let finish_result = sink.writer.finish();
        registry.unregister(&task_id_for_task);

        let duration_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
        let cancelled = sink.stop.load(AtomicOrdering::Relaxed);
        let result = TaskResult {
            rows: sink.count,
            skipped_rows: Vec::new(),
            duration_ms,
        };
        let error_message: Option<String> = if let Some(error) = &sink.error {
            Some(error.clone())
        } else if let Err(err) = &finish_result {
            Some(err.to_string())
        } else if let Err(err) = &outcome {
            if !cancelled {
                Some(err.to_string())
            } else {
                None
            }
        } else {
            None
        };
        let status = if cancelled && error_message.is_none() {
            "cancelled"
        } else if error_message.is_some() {
            "error"
        } else {
            "completed"
        };
        let payload = DonePayload {
            task_id: task_id_for_task.clone(),
            status,
            error: error_message,
            result: Some(result),
        };
        let status_label = match payload.status {
            "completed" => "导出完成",
            "cancelled" => "导出已取消",
            _ => "导出失败",
        };
        emit_done(&app, &payload);
        notify(
            &app,
            status_label,
            &format!("{}：{} 行", file_path, sink.count),
        );
    });

    Ok(TaskStarted { task_id })
}

// ── 导入 ────────────────────────────────────────────────────

fn ident(name: &str, driver: &str) -> String {
    if driver == "mysql" {
        mysql_ident(name)
    } else {
        quoted_ident(name)
    }
}

/// 批量 INSERT 前缀（VALUES 由调用方拼接）；overwrite 走各驱动替换语义
fn insert_prefix(
    driver: &str,
    table: &str,
    targets: &[String],
    overwrite: bool,
    pk: &[String],
) -> AppResult<String> {
    let columns = targets
        .iter()
        .map(|name| ident(name, driver))
        .collect::<Vec<_>>()
        .join(", ");
    let table_ident = ident(table, driver);
    let prefix = match (driver, overwrite) {
        ("sqlite", true) => format!("INSERT OR REPLACE INTO {table_ident} ({columns}) VALUES "),
        ("mysql", true) => format!("REPLACE INTO {table_ident} ({columns}) VALUES "),
        ("postgres", true) => {
            if pk.is_empty() {
                return Err(AppError::Input(
                    "PostgreSQL 覆盖导入需要目标表存在主键".into(),
                ));
            }
            let pk_cols = pk
                .iter()
                .map(|name| ident(name, driver))
                .collect::<Vec<_>>()
                .join(", ");
            let updates = targets
                .iter()
                .filter(|name| !pk.contains(name))
                .map(|name| {
                    let column = ident(name, driver);
                    format!("{column} = EXCLUDED.{column}")
                })
                .collect::<Vec<_>>()
                .join(", ");
            if updates.is_empty() {
                format!("INSERT INTO {table_ident} ({columns}) VALUES ")
            } else {
                format!("INSERT INTO {table_ident} ({columns}) VALUES {{VALUES}} ON CONFLICT ({pk_cols}) DO UPDATE SET {updates}")
            }
        }
        _ => format!("INSERT INTO {table_ident} ({columns}) VALUES "),
    };
    Ok(prefix)
}

fn csv_record_to_cells(
    record: &csv::StringRecord,
    source_indices: &[usize],
) -> Vec<Cell> {
    source_indices
        .iter()
        .map(|index| match record.get(*index) {
            None | Some("") => Cell::Null,
            Some(value) => Cell::Text(value.to_owned()),
        })
        .collect()
}

fn values_tuple(cells: &[Cell]) -> String {
    let values: Vec<String> = cells.iter().map(sql_value).collect();
    format!("({})", values.join(", "))
}

#[tauri::command]
pub async fn import_csv(
    state: State<'_, AppState>,
    app: AppHandle,
    connection_id: String,
    database: Option<String>,
    table: String,
    input: ImportInput,
) -> AppResult<TaskStarted> {
    if table.trim().is_empty() {
        return Err(AppError::Input("目标表名不能为空".into()));
    }
    if input.column_mapping.iter().all(|mapping| mapping.target.is_none()) {
        return Err(AppError::Input("至少需要映射一列".into()));
    }
    let conflict = match input.conflict.as_str() {
        "error" => "error",
        "skip" => "skip",
        "overwrite" => "overwrite",
        other => return Err(AppError::Input(format!("未知冲突策略：{other}"))),
    };
    let batch_size = input.batch_size.unwrap_or(500).clamp(1, 5_000);
    let delimiter_byte = input
        .delimiter
        .bytes()
        .next()
        .ok_or_else(|| AppError::Input("分隔符不能为空".into()))?;

    let row = require_row(&state, &connection_id)?;
    let driver = row.driver.clone();
    let database_name = resolve_database(&row, database);
    let handle = state
        .connections
        .get_or_connect(&row, &database_name)
        .await?;

    // overwrite 策略的 PostgreSQL 需要主键
    let primary_keys = if driver == "postgres" && conflict == "overwrite" {
        handle.primary_keys("", table.trim()).await?
    } else {
        Vec::new()
    };
    let _ = database_name; // 当前库上下文已由连接句柄承载

    let task_id = new_id("task");
    let stop: StopFlag = Arc::new(AtomicBool::new(false));
    state.tasks.register(&task_id, stop.clone());

    let registry = state.tasks.clone();
    let task_id_for_task = task_id.clone();
    let table_name = table.trim().to_owned();
    tauri::async_runtime::spawn(async move {
        let started = std::time::Instant::now();
        let mut count: u64 = 0;
        let mut skipped: Vec<u64> = Vec::new();
        let mut status = "completed";
        let mut error: Option<String> = None;

        let import_result: AppResult<()> = async {
            let mut reader = ReaderBuilder::new()
                .delimiter(delimiter_byte)
                .has_headers(false)
                .from_path(&input.file_path)
                .map_err(|err| AppError::Input(format!("无法读取 CSV：{err}")))?;

            let mut record_iter = reader.records();
            // 首行为表头时跳过
            if input.has_header {
                record_iter.next();
            }

            let mut targets: Vec<String> = Vec::new();
            let mut source_indices: Vec<usize> = Vec::new();
            for (index, mapping) in input.column_mapping.iter().enumerate() {
                if let Some(target) = &mapping.target {
                    if target.is_empty() {
                        continue;
                    }
                    // source 为源文件列序号字符串（前端生成）；缺省回退到位置
                    let source = mapping.source.parse::<usize>().unwrap_or(index);
                    targets.push(target.clone());
                    source_indices.push(source);
                }
            }
            if targets.is_empty() {
                return Err(AppError::Input("至少需要映射一列".into()));
            }

            let prefix = insert_prefix(&driver, &table_name, &targets, conflict == "overwrite", &primary_keys)?;
            let pg_upsert = prefix.contains("{VALUES}");
            let base_prefix = prefix.replace("{VALUES}", "");

            let mut batch: Vec<Vec<Cell>> = Vec::with_capacity(batch_size);
            let mut row_number: u64 = 0;

            macro_rules! flush_batch {
                () => {
                    if !batch.is_empty() {
                        if pg_upsert {
                            let tuples = batch.iter().map(|cells| values_tuple(cells)).collect::<Vec<_>>().join(",");
                            let sql = base_prefix.replace("{VALUES}", &tuples);
                            if let Err(err) = handle.execute(&sql, 1, 1, &mut NullRowSink).await {
                                if stop.load(AtomicOrdering::Relaxed) {
                                    return Err(AppError::Cancelled);
                                }
                                return Err(AppError::Input(format!("导入第 {} 行失败：{err}", row_number - batch.len() as u64 + 1)));
                            }
                            count += batch.len() as u64;
                        } else {
                            let tuples = batch.iter().map(|cells| values_tuple(cells)).collect::<Vec<_>>().join(",");
                            let sql = format!("{base_prefix}{tuples}");
                            match handle.execute(&sql, 1, 1, &mut NullRowSink).await {
                                Ok(_) => count += batch.len() as u64,
                                Err(batch_error) => {
                                    if conflict == "error" {
                                        return Err(AppError::Input(format!(
                                            "导入第 {}–{} 行失败：{batch_error}",
                                            row_number - batch.len() as u64 + 1,
                                            row_number
                                        )));
                                    }
                                    // skip：批失败后逐行抢救
                                    for (offset, cells) in batch.iter().enumerate() {
                                        if stop.load(AtomicOrdering::Relaxed) {
                                            break;
                                        }
                                        let single = format!("{base_prefix}{}", values_tuple(cells));
                                        match handle.execute(&single, 1, 1, &mut NullRowSink).await {
                                            Ok(_) => count += 1,
                                            Err(_) => {
                                                if skipped.len() < SKIPPED_REPORT_LIMIT {
                                                    skipped.push(row_number - batch.len() as u64 + 1 + offset as u64);
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        batch.clear();
                        if count % IMPORT_PROGRESS_EVERY == 0 || count < batch.len() as u64 {
                            emit_progress(&app, &task_id_for_task, "import", count, None);
                        }
                    }
                };
            }

            while let Some(record) = record_iter
                .next()
                .transpose()
                .map_err(|err| AppError::Input(format!("CSV 解析失败：{err}")))?
            {
                if stop.load(AtomicOrdering::Relaxed) {
                    break;
                }
                row_number += 1;
                batch.push(csv_record_to_cells(&record, &source_indices));
                if batch.len() >= batch_size {
                    flush_batch!();
                }
                if row_number > 10_000_000 {
                    return Err(AppError::Input("文件超过一千万行，拒绝导入".into()));
                }
            }
            flush_batch!();
            Ok(())
        }
        .await;

        if let Err(err) = import_result {
            if matches!(err, AppError::Cancelled) || stop.load(AtomicOrdering::Relaxed) {
                status = "cancelled";
            } else {
                status = "error";
                error = Some(err.to_string());
            }
        } else if stop.load(AtomicOrdering::Relaxed) {
            status = "cancelled";
        }

        registry.unregister(&task_id_for_task);
        let duration_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
        let payload = DonePayload {
            task_id: task_id_for_task.clone(),
            status,
            error,
            result: Some(TaskResult {
                rows: count,
                skipped_rows: skipped,
                duration_ms,
            }),
        };
        let status_label = match payload.status {
            "completed" => "导入完成",
            "cancelled" => "导入已取消",
            _ => "导入失败",
        };
        emit_done(&app, &payload);
        notify(
            &app,
            status_label,
            &format!("{table_name}：{count} 行成功"),
        );
    });

    Ok(TaskStarted { task_id })
}

#[tauri::command]
pub async fn cancel_task(state: State<'_, AppState>, task_id: String) -> AppResult<()> {
    if !state.tasks.cancel(&task_id) {
        return Err(AppError::NotFound(format!("活动任务 {task_id}")));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn insert_prefixes_per_driver_and_strategy() {
        let targets = vec!["a".to_owned(), "b".to_owned()];
        assert_eq!(
            insert_prefix("postgres", "t", &targets, false, &[]).unwrap(),
            "INSERT INTO \"t\" (\"a\", \"b\") VALUES "
        );
        assert_eq!(
            insert_prefix("mysql", "t", &targets, true, &[]).unwrap(),
            "REPLACE INTO `t` (`a`, `b`) VALUES "
        );
        assert_eq!(
            insert_prefix("sqlite", "t", &targets, true, &[]).unwrap(),
            "INSERT OR REPLACE INTO \"t\" (\"a\", \"b\") VALUES "
        );
        // PG overwrite 需要主键
        assert!(insert_prefix("postgres", "t", &targets, true, &[]).is_err());
        let upsert = insert_prefix("postgres", "t", &targets, true, &["id".to_owned()]).unwrap();
        assert!(upsert.contains("{VALUES}"));
        assert!(upsert.contains("ON CONFLICT (\"id\") DO UPDATE SET \"a\" = EXCLUDED.\"a\""));
        // 主键列不出现在 UPDATE 集合
        assert!(!upsert.contains("\"id\" = EXCLUDED"));
    }

    #[test]
    fn values_tuple_escapes_literals() {
        let cells = vec![Cell::Text("O'Brien".into()), Cell::Null, Cell::Int(3)];
        assert_eq!(values_tuple(&cells), "('O''Brien', NULL, 3)");
    }

    #[test]
    fn csv_record_maps_by_source_index_and_null() {
        let record = csv::StringRecord::from(vec!["x".to_owned(), "".to_owned(), "42".to_owned()]);
        let cells = csv_record_to_cells(&record, &[0, 1, 2]);
        assert_eq!(cells[0], Cell::Text("x".into()));
        assert_eq!(cells[1], Cell::Null);
        assert_eq!(cells[2], Cell::Text("42".into()));
    }

    #[test]
    fn parse_options_reject_unknowns() {
        assert!(parse_encoding("utf8").is_ok());
        assert!(parse_encoding("latin1").is_err());
        assert!(parse_separator("
").is_ok());
        assert!(parse_separator("	").is_err());
        assert!(parse_format("csv").is_ok());
        assert!(parse_format("parquet").is_err());
    }
}

#[cfg(test)]
mod roundtrip {
    use super::*;
    use crate::db::driver::DatabaseDriver as _;
    use crate::db::export::{CsvWriter, ExportEncoding, LineSeparator};
    use crate::db::sqlite::SqliteDriver;
    use std::fs::File;

    struct CollectRows {
        rows: Vec<Vec<Cell>>,
    }

    impl crate::db::driver::RowSink for CollectRows {
        fn columns(&mut self, _columns: Vec<crate::db::driver::ColumnMeta>) {}
        fn rows(&mut self, rows: Vec<Vec<Cell>>) -> bool {
            self.rows.extend(rows);
            true
        }
    }

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "lattice-rt-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let _ = tag;
        dir
    }

    /// 离线全链路：CSV →（import 语义）→ SQLite →（export 语义）→ CSV 回读比对
    #[tokio::test]
    async fn sqlite_import_export_roundtrip() {
        let dir = temp_dir("roundtrip");
        let db_path = dir.join("rt.db");
        let driver = SqliteDriver::connect(db_path.to_str().unwrap(), false).unwrap();
        driver
            .execute("CREATE TABLE t (id INTEGER, name TEXT)", 1, 1, &mut NullRowSink)
            .await
            .unwrap();

        let csv_path = dir.join("in.csv");
        std::fs::write(&csv_path, "id,name
1,O'Brien
2,张三
").unwrap();

        // ── 导入主路径复刻：读 CSV → 映射 → 批量字面量 INSERT ──
        let mut reader = ReaderBuilder::new()
            .delimiter(b',')
            .has_headers(false)
            .from_path(&csv_path)
            .unwrap();
        let mut records = reader.records();
        records.next(); // 跳过表头
        let mut batch: Vec<Vec<Cell>> = Vec::new();
        while let Some(record) = records.next().transpose().unwrap() {
            batch.push(csv_record_to_cells(&record, &[0, 1]));
        }
        let targets = vec!["id".to_owned(), "name".to_owned()];
        let prefix = insert_prefix("sqlite", "t", &targets, false, &[]).unwrap();
        let sql = format!(
            "{prefix}{}",
            batch.iter().map(|cells| values_tuple(cells)).collect::<Vec<_>>().join(",")
        );
        driver.execute(&sql, 1, 1, &mut NullRowSink).await.unwrap();

        // 行数校验
        let mut sink = CollectRows { rows: Vec::new() };
        driver.execute("SELECT id, name FROM t", 100, 100, &mut sink).await.unwrap();
        assert_eq!(sink.rows.len(), 2);
        assert_eq!(sink.rows[0][1], Cell::Text("O'Brien".into()));
        assert_eq!(sink.rows[1][1], Cell::Text("张三".into()));

        // ── 导出主路径复刻：行批次 → CsvWriter → 回读比对 ──
        let out_path = dir.join("out.csv");
        let file = File::create(&out_path).unwrap();
        let mut writer = CsvWriter::new(file, ExportEncoding::Utf8, LineSeparator::Lf);
        writer.start(&targets, None).unwrap();
        for cells in &sink.rows {
            writer.write_row(cells).unwrap();
        }
        writer.finish().unwrap();
        let written = std::fs::read_to_string(&out_path).unwrap();
        assert_eq!(written, "id,name
1,O'Brien
2,张三
");

        std::fs::remove_dir_all(dir).ok();
    }
}
