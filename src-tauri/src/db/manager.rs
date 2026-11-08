//! 常驻连接池：按 (connection_id, database) 维护驱动句柄；
//! 懒建立、显式断开、配置变更后整体失效；只读连接在建立后强制会话只读。

use std::collections::HashMap;

use tokio::sync::Mutex;

use crate::db::driver::DriverHandle;
use crate::db::mysql::{MysqlDriver, CONNECT_TIMEOUT as MYSQL_TIMEOUT};
use crate::db::postgres::{PostgresDriver, CONNECT_TIMEOUT};
use crate::db::sqlite::SqliteDriver;
use crate::db::ConnectionMeta;
use crate::error::{AppError, AppResult};
use crate::store::meta::ConnectionRow;
use crate::store::secrets;

pub struct ConnectionManager {
    slots: Mutex<HashMap<String, DriverHandle>>,
}

impl Default for ConnectionManager {
    fn default() -> Self {
        Self::new()
    }
}

impl ConnectionManager {
    pub fn new() -> Self {
        Self {
            slots: Mutex::new(HashMap::new()),
        }
    }

    fn key(id: &str, database: &str) -> String {
        format!("{id}:{database}")
    }

    /// 取常驻句柄；不存在则现场连接（读连接行 + 钥匙串密码 → 按驱动分发）
    pub async fn get_or_connect(
        &self,
        row: &ConnectionRow,
        database: &str,
    ) -> AppResult<DriverHandle> {
        let key = Self::key(&row.id, database);
        if let Some(handle) = self.slots.lock().await.get(&key) {
            return Ok(handle.clone());
        }

        let handle = match row.driver.as_str() {
            "postgres" => {
                let password = secrets::load_password(&row.id)?.ok_or_else(|| {
                    AppError::Conn("凭据缺失：请编辑该连接并重新保存密码".into())
                })?;
                let meta = ConnectionMeta::from_row(row, database);
                let driver = PostgresDriver::connect(&meta, &password, CONNECT_TIMEOUT)
                    .await
                    .map_err(|e| AppError::Conn(e.to_string()))?;
                DriverHandle::Postgres(driver)
            }
            "mysql" => {
                let password = secrets::load_password(&row.id)?.ok_or_else(|| {
                    AppError::Conn("凭据缺失：请编辑该连接并重新保存密码".into())
                })?;
                let meta =
                    ConnectionMeta::from_row_with_default_port(row, database, 3306);
                let mut driver = MysqlDriver::connect(&meta, &password, MYSQL_TIMEOUT)
                    .await
                    .map_err(|e| AppError::Conn(e.to_string()))?;
                driver.set_read_only(row.read_only);
                DriverHandle::Mysql(driver)
            }
            "sqlite" => {
                let path = row.database.clone().ok_or_else(|| {
                    AppError::Input("SQLite 连接缺少数据库文件路径".into())
                })?;
                let driver = SqliteDriver::connect(&path, row.read_only)?;
                DriverHandle::Sqlite(driver)
            }
            other => {
                return Err(AppError::Input(format!("不支持的驱动：{other}")));
            }
        };

        // 只读连接：会话级强制（SQLite 已在打开时生效）
        if row.read_only {
            handle.apply_read_only().await?;
        }
        // 入池前自检：验证连接真实可用（同时固化 ping→execute 链路）
        handle.ping().await?;
        log::debug!(
            "连接入池：{}:{} driver={} read_only={}",
            row.id,
            database,
            handle.name(),
            row.read_only
        );
        self.slots.lock().await.insert(key, handle.clone());
        Ok(handle)
    }

    /// 断开某连接的全部句柄（跨库）
    pub async fn disconnect(&self, id: &str) -> AppResult<()> {
        let prefix = format!("{id}:");
        self.slots.lock().await.retain(|key, _| !key.starts_with(&prefix));
        Ok(())
    }

    pub async fn is_connected(&self, id: &str) -> bool {
        let prefix = format!("{id}:");
        self.slots.lock().await.keys().any(|key| key.starts_with(&prefix))
    }
}
