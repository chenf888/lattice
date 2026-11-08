//! 端到端流程测试（无 GUI 驱动器，穿透真实驱动/存储层，全部离线可验）：
//! ① 连接登记 → 对象树 → 执行 → 历史；② CSV 导入 → 导出往返；③ 连接管理生命周期（真实文件库）。

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use lattice_lib::db::driver::{Cell, ColumnMeta, DatabaseDriver as _, NodePath, NullRowSink, ObjectKind, RowSink};
use lattice_lib::db::export::{CsvWriter, ExportEncoding, LineSeparator, RowsWriter as _};
use lattice_lib::db::sqlite::SqliteDriver;
use lattice_lib::store::meta::{ConnectionRow, HistoryRecord, MetaStore, TabRecord};

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "lattice-e2e-{}-{}-{}",
        tag,
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// 简易阻塞等待（单线程 runtime，避免引入 tokio full 特性）
fn tokio_block<F: std::future::Future>(future: F) -> F::Output {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(future)
}

type SharedRows = Arc<Mutex<Vec<Vec<Cell>>>>;

struct CollectRows {
    rows: SharedRows,
}

impl RowSink for CollectRows {
    fn columns(&mut self, _columns: Vec<ColumnMeta>) {}
    fn rows(&mut self, rows: Vec<Vec<Cell>>) -> bool {
        self.rows.lock().unwrap().extend(rows);
        true
    }
}

fn connection_row(id: &str, name: &str, database: &Path) -> ConnectionRow {
    ConnectionRow {
        id: id.to_owned(),
        name: name.to_owned(),
        driver: "sqlite".to_owned(),
        host: None,
        port: None,
        database: Some(database.to_string_lossy().into_owned()),
        username: None,
        ssl_mode: None,
        color: None,
        group_name: None,
        read_only: false,
        created_at: 1,
        updated_at: 1,
    }
}

/// ① 连接登记 → 对象树浏览 → SQL 执行 → 历史落库与查询
#[test]
fn e2e_browse_execute_history_flow() {
    let dir = temp_dir("flow");
    let meta = MetaStore::open(&dir.join("app.db")).unwrap();
    let db_path = dir.join("data.db");
    meta.insert_connection(&connection_row("conn_e2e", "流程测试库", &db_path))
        .unwrap();
    assert!(meta.get_connection("conn_e2e").unwrap().is_some());

    let driver = SqliteDriver::connect(db_path.to_str().unwrap(), false).unwrap();
    tokio_block(async {
        driver
            .execute("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)", 1, 1, &mut NullRowSink)
            .await
            .unwrap();
        driver
            .execute("INSERT INTO users (name) VALUES ('Alice'), ('Bob'), ('张三')", 1, 1, &mut NullRowSink)
            .await
            .unwrap();
    });

    // 对象树：Databases → Schemas → Objects(tables)
    let databases = tokio_block(async { driver.children(&NodePath::Databases).await.unwrap() });
    assert_eq!(databases.len(), 1);
    let schemas = tokio_block(async {
        driver
            .children(&NodePath::Schemas { database: "main".into() })
            .await
            .unwrap()
    });
    assert_eq!(schemas.len(), 1);
    let tables = tokio_block(async {
        driver
            .children(&NodePath::Objects {
                database: "main".into(),
                schema: "main".into(),
                object_kind: ObjectKind::Tables,
            })
            .await
            .unwrap()
    });
    assert_eq!(tables.len(), 1);
    assert_eq!(tables[0].label, "users");

    // 执行查询（流式分批）
    let collected: SharedRows = Arc::new(Mutex::new(Vec::new()));
    let rows_total = tokio_block(async {
        let mut sink = CollectRows {
            rows: Arc::clone(&collected),
        };
        driver
            .execute("SELECT id, name FROM users", 100, 2, &mut sink)
            .await
            .unwrap()
            .rows_total
    });
    assert_eq!(rows_total, 3);
    assert_eq!(collected.lock().unwrap().len(), 3);

    // 历史落库 + 按连接查询
    meta.insert_query_history(&HistoryRecord {
        id: "qh_e2e".into(),
        connection_id: "conn_e2e".into(),
        sql: "SELECT id, name FROM users".into(),
        status: "ok".into(),
        rows: Some(3),
        duration_ms: Some(1),
        error: None,
    })
    .unwrap();
    let history = meta.list_query_history(Some("conn_e2e"), 10).unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].rows, Some(3));

    std::fs::remove_dir_all(dir).ok();
}

/// ② CSV 导入 → 导出往返（真实文件库；导入导出与 transfer 命令同构）
#[test]
fn e2e_import_export_roundtrip_flow() {
    let dir = temp_dir("roundtrip");
    let meta = MetaStore::open(&dir.join("app.db")).unwrap();
    let db_path = dir.join("rt.db");
    meta.insert_connection(&connection_row("conn_rt", "往返库", &db_path))
        .unwrap();
    let driver = SqliteDriver::connect(db_path.to_str().unwrap(), false).unwrap();
    tokio_block(async {
        driver
            .execute("CREATE TABLE t (id INTEGER, name TEXT)", 1, 1, &mut NullRowSink)
            .await
            .unwrap();
    });

    let csv_in = dir.join("in.csv");
    std::fs::write(&csv_in, "id,name\n1,O'Brien\n2,张三\n3,\"with,comma\"\n").unwrap();

    // 导入语义：csv → 映射 → 批量字面量 INSERT（与 import_csv 同构）
    let mut reader = csv::ReaderBuilder::new()
        .delimiter(b',')
        .has_headers(false)
        .from_path(&csv_in)
        .unwrap();
    let mut records = reader.records();
    records.next(); // 表头
    let mut batch: Vec<Vec<Cell>> = Vec::new();
    for record in records {
        let record = record.unwrap();
        batch.push(
            (0..2)
                .map(|index| match record.get(index) {
                    None | Some("") => Cell::Null,
                    Some(value) => Cell::Text(value.to_owned()),
                })
                .collect(),
        );
    }
    let values = batch
        .iter()
        .map(|cells| {
            let literals: Vec<String> = cells.iter().map(lattice_lib::db::export::sql_value).collect();
            format!("({})", literals.join(", "))
        })
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!("INSERT INTO \"t\" (\"id\", \"name\") VALUES {values}");
    tokio_block(async {
        driver.execute(&sql, 1, 1, &mut NullRowSink).await.unwrap();
    });

    // 导出语义：流式读出 → CsvWriter → 逐字节比对（第三行字段含逗号须引号转义）
    let collected: SharedRows = Arc::new(Mutex::new(Vec::new()));
    tokio_block(async {
        let mut sink = CollectRows {
            rows: Arc::clone(&collected),
        };
        driver
            .execute("SELECT id, name FROM t", 100, 2, &mut sink)
            .await
            .unwrap();
    });
    let rows = collected.lock().unwrap().clone();
    assert_eq!(rows.len(), 3);

    let out_path = dir.join("out.csv");
    let file = std::fs::File::create(&out_path).unwrap();
    let mut writer = CsvWriter::new(file, ExportEncoding::Utf8, LineSeparator::Lf);
    writer.start(&["id".into(), "name".into()], None).unwrap();
    for row_cells in &rows {
        writer.write_row(row_cells).unwrap();
    }
    writer.finish().unwrap();
    let written = std::fs::read_to_string(&out_path).unwrap();
    assert_eq!(written, "id,name\n1,O'Brien\n2,张三\n3,\"with,comma\"\n");

    let _ = meta;
    std::fs::remove_dir_all(dir).ok();
}

/// ③ 连接管理生命周期：真实文件库 CRUD + 收藏 + 标签会话 + 设置 + 迁移幂等
#[test]
fn e2e_connection_lifecycle_flow() {
    let dir = temp_dir("lifecycle");
    let db_path = dir.join("app.db");
    let meta = MetaStore::open(&db_path).unwrap();
    assert_eq!(meta.list_connections().unwrap().len(), 0);

    let mut row = ConnectionRow {
        id: "conn_a".into(),
        name: "本地".into(),
        driver: "postgres".into(),
        host: Some("127.0.0.1".into()),
        port: Some(5432),
        database: Some("postgres".into()),
        username: Some("postgres".into()),
        ssl_mode: Some("prefer".into()),
        color: Some("#4F8CFF".into()),
        group_name: None,
        read_only: false,
        created_at: 1,
        updated_at: 1,
    };
    meta.insert_connection(&row).unwrap();
    row.name = "本地改名".into();
    meta.update_connection(&row).unwrap();
    assert_eq!(meta.get_connection("conn_a").unwrap().unwrap().name, "本地改名");

    meta.set_connection_favorite("conn_a", true).unwrap();
    assert!(meta.is_favorite("conn_a").unwrap());

    meta.replace_tabs_session(&[TabRecord {
        id: "tab_1".into(),
        connection_id: Some("conn_a".into()),
        title: Some("查询".into()),
        sql: Some("SELECT 1;".into()),
        scroll_top: Some(0),
        cursor_from: Some(0),
        cursor_to: Some(8),
        updated_at: 5,
    }])
    .unwrap();
    meta.set_setting("query.max_rows", "12345").unwrap();

    // 重新打开（模拟重启）：迁移幂等 + 数据持久
    drop(meta);
    let reopened = MetaStore::open(&db_path).unwrap();
    let connections = reopened.list_connections().unwrap();
    assert_eq!(connections.len(), 1);
    assert_eq!(connections[0].name, "本地改名");
    assert!(reopened.is_favorite("conn_a").unwrap());
    let tabs = reopened.list_tabs_session().unwrap();
    assert_eq!(tabs.len(), 1);
    assert_eq!(tabs[0].cursor_to, Some(8));
    assert_eq!(
        reopened.get_setting("query.max_rows").unwrap().as_deref(),
        Some("12345")
    );

    reopened.delete_connection("conn_a").unwrap();
    assert!(reopened.get_connection("conn_a").unwrap().is_none());

    std::fs::remove_dir_all(dir).ok();
}
