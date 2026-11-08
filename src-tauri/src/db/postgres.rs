//! PostgreSQL 驱动（tokio-postgres）。
//! query 走 simple_query 协议：值以文本返回（免类型解码，天然支持多语句），
//! 参数绑定类操作由阶段三/四的专用路径实现。

use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::io::{AsyncRead, AsyncWrite};
use tokio_postgres::config::SslMode;
use tokio_postgres::error::SqlState;
use tokio_postgres::{CancelToken, Client, Connection, NoTls, SimpleQueryMessage};

use crate::db::driver::{
    encode_segment, Cell, ColumnMeta, DatabaseDriver, NodePath, NullRowSink, ObjectKind, RowSink,
    StatementOutcome, TreeNode, TreeNodeKind,
};
use crate::db::ConnectionMeta;
use crate::error::{AppError, AppResult};

/// 连接（含 TLS 握手）超时：测试连接为规格要求的 3s
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TestErrorKind {
    Network,
    Auth,
    Database,
    Ssl,
    Unknown,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestError {
    pub kind: TestErrorKind,
    pub message: String,
}

/// 带分类的连接失败（供 test_connection 与 connect 两路消费）
#[derive(Debug, Clone)]
pub struct ClassifiedError {
    pub kind: TestErrorKind,
    pub message: String,
}

impl TestError {
    pub fn label(kind: TestErrorKind) -> &'static str {
        match kind {
            TestErrorKind::Network => "网络不可达",
            TestErrorKind::Auth => "认证失败",
            TestErrorKind::Database => "数据库不存在",
            TestErrorKind::Ssl => "SSL 错误",
            TestErrorKind::Unknown => "连接失败",
        }
    }
}

impl std::fmt::Display for ClassifiedError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}：{}", TestError::label(self.kind), self.message)
    }
}

impl From<ClassifiedError> for TestError {
    fn from(value: ClassifiedError) -> Self {
        Self {
            kind: value.kind,
            message: value.message,
        }
    }
}

/// io 错误分类：TLS 关键词优先，其余连接期 io 错误一律归网络
fn classify_io(io: &std::io::Error) -> TestErrorKind {
    let message = io.to_string().to_lowercase();
    let ssl_hint = ["certificate", "tls", "ssl", "handshake", "alert"]
        .iter()
        .any(|keyword| message.contains(keyword));
    if ssl_hint {
        return TestErrorKind::Ssl;
    }
    match io.kind() {
        std::io::ErrorKind::ConnectionRefused
        | std::io::ErrorKind::ConnectionReset
        | std::io::ErrorKind::ConnectionAborted
        | std::io::ErrorKind::BrokenPipe
        | std::io::ErrorKind::TimedOut
        | std::io::ErrorKind::UnexpectedEof
        | std::io::ErrorKind::AddrNotAvailable
        | std::io::ErrorKind::PermissionDenied
        | std::io::ErrorKind::Interrupted
        | std::io::ErrorKind::NotConnected => TestErrorKind::Network,
        _ => TestErrorKind::Network,
    }
}

/// 服务端错误分类（纯函数，可单测）
fn classify_sql_state(code: &SqlState) -> TestErrorKind {
    if *code == SqlState::INVALID_PASSWORD || *code == SqlState::INVALID_AUTHORIZATION_SPECIFICATION
    {
        TestErrorKind::Auth
    } else if *code == SqlState::INVALID_CATALOG_NAME {
        TestErrorKind::Database
    } else if *code == SqlState::CONNECTION_EXCEPTION
        || *code == SqlState::CONNECTION_DOES_NOT_EXIST
        || *code == SqlState::CONNECTION_FAILURE
    {
        TestErrorKind::Network
    } else {
        TestErrorKind::Unknown
    }
}

fn classify(err: &tokio_postgres::Error) -> ClassifiedError {
    if let Some(code) = err.code() {
        return ClassifiedError {
            kind: classify_sql_state(code),
            message: err.to_string(),
        };
    }
    let mut source: Option<&(dyn std::error::Error + 'static)> = Some(err);
    while let Some(current) = source {
        if let Some(io) = current.downcast_ref::<std::io::Error>() {
            return ClassifiedError {
                kind: classify_io(io),
                message: io.to_string(),
            };
        }
        source = current.source();
    }
    ClassifiedError {
        kind: TestErrorKind::Unknown,
        message: err.to_string(),
    }
}

fn make_rustls_connect() -> Result<tokio_postgres_rustls::MakeRustlsConnect, ClassifiedError> {
    let roots = rustls::RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    };
    let config = rustls::ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    Ok(tokio_postgres_rustls::MakeRustlsConnect::new(config))
}

/// 建立连接后立即派生后台任务；连接错误经统一分类
async fn spawn_connect<S, T>(
    result: Result<(Client, Connection<S, T>), tokio_postgres::Error>,
) -> Result<Client, ClassifiedError>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    T: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    match result {
        Ok((client, task)) => {
            tokio::spawn(task);
            Ok(client)
        }
        Err(err) => Err(classify(&err)),
    }
}

/// 目录查询结果 → 树节点的映射闭包
type NodeMapper = Box<dyn Fn(String, String) -> TreeNode + Send>;

/// 取消查询所需的 TLS 连接器（与建立连接时一致）
#[derive(Clone)]
pub enum PgTls {
    None,
    Rustls(tokio_postgres_rustls::MakeRustlsConnect),
}

#[derive(Clone)]
pub struct PostgresDriver {
    client: Arc<Client>,
    cancel_token: CancelToken,
    tls: PgTls,
}

impl PostgresDriver {
    pub async fn connect(
        meta: &ConnectionMeta,
        password: &str,
        timeout: Duration,
    ) -> Result<Self, ClassifiedError> {
        let mut cfg = tokio_postgres::Config::new();
        cfg.host(&meta.host)
            .port(meta.port)
            .user(&meta.username)
            .dbname(&meta.database)
            .password(password);
        cfg.ssl_mode(if meta.ssl_mode == "disable" {
            SslMode::Disable
        } else {
            SslMode::Require
        });

        let connected = tokio::time::timeout(timeout, async {
            match meta.ssl_mode.as_str() {
                "disable" => Ok(spawn_connect(cfg.connect(NoTls).await).await?),
                // prefer：先 TLS 后回退明文
                "prefer" => {
                    let rustls = make_rustls_connect()?;
                    match spawn_connect(cfg.connect(rustls.clone()).await).await {
                        Ok(client) => Ok(client),
                        Err(_) => spawn_connect(cfg.connect(NoTls).await).await,
                    }
                }
                _ => {
                    let rustls = make_rustls_connect()?;
                    spawn_connect(cfg.connect(rustls.clone()).await).await
                }
            }
        })
        .await;

        match connected {
            Ok(Ok(client)) => {
                let tls = match meta.ssl_mode.as_str() {
                    "disable" => PgTls::None,
                    // prefer 实际可能回退明文，但 cancel_query 用 TLS 连接器发送
                    // 取消请求时无需与数据连接共用通道，保留 TLS 版本即可
                    "prefer" | "require" | "verify-ca" | "verify-full" => {
                        PgTls::Rustls(make_rustls_connect()?)
                    }
                    _ => PgTls::None,
                };
                let cancel_token = client.cancel_token();
                log::debug!(
                    "pg 连接建立：{}@{}:{}/{}",
                    meta.username,
                    meta.host,
                    meta.port,
                    meta.database
                );
                Ok(Self {
                    client: Arc::new(client),
                    cancel_token,
                    tls,
                })
            }
            Ok(Err(classified)) => Err(classified),
            Err(_) => Err(ClassifiedError {
                kind: TestErrorKind::Network,
                message: format!("连接超时（{}秒）", timeout.as_secs()),
            }),
        }
    }

    /// 取消正在执行的查询（服务端发 SIGINT 语义，执行侧收到 57014）
    pub async fn cancel(&self) -> AppResult<()> {
        let result = match &self.tls {
            PgTls::None => self.cancel_token.cancel_query(NoTls).await,
            PgTls::Rustls(connector) => self.cancel_token.cancel_query(connector.clone()).await,
        };
        result.map_err(|err| AppError::Conn(format!("取消查询失败：{err}")))
    }
}

fn conn_err(err: tokio_postgres::Error) -> AppError {
    AppError::Conn(err.to_string())
}

impl DatabaseDriver for PostgresDriver {
    fn name(&self) -> &'static str {
        "postgres"
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
        let messages = self.client.simple_query(sql).await.map_err(conn_err)?;

        // simple 协议不暴露列类型；bytea 经 \x 前缀在网格层识别
        let mut columns: Vec<ColumnMeta> = Vec::new();
        let mut rows_affected: u64 = 0;
        let mut all_rows: Vec<Vec<Cell>> = Vec::new();
        for message in messages {
            match message {
                SimpleQueryMessage::RowDescription(cols) => {
                    if columns.is_empty() {
                        columns = cols
                            .iter()
                            .map(|column| ColumnMeta {
                                name: column.name().to_owned(),
                                type_name: String::new(),
                            })
                            .collect();
                    }
                }
                SimpleQueryMessage::Row(row) => {
                    all_rows.push(
                        (0..row.len())
                            .map(|index| match row.get(index) {
                                Some(value) => Cell::Text(value.to_owned()),
                                None => Cell::Null,
                            })
                            .collect(),
                    );
                }
                SimpleQueryMessage::CommandComplete(affected) => rows_affected += affected,
                #[allow(unreachable_patterns)] // 保留前向兼容
                _ => {}
            }
        }

        let cap = cap.max(1);
        let batch = batch.max(1);
        sink.columns(columns);
        let mut truncated = all_rows.len() > cap;
        let mut delivered = 0usize;
        for chunk in all_rows[..all_rows.len().min(cap)].chunks(batch) {
            if !sink.rows(chunk.to_vec()) {
                truncated = true;
                break;
            }
            delivered += chunk.len();
        }
        Ok(StatementOutcome {
            rows_total: delivered as u64,
            rows_affected,
            truncated,
            duration_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        })
    }

    async fn describe_table(&self, schema: &str, table: &str) -> AppResult<Vec<ColumnMeta>> {
        let rows = self
            .client
            .query(
                "SELECT column_name, data_type FROM information_schema.columns
                 WHERE table_schema = $1 AND table_name = $2
                 ORDER BY ordinal_position",
                &[&schema, &table],
            )
            .await
            .map_err(conn_err)?;
        Ok(rows
            .iter()
            .map(|row| ColumnMeta {
                name: row.get::<_, String>(0),
                type_name: row.get::<_, String>(1),
            })
            .collect())
    }

    async fn apply_read_only(&self) -> AppResult<()> {
        self.client
            .simple_query("SET default_transaction_read_only = on")
            .await
            .map_err(conn_err)?;
        Ok(())
    }

    async fn children(&self, path: &NodePath) -> AppResult<Vec<TreeNode>> {
        match path {
            NodePath::Databases => {
                let rows = self
                    .client
                    .query(
                        "SELECT datname FROM pg_database
                         WHERE datistemplate = false ORDER BY datname",
                        &[],
                    )
                    .await
                    .map_err(|e| AppError::Conn(e.to_string()))?;
                Ok(rows
                    .iter()
                    .map(|row| {
                        let name: String = row.get(0);
                        TreeNode {
                            id: format!("db/{}", encode_segment(&name)),
                            label: name.clone(),
                            node_kind: TreeNodeKind::Database,
                            has_children: true,
                            is_system: name == "postgres",
                            meta: None,
                        }
                    })
                    .collect())
            }
            NodePath::Schemas { database } => {
                let rows = self
                    .client
                    .query(
                        "SELECT nspname FROM pg_namespace
                         WHERE nspname NOT LIKE 'pg\\_toast%' AND nspname NOT LIKE 'pg\\_temp%'
                         ORDER BY nspname",
                        &[],
                    )
                    .await
                    .map_err(|e| AppError::Conn(e.to_string()))?;
                Ok(rows
                    .iter()
                    .map(|row| {
                        let name: String = row.get(0);
                        let is_system =
                            name == "pg_catalog" || name == "information_schema" || name.starts_with("pg_");
                        TreeNode {
                            id: format!(
                                "schemas/{}/{}",
                                encode_segment(database),
                                encode_segment(&name)
                            ),
                            label: name.clone(),
                            node_kind: TreeNodeKind::Schema,
                            has_children: true,
                            is_system,
                            meta: None,
                        }
                    })
                    .collect())
            }
            NodePath::Objects { database, schema, object_kind } => {
                let base = format!(
                    "objects/{}/{}/{}",
                    encode_segment(database),
                    encode_segment(schema),
                    object_kind.id_segment()
                );
                let (sql, mapper): (&str, NodeMapper) = match object_kind {
                    ObjectKind::Tables => (
                        "SELECT c.relname::text, c.relkind::text FROM pg_class c
                         JOIN pg_namespace n ON n.oid = c.relnamespace
                         WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') ORDER BY c.relname",
                        Box::new(move |name: String, extra: String| TreeNode {
                            id: format!("{base}/{}", encode_segment(&name)),
                            label: name.clone(),
                            node_kind: TreeNodeKind::Table,
                            has_children: false,
                            is_system: false,
                            meta: Some(if extra == "p" { "分区表".into() } else { "表".into() }),
                        }),
                    ),
                    ObjectKind::Views => (
                        "SELECT c.relname::text, c.relkind::text FROM pg_class c
                         JOIN pg_namespace n ON n.oid = c.relnamespace
                         WHERE n.nspname = $1 AND c.relkind IN ('v', 'm') ORDER BY c.relname",
                        Box::new(move |name: String, extra: String| TreeNode {
                            id: format!("{base}/{}", encode_segment(&name)),
                            label: name.clone(),
                            node_kind: TreeNodeKind::View,
                            has_children: false,
                            is_system: false,
                            meta: Some(if extra == "m" { "物化视图".into() } else { "视图".into() }),
                        }),
                    ),
                    ObjectKind::Functions => (
                        "SELECT p.proname::text, pg_get_function_identity_arguments(p.oid) FROM pg_proc p
                         JOIN pg_namespace n ON n.oid = p.pronamespace
                         WHERE n.nspname = $1 AND p.prokind = 'f' ORDER BY p.proname",
                        Box::new(move |name: String, args: String| TreeNode {
                            id: format!("{base}/{}", encode_segment(&name)),
                            label: name.clone(),
                            node_kind: TreeNodeKind::Function,
                            has_children: false,
                            is_system: false,
                            meta: if args.is_empty() { None } else { Some(args) },
                        }),
                    ),
                    ObjectKind::Sequences => (
                        "SELECT sequencename::text, ''::text FROM pg_sequences
                         WHERE schemaname = $1 ORDER BY sequencename",
                        Box::new(move |name: String, _: String| TreeNode {
                            id: format!("{base}/{}", encode_segment(&name)),
                            label: name.clone(),
                            node_kind: TreeNodeKind::Sequence,
                            has_children: false,
                            is_system: false,
                            meta: None,
                        }),
                    ),
                };
                let rows = self
                    .client
                    .query(sql, &[schema])
                    .await
                    .map_err(|e| AppError::Conn(e.to_string()))?;
                Ok(rows
                    .iter()
                    .map(|row| {
                        let name: String = row.get(0);
                        let extra: String = row.get(1);
                        mapper(name, extra)
                    })
                    .collect())
            }
        }
    }

    async fn describe_erd(&self, schema: &str) -> AppResult<Vec<crate::db::driver::ErdTable>> {
        use crate::db::driver::{ErdForeignKey, ErdTable};
        use std::collections::HashMap;

        let column_rows = self
            .client
            .query(
                "SELECT table_name, column_name, data_type FROM information_schema.columns
                 WHERE table_schema = $1 ORDER BY table_name, ordinal_position",
                &[&schema],
            )
            .await
            .map_err(conn_err)?;
        let pk_rows = self
            .client
            .query(
                "SELECT kcu.table_name, kcu.column_name
                 FROM information_schema.table_constraints tc
                 JOIN information_schema.key_column_usage kcu
                   ON tc.constraint_name = kcu.constraint_name
                  AND tc.table_schema = kcu.table_schema
                 WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1
                 ORDER BY kcu.table_name, kcu.ordinal_position",
                &[&schema],
            )
            .await
            .map_err(conn_err)?;
        let fk_rows = self
            .client
            .query(
                "SELECT kcu.table_name, kcu.column_name, ccu.table_name, ccu.column_name
                 FROM information_schema.table_constraints tc
                 JOIN information_schema.key_column_usage kcu
                   ON tc.constraint_name = kcu.constraint_name
                  AND tc.table_schema = kcu.table_schema
                 JOIN information_schema.constraint_column_usage ccu
                   ON ccu.constraint_name = tc.constraint_name
                  AND ccu.table_schema = tc.table_schema
                 WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1",
                &[&schema],
            )
            .await
            .map_err(conn_err)?;

        let mut tables: HashMap<String, ErdTable> = HashMap::new();
        for row in column_rows {
            let table: String = row.get(0);
            let entry = tables.entry(table.clone()).or_insert_with(|| ErdTable {
                name: table,
                columns: Vec::new(),
                primary_keys: Vec::new(),
                foreign_keys: Vec::new(),
            });
            entry.columns.push(ColumnMeta {
                name: row.get::<_, String>(1),
                type_name: row.get::<_, String>(2),
            });
        }
        for row in pk_rows {
            if let Some(entry) = tables.get_mut(row.get::<_, String>(0).as_str()) {
                entry.primary_keys.push(row.get(1));
            }
        }
        for row in fk_rows {
            if let Some(entry) = tables.get_mut(row.get::<_, String>(0).as_str()) {
                entry.foreign_keys.push(ErdForeignKey {
                    column: row.get(1),
                    ref_table: row.get(2),
                    ref_column: row.get(3),
                });
            }
        }
        let mut list: Vec<ErdTable> = tables.into_values().collect();
        list.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(list)
    }

    async fn primary_keys(&self, schema: &str, table: &str) -> AppResult<Vec<String>> {
        let rows = self
            .client
            .query(
                "SELECT kcu.column_name FROM information_schema.table_constraints tc
                 JOIN information_schema.key_column_usage kcu
                   ON tc.constraint_name = kcu.constraint_name
                  AND tc.table_schema = kcu.table_schema
                 WHERE tc.constraint_type = 'PRIMARY KEY'
                   AND tc.table_schema = $1 AND tc.table_name = $2
                 ORDER BY kcu.ordinal_position",
                &[&schema, &table],
            )
            .await
            .map_err(conn_err)?;
        Ok(rows.iter().map(|row| row.get(0)).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::ErrorKind;

    #[test]
    fn classifies_auth_database_and_connection_states() {
        assert_eq!(classify_sql_state(&SqlState::INVALID_PASSWORD), TestErrorKind::Auth);
        assert_eq!(
            classify_sql_state(&SqlState::INVALID_AUTHORIZATION_SPECIFICATION),
            TestErrorKind::Auth
        );
        assert_eq!(classify_sql_state(&SqlState::INVALID_CATALOG_NAME), TestErrorKind::Database);
        assert_eq!(classify_sql_state(&SqlState::CONNECTION_FAILURE), TestErrorKind::Network);
        assert_eq!(classify_sql_state(&SqlState::FEATURE_NOT_SUPPORTED), TestErrorKind::Unknown);
    }

    #[test]
    fn classifies_io_errors_by_kind_and_tls_keywords() {
        assert_eq!(
            classify_io(&std::io::Error::from(ErrorKind::ConnectionRefused)),
            TestErrorKind::Network
        );
        assert_eq!(
            classify_io(&std::io::Error::from(ErrorKind::TimedOut)),
            TestErrorKind::Network
        );
        assert_eq!(
            classify_io(&std::io::Error::new(
                ErrorKind::InvalidData,
                "invalid peer certificate contents"
            )),
            TestErrorKind::Ssl
        );
        assert_eq!(
            classify_io(&std::io::Error::other(
                "received fatal alert: HandshakeFailure"
            )),
            TestErrorKind::Ssl
        );
    }

    #[test]
    fn test_error_display_uses_chinese_label() {
        let err = ClassifiedError {
            kind: TestErrorKind::Auth,
            message: "password authentication failed".to_owned(),
        };
        assert!(err.to_string().starts_with("认证失败："));
    }
}
