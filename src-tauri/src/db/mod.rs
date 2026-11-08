pub mod driver;
pub mod export;
pub mod execution;
pub mod manager;
pub mod mysql;
pub mod postgres;
pub mod sql_classify;
pub mod sql_format;
pub mod sql_split;
pub mod sqlite;
pub mod value;

/// 驱动连接所需的连接信息（不含密码；密码经钥匙串获取）
#[derive(Debug, Clone)]
pub struct ConnectionMeta {
    pub host: String,
    pub port: u16,
    pub database: String,
    pub username: String,
    pub ssl_mode: String,
}

impl ConnectionMeta {
    /// 以指定 database 覆盖行内默认库（支撑跨库懒加载浏览）
    pub fn from_row(row: &crate::store::meta::ConnectionRow, database: &str) -> Self {
        Self::from_row_with_default_port(row, database, 5432)
    }

    /// 指定默认端口（MySQL 3306；SQLite 不经网络，端口值无意义）
    pub fn from_row_with_default_port(
        row: &crate::store::meta::ConnectionRow,
        database: &str,
        default_port: u16,
    ) -> Self {
        Self {
            host: row.host.clone().unwrap_or_else(|| "127.0.0.1".into()),
            port: row
                .port
                .and_then(|p| u16::try_from(p).ok())
                .unwrap_or(default_port),
            database: database.to_owned(),
            username: row
                .username
                .clone()
                .unwrap_or_else(|| "postgres".into()),
            ssl_mode: row.ssl_mode.clone().unwrap_or_else(|| "prefer".into()),
        }
    }
}
