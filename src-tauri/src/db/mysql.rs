//! MySQL 驱动（mysql_async）：读取语句经 `query_iter` 流式取行（二进制协议
//! 真实类型），写/其他语句取 affected 后即弃。取消 = 中止执行任务（连接随
//! 任务丢弃，服务端检测断连后中止查询）；只读会话在每次取连接后设置。

use std::time::{Duration, Instant};

use mysql_async::prelude::Queryable;
use mysql_async::{Conn, Opts, OptsBuilder, Pool, SslOpts};

use crate::db::driver::{
    Cell, ColumnMeta, DatabaseDriver, NodePath, NullRowSink, RowSink, StatementOutcome, TreeNode,
    TreeNodeKind,
};
use crate::db::postgres::ClassifiedError;
use crate::db::sql_classify::{classify, StatementClass};
use crate::db::ConnectionMeta;
use crate::error::{AppError, AppResult};

/// 连接超时（含 TLS 握手）；测试连接为规格要求的 3s
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);

const SYSTEM_DATABASES: [&str; 4] = ["information_schema", "mysql", "performance_schema", "sys"];

/// mysql_async 错误 → 统一分类（供 test_connection 与执行链路）
pub fn classify_mysql(err: &mysql_async::Error) -> ClassifiedError {
    let message = err.to_string();
    let lower = message.to_lowercase();
    if lower.contains("certificate")
        || lower.contains("tls")
        || lower.contains("ssl")
        || lower.contains("handshake")
    {
        return ClassifiedError {
            kind: crate::db::postgres::TestErrorKind::Ssl,
            message,
        };
    }
    if let mysql_async::Error::Server(server) = err {
        let kind = match server.code {
            1044 | 1045 | 1698 | 1827 | 2061 => crate::db::postgres::TestErrorKind::Auth,
            1049 | 1050 => crate::db::postgres::TestErrorKind::Database,
            _ => crate::db::postgres::TestErrorKind::Unknown,
        };
        return ClassifiedError { kind, message };
    }
    if let mysql_async::Error::Io(_) = err {
        return ClassifiedError {
            kind: crate::db::postgres::TestErrorKind::Network,
            message,
        };
    }
    ClassifiedError {
        kind: crate::db::postgres::TestErrorKind::Unknown,
        message,
    }
}

fn to_app(err: mysql_async::Error) -> AppError {
    match err {
        mysql_async::Error::Other(_) => AppError::Internal(err.to_string()),
        _ => AppError::Conn(classify_mysql(&err).message),
    }
}

fn is_binary_column(column: &mysql_async::Column) -> bool {
    use mysql_async::consts::ColumnType;
    matches!(
        column.column_type(),
        ColumnType::MYSQL_TYPE_BLOB
            | ColumnType::MYSQL_TYPE_TINY_BLOB
            | ColumnType::MYSQL_TYPE_MEDIUM_BLOB
            | ColumnType::MYSQL_TYPE_LONG_BLOB
            | ColumnType::MYSQL_TYPE_GEOMETRY
    )
}

fn row_cells(row: &mysql_async::Row, binary_flags: &[bool]) -> Vec<Cell> {
    (0..row.len())
        .map(|index| match row.as_ref(index) {
            None => Cell::Null,
            Some(value) => crate::db::value::cell_from_mysql(
                value.clone(),
                binary_flags.get(index).copied().unwrap_or(false),
            ),
        })
        .collect()
}

/// 消费方叫停的哨兵已移除：`QueryResult::next` 逐行消费可自然提前停
fn ms(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

#[derive(Clone)]
pub struct MysqlDriver {
    pool: Pool,
    read_only: bool,
}

fn build_opts(meta: &ConnectionMeta, password: &str, tls: bool) -> Pool {
    let mut builder = OptsBuilder::default()
        .ip_or_hostname(meta.host.clone())
        .tcp_port(meta.port)
        .db_name(Some(meta.database.clone()))
        .user(Some(meta.username.clone()))
        .pass(Some(password));
    if tls {
        builder = builder.ssl_opts(SslOpts::default());
    }
    Pool::new(Opts::from(builder))
}

/// 建池后立即自检（SELECT 1），带超时；失败时按分类返回
async fn connect_with(
    pool: Pool,
    timeout: Duration,
) -> Result<Pool, ClassifiedError> {
    let mut conn = tokio::time::timeout(timeout, pool.get_conn())
        .await
        .map_err(|_| ClassifiedError {
            kind: crate::db::postgres::TestErrorKind::Network,
            message: format!("连接超时（{}秒）", timeout.as_secs()),
        })?
        .map_err(|err| classify_mysql(&err))?;
    conn.query_drop("SELECT 1")
        .await
        .map_err(|err| classify_mysql(&err))?;
    Ok(pool)
}

impl MysqlDriver {
    pub async fn connect(
        meta: &ConnectionMeta,
        password: &str,
        timeout: Duration,
    ) -> Result<Self, ClassifiedError> {
        let pool = match meta.ssl_mode.as_str() {
            "disable" => build_opts(meta, password, false),
            "prefer" => {
                match connect_with(build_opts(meta, password, true), timeout).await {
                    Ok(pool) => pool,
                    Err(_) => build_opts(meta, password, false),
                }
            }
            _ => build_opts(meta, password, true),
        };
        let pool = connect_with(pool, timeout).await?;

        log::debug!(
            "mysql 连接建立：{}@{}:{}/{}",
            meta.username,
            meta.host,
            meta.port,
            meta.database
        );
        Ok(Self {
            pool,
            read_only: false,
        })
    }

    /// 只读连接标记（连接池建立后由管理器注入）
    pub fn set_read_only(&mut self, read_only: bool) {
        self.read_only = read_only;
    }

    async fn checkout(&self) -> AppResult<Conn> {
        self.pool.get_conn().await.map_err(to_app)
    }
}

impl DatabaseDriver for MysqlDriver {
    fn name(&self) -> &'static str {
        "mysql"
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
        if sql.trim().is_empty() {
            return Err(AppError::Input("SQL 不能为空".into()));
        }
        let started = Instant::now();
        let class = classify(sql);
        let mut conn = self.checkout().await?;
        if self.read_only {
            conn.query_drop("SET SESSION TRANSACTION READ ONLY")
                .await
                .map_err(to_app)?;
        }

        match class {
            StatementClass::Read => {
                let mut result = conn.query_iter(sql).await.map_err(to_app)?;
                let binary_flags: Vec<bool> =
                    result.columns_ref().iter().map(is_binary_column).collect();
                sink.columns(
                    result
                        .columns_ref()
                        .iter()
                        .map(|column| ColumnMeta {
                            name: column.name_str().into_owned(),
                            type_name: format!("{:?}", column.column_type()),
                        })
                        .collect(),
                );

                let cap = u64::try_from(cap).unwrap_or(u64::MAX).max(1);
                let batch_size = batch.max(1);
                let mut buffer: Vec<Vec<Cell>> = Vec::with_capacity(batch_size);
                let mut rows_total: u64 = 0;
                let mut truncated = false;
                let mut stopped = false;

                // QueryResult::next 逐行消费：上限/叫停时自然短路
                while let Some(row) = result.next().await.map_err(to_app)? {
                    if rows_total >= cap {
                        truncated = true;
                        break;
                    }
                    buffer.push(row_cells(&row, &binary_flags));
                    rows_total += 1;
                    if buffer.len() >= batch_size {
                        if !sink.rows(std::mem::take(&mut buffer)) {
                            stopped = true;
                            truncated = true;
                            break;
                        }
                        buffer = Vec::with_capacity(batch_size);
                    }
                }
                if !buffer.is_empty() && !stopped {
                    sink.rows(buffer);
                }
                if stopped || truncated {
                    // 提前放弃后续行：主动断开，避免脏连接回池
                    drop(result);
                    conn.disconnect().await.map_err(to_app)?;
                }
                Ok(StatementOutcome {
                    rows_total,
                    rows_affected: 0,
                    truncated: truncated || stopped,
                    duration_ms: ms(started),
                })
            }
            StatementClass::Write | StatementClass::Other => {
                let result = conn.query_iter(sql).await.map_err(to_app)?;
                let affected = result.affected_rows();
                // 主动断开：丢弃可能残留的结果集，避免脏连接回池
                drop(result);
                conn.disconnect().await.map_err(to_app)?;
                Ok(StatementOutcome {
                    rows_total: 0,
                    rows_affected: affected,
                    truncated: false,
                    duration_ms: ms(started),
                })
            }
        }
    }

    async fn children(&self, path: &NodePath) -> AppResult<Vec<TreeNode>> {
        let mut conn = self.checkout().await?;
        match path {
            NodePath::Databases => {
                let rows: Vec<String> = conn
                    .query("SHOW DATABASES")
                    .await
                    .map_err(to_app)?;
                Ok(rows
                    .into_iter()
                    .map(|name| TreeNode {
                        id: format!(
                            "db/{}",
                            crate::db::driver::encode_segment(&name)
                        ),
                        label: name.clone(),
                        node_kind: TreeNodeKind::Database,
                        has_children: true,
                        is_system: SYSTEM_DATABASES.contains(&name.as_str()),
                        meta: None,
                    })
                    .collect())
            }
            NodePath::Schemas { database } => {
                // MySQL 的 schema 即 database 本身
                Ok(vec![TreeNode {
                    id: format!(
                        "schemas/{}/{}",
                        crate::db::driver::encode_segment(database),
                        crate::db::driver::encode_segment(database)
                    ),
                    label: database.clone(),
                    node_kind: TreeNodeKind::Schema,
                    has_children: true,
                    is_system: SYSTEM_DATABASES.contains(&database.as_str()),
                    meta: None,
                }])
            }
            NodePath::Objects { schema, object_kind, .. } => {
                let nodes = match object_kind {
                    crate::db::driver::ObjectKind::Tables => {
                        let names: Vec<String> = conn
                            .exec(
                                "SELECT table_name FROM information_schema.tables
                                 WHERE table_schema = ? AND table_type = 'BASE TABLE'
                                 ORDER BY table_name",
                                (schema.clone(),),
                            )
                            .await
                            .map_err(to_app)?;
                        names
                            .into_iter()
                            .map(|name| TreeNode {
                                id: format!(
                                    "objects/{}/{}/tables/{}",
                                    crate::db::driver::encode_segment(schema),
                                    crate::db::driver::encode_segment(schema),
                                    crate::db::driver::encode_segment(&name)
                                ),
                                label: name,
                                node_kind: TreeNodeKind::Table,
                                has_children: false,
                                is_system: false,
                                meta: None,
                            })
                            .collect()
                    }
                    crate::db::driver::ObjectKind::Views => {
                        let names: Vec<String> = conn
                            .exec(
                                "SELECT table_name FROM information_schema.tables
                                 WHERE table_schema = ? AND table_type = 'VIEW'
                                 ORDER BY table_name",
                                (schema.clone(),),
                            )
                            .await
                            .map_err(to_app)?;
                        names
                            .into_iter()
                            .map(|name| TreeNode {
                                id: format!(
                                    "objects/{}/{}/views/{}",
                                    crate::db::driver::encode_segment(schema),
                                    crate::db::driver::encode_segment(schema),
                                    crate::db::driver::encode_segment(&name)
                                ),
                                label: name,
                                node_kind: TreeNodeKind::View,
                                has_children: false,
                                is_system: false,
                                meta: None,
                            })
                            .collect()
                    }
                    crate::db::driver::ObjectKind::Functions => {
                        let names: Vec<String> = conn
                            .exec(
                                "SELECT routine_name FROM information_schema.routines
                                 WHERE routine_schema = ? AND routine_type = 'FUNCTION'
                                 ORDER BY routine_name",
                                (schema.clone(),),
                            )
                            .await
                            .map_err(to_app)?;
                        names
                            .into_iter()
                            .map(|name| TreeNode {
                                id: format!(
                                    "objects/{}/{}/functions/{}",
                                    crate::db::driver::encode_segment(schema),
                                    crate::db::driver::encode_segment(schema),
                                    crate::db::driver::encode_segment(&name)
                                ),
                                label: name,
                                node_kind: TreeNodeKind::Function,
                                has_children: false,
                                is_system: false,
                                meta: None,
                            })
                            .collect()
                    }
                    crate::db::driver::ObjectKind::Sequences => Vec::new(),
                };
                Ok(nodes)
            }
        }
    }

    async fn describe_table(&self, schema: &str, table: &str) -> AppResult<Vec<ColumnMeta>> {
        let mut conn = self.checkout().await?;
        let rows: Vec<(String, String)> = conn
            .exec(
                "SELECT column_name, data_type FROM information_schema.columns
                 WHERE table_schema = ? AND table_name = ?
                 ORDER BY ordinal_position",
                (schema.to_owned(), table.to_owned()),
            )
            .await
            .map_err(to_app)?;
        Ok(rows
            .into_iter()
            .map(|(name, type_name)| ColumnMeta { name, type_name })
            .collect())
    }

    async fn apply_read_only(&self) -> AppResult<()> {
        // 池化连接无法一次性设置：每次 execute 取连接后按 read_only 标记设置
        Ok(())
    }

    async fn describe_erd(&self, schema: &str) -> AppResult<Vec<crate::db::driver::ErdTable>> {
        use crate::db::driver::{ErdForeignKey, ErdTable};
        use std::collections::HashMap;

        let mut conn = self.checkout().await?;
        let column_rows: Vec<(String, String, String)> = conn
            .exec(
                "SELECT table_name, column_name, data_type FROM information_schema.columns
                 WHERE table_schema = ? ORDER BY table_name, ordinal_position",
                (schema.to_owned(),),
            )
            .await
            .map_err(to_app)?;
        let pk_rows: Vec<(String, String)> = conn
            .exec(
                "SELECT table_name, column_name FROM information_schema.key_column_usage
                 WHERE table_schema = ? AND constraint_name = 'PRIMARY'
                 ORDER BY table_name, ordinal_position",
                (schema.to_owned(),),
            )
            .await
            .map_err(to_app)?;
        let fk_rows: Vec<(String, String, String, String)> = conn
            .exec(
                "SELECT table_name, column_name, referenced_table_name, referenced_column_name
                 FROM information_schema.key_column_usage
                 WHERE table_schema = ? AND referenced_table_name IS NOT NULL",
                (schema.to_owned(),),
            )
            .await
            .map_err(to_app)?;
        drop(conn);

        let mut tables: HashMap<String, ErdTable> = HashMap::new();
        for (table, column, data_type) in column_rows {
            let entry = tables.entry(table.clone()).or_insert_with(|| ErdTable {
                name: table,
                columns: Vec::new(),
                primary_keys: Vec::new(),
                foreign_keys: Vec::new(),
            });
            entry.columns.push(ColumnMeta {
                name: column,
                type_name: data_type,
            });
        }
        for (table, column) in pk_rows {
            if let Some(entry) = tables.get_mut(table.as_str()) {
                entry.primary_keys.push(column);
            }
        }
        for (table, column, ref_table, ref_column) in fk_rows {
            if let Some(entry) = tables.get_mut(table.as_str()) {
                entry.foreign_keys.push(ErdForeignKey {
                    column,
                    ref_table,
                    ref_column,
                });
            }
        }
        let mut list: Vec<ErdTable> = tables.into_values().collect();
        list.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(list)
    }

    async fn primary_keys(&self, schema: &str, table: &str) -> AppResult<Vec<String>> {
        let mut conn = self.checkout().await?;
        let rows: Vec<(String,)> = conn
            .exec(
                "SELECT column_name FROM information_schema.key_column_usage
                 WHERE table_schema = ? AND table_name = ? AND constraint_name = 'PRIMARY'
                 ORDER BY ordinal_position",
                (schema.to_owned(), table.to_owned()),
            )
            .await
            .map_err(to_app)?;
        drop(conn);
        Ok(rows.into_iter().map(|(column,)| column).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_mysql_server_errors() {
        let auth = mysql_async::Error::Server(mysql_async::ServerError {
            state: "28000".into(),
            code: 1045,
            message: "Access denied".into(),
        });
        assert_eq!(
            classify_mysql(&auth).kind,
            crate::db::postgres::TestErrorKind::Auth
        );
        let db = mysql_async::Error::Server(mysql_async::ServerError {
            state: "HY000".into(),
            code: 1049,
            message: "Unknown database".into(),
        });
        assert_eq!(
            classify_mysql(&db).kind,
            crate::db::postgres::TestErrorKind::Database
        );
        let io = mysql_async::Error::Io(mysql_async::IoError::Io(std::io::Error::new(
            std::io::ErrorKind::ConnectionRefused,
            "refused",
        )));
        assert_eq!(
            classify_mysql(&io).kind,
            crate::db::postgres::TestErrorKind::Network
        );
    }

    #[test]
    fn binary_column_detection() {
        use mysql_async::consts::ColumnType;
        assert!(is_binary_column_type(ColumnType::MYSQL_TYPE_BLOB));
        assert!(is_binary_column_type(ColumnType::MYSQL_TYPE_LONG_BLOB));
        assert!(!is_binary_column_type(ColumnType::MYSQL_TYPE_VAR_STRING));
    }

    fn is_binary_column_type(column_type: mysql_async::consts::ColumnType) -> bool {
        use mysql_async::consts::ColumnType;
        matches!(
            column_type,
            ColumnType::MYSQL_TYPE_BLOB
                | ColumnType::MYSQL_TYPE_TINY_BLOB
                | ColumnType::MYSQL_TYPE_MEDIUM_BLOB
                | ColumnType::MYSQL_TYPE_LONG_BLOB
                | ColumnType::MYSQL_TYPE_GEOMETRY
        )
    }
}
