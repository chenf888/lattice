//! SQLite 驱动（rusqlite）：常驻连接 + 独立工作线程流式取行；
//! 取消经 `InterruptHandle`（另一线程触发，下一 API 调用返回 Interrupted）。
//! 只读连接在打开时即以 SQLITE_OPEN_READ_ONLY 生效。

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rusqlite::OpenFlags;
use tokio::sync::mpsc;

use crate::db::driver::{
    Cell, ColumnMeta, DatabaseDriver, NodePath, NullRowSink, RowSink, StatementOutcome, TreeNode,
    TreeNodeKind,
};
use crate::error::{AppError, AppResult};

/// 工作线程 → 异步侧的消息
enum WorkerMsg {
    Columns(Vec<ColumnMeta>),
    Batch(Vec<Vec<Cell>>),
}

struct Inner {
    conn: Mutex<rusqlite::Connection>,
    #[allow(dead_code)] // 打开时已生效；保留供诊断
    read_only: bool,
}

#[derive(Clone)]
pub struct SqliteDriver {
    inner: Arc<Inner>,
}

fn map_sqlite_err(err: rusqlite::Error) -> AppError {
    if let rusqlite::Error::SqliteFailure(code, _) = &err {
        if code.code == rusqlite::ErrorCode::OperationInterrupted {
            return AppError::Cancelled;
        }
    }
    AppError::Db(err)
}

fn ms(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

impl SqliteDriver {
    pub fn connect(path: &str, read_only: bool) -> AppResult<Self> {
        let conn = if read_only {
            rusqlite::Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        } else {
            rusqlite::Connection::open(path)
        }
        .map_err(|err| AppError::Conn(format!("无法打开 SQLite 数据库 `{path}`：{err}")))?;
        conn.busy_timeout(Duration::from_secs(5))?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        Ok(Self {
            inner: Arc::new(Inner {
                conn: Mutex::new(conn),
                read_only,
            }),
        })
    }

    /// 取消句柄（供执行编排注册；与工作线程持有的连接锁无关，可随时触发）
    pub fn interrupt_handle(&self) -> rusqlite::InterruptHandle {
        let guard = match self.inner.conn.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        guard.get_interrupt_handle()
    }
}

/// 工作线程主体：锁内 prepare + 迭代，批经有界通道流出（天然背压）
fn run_worker(
    inner: Arc<Inner>,
    sql: String,
    cap: usize,
    batch: usize,
    tx: mpsc::Sender<WorkerMsg>,
    stop: Arc<std::sync::atomic::AtomicBool>,
) -> AppResult<StatementOutcome> {
    use std::sync::atomic::Ordering;
    let started = Instant::now();
    let conn = inner.conn.lock().map_err(|_| {
        AppError::Internal("sqlite 连接锁中毒".into())
    })?;
    let mut statement = conn.prepare(&sql).map_err(map_sqlite_err)?;
    let column_count = statement.column_count();
    let columns: Vec<ColumnMeta> = statement
        .column_names()
        .into_iter()
        .map(|name| ColumnMeta {
            name: name.to_owned(),
            type_name: String::new(),
        })
        .collect();
    tx.blocking_send(WorkerMsg::Columns(columns))
        .map_err(|_| AppError::Internal("结果通道已关闭".into()))?;

    let cap = u64::try_from(cap).unwrap_or(u64::MAX).max(1);
    let batch = batch.max(1);
    let mut rows_total: u64 = 0;
    let mut truncated = false;
    let mut buffer: Vec<Vec<Cell>> = Vec::with_capacity(batch);
    {
        let mut rows = statement.query([]).map_err(map_sqlite_err)?;
        while let Some(row) = rows.next().map_err(map_sqlite_err)? {
            if rows_total >= cap || stop.load(Ordering::Relaxed) {
                truncated = true;
                break;
            }
            let mut cells = Vec::with_capacity(column_count);
            for index in 0..column_count {
                let value = row.get_ref(index).map_err(map_sqlite_err)?;
                cells.push(crate::db::value::cell_from_rusqlite(value));
            }
            buffer.push(cells);
            rows_total += 1;
            if buffer.len() >= batch {
                tx.blocking_send(WorkerMsg::Batch(std::mem::take(&mut buffer)))
                    .map_err(|_| AppError::Internal("结果通道已关闭".into()))?;
                buffer = Vec::with_capacity(batch);
            }
        }
    }
    if !buffer.is_empty() {
        tx.blocking_send(WorkerMsg::Batch(buffer))
            .map_err(|_| AppError::Internal("结果通道已关闭".into()))?;
    }
    Ok(StatementOutcome {
        rows_total,
        rows_affected: 0,
        truncated,
        duration_ms: ms(started),
    })
}

impl DatabaseDriver for SqliteDriver {
    fn name(&self) -> &'static str {
        "sqlite"
    }

    async fn ping(&self) -> AppResult<()> {
        self.execute("SELECT 1", 1, 1, &mut NullRowSink).await?;
        Ok(())
    }

    async fn execute(
        &self,
        sql: &str,
        cap: usize,
        batch: usize,
        sink: &mut dyn RowSink,
    ) -> AppResult<StatementOutcome> {
        use std::sync::atomic::{AtomicBool, Ordering};

        if sql.trim().is_empty() {
            return Err(AppError::Input("SQL 不能为空".into()));
        }
        let inner = Arc::clone(&self.inner);
        let stop = Arc::new(AtomicBool::new(false));
        let stop_for_worker = Arc::clone(&stop);
        let sql_owned = sql.to_owned();
        let (tx, mut rx) = mpsc::channel::<WorkerMsg>(4);
        let mut worker = tokio::task::spawn_blocking(move || {
            run_worker(inner, sql_owned, cap, batch, tx, stop_for_worker)
        });

        let mut stopped = false;
        let mut worker_result: Option<AppResult<StatementOutcome>> = None;
        while worker_result.is_none() {
            tokio::select! {
                biased;
                res = &mut worker => {
                    worker_result = Some(res.map_err(|err| {
                        AppError::Internal(format!("sqlite 工作线程异常：{err}"))
                    })?);
                    // worker 已退出：同步排空通道内的残余批次
                    while let Ok(msg) = rx.try_recv() {
                        match msg {
                            WorkerMsg::Columns(columns) => sink.columns(columns),
                            WorkerMsg::Batch(rows) => {
                                if !stopped && !sink.rows(rows) {
                                    stopped = true;
                                }
                            }
                        }
                    }
                }
                msg = rx.recv() => {
                    match msg {
                        Some(WorkerMsg::Columns(columns)) => sink.columns(columns),
                        Some(WorkerMsg::Batch(rows)) => {
                            if stopped {
                                continue;
                            }
                            if !sink.rows(rows) {
                                stop.store(true, Ordering::Relaxed);
                                stopped = true;
                            }
                        }
                        None => {} // 通道关闭但 worker 尚未 join，继续等
                    }
                }
            }
        }
        let outcome = worker_result.unwrap_or_else(|| {
            Err(AppError::Internal("sqlite 工作线程未返回结果".into()))
        })?;
        Ok(StatementOutcome {
            truncated: outcome.truncated || stopped,
            ..outcome
        })
    }

    async fn children(&self, path: &NodePath) -> AppResult<Vec<TreeNode>> {
        match path {
            NodePath::Databases => Ok(vec![TreeNode {
                id: "db/main".into(),
                label: "main".into(),
                node_kind: TreeNodeKind::Database,
                has_children: true,
                is_system: false,
                meta: Some("SQLite".into()),
            }]),
            NodePath::Schemas { database } => Ok(vec![TreeNode {
                id: format!("schemas/{}/main", crate::db::driver::encode_segment(database)),
                label: "main".into(),
                node_kind: TreeNodeKind::Schema,
                has_children: true,
                is_system: false,
                meta: None,
            }]),
            NodePath::Objects { object_kind, .. } => {
                let kind = *object_kind;
                let inner = Arc::clone(&self.inner);
                tokio::task::spawn_blocking(move || {
                    let conn = inner.conn.lock().map_err(|_| {
                        AppError::Internal("sqlite 连接锁中毒".into())
                    })?;
                    if matches!(
                        kind,
                        crate::db::driver::ObjectKind::Functions
                            | crate::db::driver::ObjectKind::Sequences
                    ) {
                        return Ok(Vec::new());
                    }
                    let object_type = if matches!(kind, crate::db::driver::ObjectKind::Views) {
                        "view"
                    } else {
                        "table"
                    };
                    let mut statement = conn
                        .prepare(
                            "SELECT name FROM sqlite_master
                             WHERE type = ?1 AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
                             ORDER BY name",
                        )
                        .map_err(map_sqlite_err)?;
                    let rows = statement
                        .query_map([object_type], |row| row.get::<_, String>(0))
                        .map_err(map_sqlite_err)?;
                    let mut nodes = Vec::new();
                    for name in rows {
                        let name = name.map_err(map_sqlite_err)?;
                        nodes.push(TreeNode {
                            id: format!(
                                "objects/main/main/{}/{}",
                                kind.id_segment(),
                                crate::db::driver::encode_segment(&name)
                            ),
                            label: name,
                            node_kind: if matches!(kind, crate::db::driver::ObjectKind::Views) {
                                TreeNodeKind::View
                            } else {
                                TreeNodeKind::Table
                            },
                            has_children: false,
                            is_system: false,
                            meta: None,
                        });
                    }
                    Ok(nodes)
                })
                .await
                .map_err(|err| AppError::Internal(format!("sqlite 工作线程异常：{err}")))?
            }
        }
    }

    async fn describe_table(&self, _schema: &str, table: &str) -> AppResult<Vec<ColumnMeta>> {
        let inner = Arc::clone(&self.inner);
        let table = table.to_owned();
        tokio::task::spawn_blocking(move || {
            let conn = inner
                .conn
                .lock()
                .map_err(|_| AppError::Internal("sqlite 连接锁中毒".into()))?;
            let mut statement = conn
                .prepare("SELECT name, type FROM pragma_table_info(?1) ORDER BY cid")
                .map_err(map_sqlite_err)?;
            let rows = statement
                .query_map([&table], |row| {
                    Ok(ColumnMeta {
                        name: row.get::<_, String>(0)?,
                        type_name: row.get::<_, String>(1)?,
                    })
                })
                .map_err(map_sqlite_err)?;
            let mut columns = Vec::new();
            for column in rows {
                columns.push(column.map_err(map_sqlite_err)?);
            }
            Ok(columns)
        })
        .await
        .map_err(|err| AppError::Internal(format!("sqlite 工作线程异常：{err}")))?
    }

    async fn apply_read_only(&self) -> AppResult<()> {
        Ok(()) // 只读在打开时以 SQLITE_OPEN_READ_ONLY 生效
    }

    async fn describe_erd(&self, _schema: &str) -> AppResult<Vec<crate::db::driver::ErdTable>> {
        use crate::db::driver::{ErdForeignKey, ErdTable};
        let inner = Arc::clone(&self.inner);
        tokio::task::spawn_blocking(move || {
            let conn = inner
                .conn
                .lock()
                .map_err(|_| AppError::Internal("sqlite 连接锁中毒".into()))?;
            let mut statement = conn
                .prepare(
                    "SELECT name FROM sqlite_master
                     WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
                     ORDER BY name",
                )
                .map_err(map_sqlite_err)?;
            let names: Vec<String> = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(map_sqlite_err)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(map_sqlite_err)?;

            let mut tables = Vec::new();
            for name in names {
                let mut column_statement = conn
                    .prepare("SELECT name, type, pk FROM pragma_table_info(?1) ORDER BY cid")
                    .map_err(map_sqlite_err)?;
                let rows = column_statement
                    .query_map([&name], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, i64>(2)?,
                        ))
                    })
                    .map_err(map_sqlite_err)?;
                let mut columns = Vec::new();
                let mut primary_keys = Vec::new();
                for row in rows {
                    let (column_name, type_name, pk) = row.map_err(map_sqlite_err)?;
                    if pk > 0 {
                        primary_keys.push(column_name.clone());
                    }
                    columns.push(ColumnMeta {
                        name: column_name,
                        type_name,
                    });
                }

                let mut fk_statement = conn
                    .prepare("SELECT \"from\", \"table\", \"to\" FROM pragma_foreign_key_list(?1)")
                    .map_err(map_sqlite_err)?;
                let fk_rows = fk_statement
                    .query_map([&name], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, Option<String>>(2)?,
                        ))
                    })
                    .map_err(map_sqlite_err)?;
                let mut foreign_keys = Vec::new();
                for row in fk_rows {
                    let (column, ref_table, ref_column) = row.map_err(map_sqlite_err)?;
                    foreign_keys.push(ErdForeignKey {
                        column,
                        ref_table,
                        // SQLite 复合外键的 "to" 可为 NULL（默认引用主键）
                        ref_column: ref_column.unwrap_or_default(),
                    });
                }
                tables.push(ErdTable {
                    name,
                    columns,
                    primary_keys,
                    foreign_keys,
                });
            }
            Ok(tables)
        })
        .await
        .map_err(|err| AppError::Internal(format!("sqlite 工作线程异常：{err}")))?
    }

    async fn primary_keys(&self, _schema: &str, table: &str) -> AppResult<Vec<String>> {
        let inner = Arc::clone(&self.inner);
        let table = table.to_owned();
        tokio::task::spawn_blocking(move || {
            let conn = inner
                .conn
                .lock()
                .map_err(|_| AppError::Internal("sqlite 连接锁中毒".into()))?;
            let mut statement = conn
                .prepare("SELECT name FROM pragma_table_info(?1) WHERE pk > 0 ORDER BY pk")
                .map_err(map_sqlite_err)?;
            let rows = statement
                .query_map([&table], |row| row.get::<_, String>(0))
                .map_err(map_sqlite_err)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(map_sqlite_err)?;
            Ok(rows)
        })
        .await
        .map_err(|err| AppError::Internal(format!("sqlite 工作线程异常：{err}")))?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn setup_driver() -> (SqliteDriver, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "lattice-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.db");
        let driver = SqliteDriver::connect(path.to_str().unwrap(), false).unwrap();
        (driver, dir)
    }

    /// 测试用收集 sink（execute 以 &mut 独占，无需内部锁）
    struct CollectSink {
        columns: Vec<ColumnMeta>,
        rows: Vec<Vec<Cell>>,
        stop_after: Option<usize>,
    }

    impl CollectSink {
        fn new(stop_after: Option<usize>) -> Self {
            Self {
                columns: Vec::new(),
                rows: Vec::new(),
                stop_after,
            }
        }
    }

    impl RowSink for CollectSink {
        fn columns(&mut self, columns: Vec<ColumnMeta>) {
            self.columns.extend(columns);
        }
        fn rows(&mut self, rows: Vec<Vec<Cell>>) -> bool {
            self.rows.extend(rows);
            match self.stop_after {
                Some(limit) => self.rows.len() < limit,
                None => true,
            }
        }
    }

    fn cell_text(cell: &Cell) -> &str {
        match cell {
            Cell::Text(text) => text,
            other => panic!("期望 Text，得到 {other:?}"),
        }
    }

    #[tokio::test]
    async fn executes_and_streams_batches() {
        let (driver, dir) = setup_driver().await;
        driver
            .execute(
                "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)",
                10,
                2,
                &mut NullRowSink,
            )
            .await
            .unwrap();
        driver
            .execute(
                "INSERT INTO t (name) VALUES ('a'), ('b'), ('c'), ('d'), ('e')",
                10,
                2,
                &mut NullRowSink,
            )
            .await
            .unwrap();

        let mut sink = CollectSink::new(None);
        let outcome = driver.execute("SELECT * FROM t", 100, 2, &mut sink).await.unwrap();
        assert_eq!(outcome.rows_total, 5);
        assert!(!outcome.truncated);
        assert_eq!(sink.columns.len(), 2);
        assert_eq!(sink.rows.len(), 5);
        assert_eq!(cell_text(&sink.rows[0][1]), "a");
        assert!(matches!(sink.rows[0][0], Cell::Int(1)));

        // 上限截断
        let mut sink = CollectSink::new(None);
        let outcome = driver.execute("SELECT * FROM t", 3, 2, &mut sink).await.unwrap();
        assert_eq!(outcome.rows_total, 3);
        assert!(outcome.truncated);

        // 空结果
        let mut sink = CollectSink::new(None);
        let outcome = driver
            .execute("SELECT * FROM t WHERE id = 999", 10, 2, &mut sink)
            .await
            .unwrap();
        assert_eq!(outcome.rows_total, 0);

        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn children_and_describe_table() {
        let (driver, dir) = setup_driver().await;
        driver
            .execute("CREATE TABLE users (id INTEGER, name TEXT)", 10, 2, &mut NullRowSink)
            .await
            .unwrap();
        driver
            .execute("CREATE VIEW v_users AS SELECT * FROM users", 10, 2, &mut NullRowSink)
            .await
            .unwrap();

        let databases = driver.children(&NodePath::Databases).await.unwrap();
        assert_eq!(databases.len(), 1);
        assert_eq!(databases[0].label, "main");

        let schemas = driver
            .children(&NodePath::Schemas { database: "main".into() })
            .await
            .unwrap();
        assert_eq!(schemas.len(), 1);

        let tables = driver
            .children(&NodePath::Objects {
                database: "main".into(),
                schema: "main".into(),
                object_kind: crate::db::driver::ObjectKind::Tables,
            })
            .await
            .unwrap();
        assert_eq!(tables.len(), 1);
        assert_eq!(tables[0].label, "users");

        let views = driver
            .children(&NodePath::Objects {
                database: "main".into(),
                schema: "main".into(),
                object_kind: crate::db::driver::ObjectKind::Views,
            })
            .await
            .unwrap();
        assert_eq!(views.len(), 1);
        assert_eq!(views[0].label, "v_users");

        let columns = driver.describe_table("main", "users").await.unwrap();
        assert_eq!(columns.len(), 2);
        assert_eq!(columns[0].name, "id");
        assert_eq!(columns[0].type_name, "INTEGER");

        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn read_only_open_blocks_writes() {
        let dir = std::env::temp_dir().join(format!(
            "lattice-ro-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("ro.db");
        {
            let writer = SqliteDriver::connect(path.to_str().unwrap(), false).unwrap();
            writer
                .execute("CREATE TABLE t (a INT)", 10, 2, &mut NullRowSink)
                .await
                .unwrap();
        }
        let reader = SqliteDriver::connect(path.to_str().unwrap(), true).unwrap();
        let error = reader
            .execute("INSERT INTO t VALUES (1)", 10, 2, &mut NullRowSink)
            .await
            .unwrap_err();
        assert!(!matches!(error, AppError::Cancelled));
        reader.ping().await.unwrap();
        std::fs::remove_dir_all(dir).ok();
    }
}
