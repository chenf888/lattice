use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;

use crate::error::{AppError, AppResult};

use super::migrations;

/// app.db 元数据库句柄；所有操作为同步短事务，绝不跨 await 持锁
pub struct MetaStore {
    conn: Mutex<Connection>,
}

/// connections 表行（含 0002 迁移新增列）
#[derive(Debug, Clone)]
pub struct ConnectionRow {
    pub id: String,
    pub name: String,
    pub driver: String,
    pub host: Option<String>,
    pub port: Option<i64>,
    pub database: Option<String>,
    pub username: Option<String>,
    pub ssl_mode: Option<String>,
    pub color: Option<String>,
    pub group_name: Option<String>,
    pub read_only: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

/// settings 键格式：点分小写标识符，如 ui.theme
fn is_valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.split('.').all(|seg| {
            !seg.is_empty()
                && !seg.starts_with(|c: char| c.is_ascii_digit())
                && seg
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
        })
}

fn poisoned() -> AppError {
    AppError::Internal("meta store lock poisoned".into())
}

/// 离线 id 生成：纳秒时间戳 + 进程内单调计数，无外部依赖
pub fn new_id(prefix: &str) -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}_{nanos:x}{n:x}")
}

fn connection_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ConnectionRow> {
    Ok(ConnectionRow {
        id: row.get("id")?,
        name: row.get("name")?,
        driver: row.get("driver")?,
        host: row.get("host")?,
        port: row.get("port")?,
        database: row.get("database")?,
        username: row.get("username")?,
        ssl_mode: row.get("ssl_mode")?,
        color: row.get("color")?,
        group_name: row.get("group_name")?,
        read_only: row.get::<_, i64>("read_only")? != 0,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

impl MetaStore {
    /// 打开（不存在则创建）指定路径的元数据库并执行迁移；
    /// 连接级 PRAGMA 在此设置（WAL、外键约束、忙等待超时）
    pub fn open(path: &Path) -> AppResult<Self> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        migrations::run(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn get_setting(&self, key: &str) -> AppResult<Option<String>> {
        let conn = self.conn.lock().map_err(|_| poisoned())?;
        let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?1")?;
        let mut rows = stmt.query([key])?;
        match rows.next()? {
            Some(row) => Ok(Some(row.get(0)?)),
            None => Ok(None),
        }
    }

    /// upsert（预编译占位符，无字符串拼接）；键格式非法时拒绝
    pub fn set_setting(&self, key: &str, value: &str) -> AppResult<()> {
        if !is_valid_key(key) {
            return Err(AppError::Input(format!("invalid settings key `{key}`")));
        }
        let conn = self.conn.lock().map_err(|_| poisoned())?;
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [key, value],
        )?;
        Ok(())
    }

    // ── connections ──────────────────────────────────────────

    pub fn list_connections(&self) -> AppResult<Vec<ConnectionRow>> {
        let conn = self.conn.lock().map_err(|_| poisoned())?;
        let mut stmt = conn.prepare(
            "SELECT id, name, driver, host, port, database, username, ssl_mode, color,
                    group_name, read_only, created_at, updated_at
             FROM connections ORDER BY name",
        )?;
        let rows = stmt
            .query_map([], connection_from_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn get_connection(&self, id: &str) -> AppResult<Option<ConnectionRow>> {
        let conn = self.conn.lock().map_err(|_| poisoned())?;
        let mut stmt = conn.prepare(
            "SELECT id, name, driver, host, port, database, username, ssl_mode, color,
                    group_name, read_only, created_at, updated_at
             FROM connections WHERE id = ?1",
        )?;
        let mut rows = stmt.query([id])?;
        match rows.next()? {
            Some(row) => Ok(Some(connection_from_row(row)?)),
            None => Ok(None),
        }
    }

    pub fn insert_connection(&self, row: &ConnectionRow) -> AppResult<()> {
        let conn = self.conn.lock().map_err(|_| poisoned())?;
        conn.execute(
            "INSERT INTO connections (id, name, driver, host, port, database, username,
                                      ssl_mode, color, group_name, read_only, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            rusqlite::params![
                row.id,
                row.name,
                row.driver,
                row.host,
                row.port,
                row.database,
                row.username,
                row.ssl_mode,
                row.color,
                row.group_name,
                i64::from(row.read_only),
                row.created_at,
                row.updated_at,
            ],
        )?;
        Ok(())
    }

    pub fn update_connection(&self, row: &ConnectionRow) -> AppResult<()> {
        let conn = self.conn.lock().map_err(|_| poisoned())?;
        conn.execute(
            "UPDATE connections SET name = ?2, driver = ?3, host = ?4, port = ?5,
                    database = ?6, username = ?7, ssl_mode = ?8, color = ?9,
                    group_name = ?10, read_only = ?11, updated_at = ?12
             WHERE id = ?1",
            rusqlite::params![
                row.id,
                row.name,
                row.driver,
                row.host,
                row.port,
                row.database,
                row.username,
                row.ssl_mode,
                row.color,
                row.group_name,
                i64::from(row.read_only),
                row.updated_at,
            ],
        )?;
        Ok(())
    }

    pub fn delete_connection(&self, id: &str) -> AppResult<()> {
        let conn = self.conn.lock().map_err(|_| poisoned())?;
        conn.execute("DELETE FROM connections WHERE id = ?1", [id])?;
        Ok(())
    }

    // ── favorites（连接收藏）─────────────────────────────────

    pub fn is_favorite(&self, conn_id: &str) -> AppResult<bool> {
        let conn = self.conn.lock().map_err(|_| poisoned())?;
        let mut stmt = conn.prepare(
            "SELECT 1 FROM favorites WHERE object_type = 'connection' AND connection_id = ?1 LIMIT 1",
        )?;
        let mut rows = stmt.query([conn_id])?;
        Ok(rows.next()?.is_some())
    }

    pub fn set_connection_favorite(&self, conn_id: &str, favorite: bool) -> AppResult<()> {
        let conn = self.conn.lock().map_err(|_| poisoned())?;
        if favorite {
            conn.execute(
                "INSERT OR IGNORE INTO favorites (id, connection_id, object_type, object_name)
                 VALUES (?1, ?2, 'connection', ?2)",
                rusqlite::params![new_id("fav"), conn_id],
            )?;
        } else {
            conn.execute(
                "DELETE FROM favorites WHERE object_type = 'connection' AND connection_id = ?1",
                [conn_id],
            )?;
        }
        Ok(())
    }

    // ── query_history（阶段三）────────────────────────────────

    pub fn insert_query_history(&self, entry: &HistoryRecord) -> AppResult<()> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;
        let conn = self.conn.lock().map_err(|_| poisoned())?;
        conn.execute(
            "INSERT INTO query_history (id, connection_id, sql, status, rows,
                                        duration_ms, error, executed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                entry.id,
                entry.connection_id,
                entry.sql,
                entry.status,
                entry.rows,
                entry.duration_ms,
                entry.error,
                now,
            ],
        )?;
        Ok(())
    }

    pub fn list_query_history(
        &self,
        connection_id: Option<&str>,
        limit: i64,
    ) -> AppResult<Vec<HistoryRow>> {
        let conn = self.conn.lock().map_err(|_| poisoned())?;
        let limit = limit.clamp(1, 1000);
        let mut stmt = conn.prepare(
            "SELECT id, connection_id, sql, status, rows, duration_ms, error, executed_at
             FROM query_history
             WHERE (?1 IS NULL OR connection_id = ?1)
             ORDER BY executed_at DESC, id DESC
             LIMIT ?2",
        )?;
        let rows = stmt
            .query_map(rusqlite::params![connection_id, limit], history_from_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn clear_query_history(&self) -> AppResult<()> {
        let conn = self.conn.lock().map_err(|_| poisoned())?;
        conn.execute("DELETE FROM query_history", [])?;
        Ok(())
    }

    // ── tabs_session（阶段三）─────────────────────────────────

    pub fn list_tabs_session(&self) -> AppResult<Vec<TabRecord>> {
        let conn = self.conn.lock().map_err(|_| poisoned())?;
        let mut stmt = conn.prepare(
            "SELECT id, connection_id, title, sql, scroll_top, cursor_from, cursor_to, updated_at
             FROM tabs_session ORDER BY updated_at",
        )?;
        let rows = stmt
            .query_map([], tab_from_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// 整表替换（事务）：前端以全量快照持久化标签会话
    pub fn replace_tabs_session(&self, tabs: &[TabRecord]) -> AppResult<()> {
        let mut conn = self.conn.lock().map_err(|_| poisoned())?;
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM tabs_session", [])?;
        for tab in tabs {
            tx.execute(
                "INSERT INTO tabs_session (id, connection_id, title, sql, scroll_top,
                                           cursor_from, cursor_to, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                rusqlite::params![
                    tab.id,
                    tab.connection_id,
                    tab.title,
                    tab.sql,
                    tab.scroll_top,
                    tab.cursor_from,
                    tab.cursor_to,
                    tab.updated_at,
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    // ── saved_queries（阶段三）────────────────────────────────

    pub fn list_saved_queries(
        &self,
        connection_id: Option<&str>,
    ) -> AppResult<Vec<SavedQueryRow>> {
        let conn = self.conn.lock().map_err(|_| poisoned())?;
        let mut stmt = conn.prepare(
            "SELECT id, connection_id, name, sql, folder, created_at, updated_at
             FROM saved_queries
             WHERE (?1 IS NULL OR connection_id = ?1)
             ORDER BY updated_at DESC",
        )?;
        let rows = stmt
            .query_map([connection_id], saved_from_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// 有 id 更新，无 id 新建；更新时保留 created_at
    pub fn upsert_saved_query(
        &self,
        id: Option<&str>,
        connection_id: Option<&str>,
        name: &str,
        sql: &str,
        folder: Option<&str>,
    ) -> AppResult<SavedQueryRow> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;
        let conn = self.conn.lock().map_err(|_| poisoned())?;
        let row = match id {
            Some(existing) => {
                let created_at: i64 = conn
                    .query_row(
                        "SELECT created_at FROM saved_queries WHERE id = ?1",
                        [existing],
                        |row| row.get(0),
                    )
                    .map_err(|err| match err {
                        rusqlite::Error::QueryReturnedNoRows => {
                            AppError::NotFound(format!("保存的查询 {existing}"))
                        }
                        other => AppError::Db(other),
                    })?;
                conn.execute(
                    "UPDATE saved_queries SET connection_id = ?2, name = ?3, sql = ?4,
                            folder = ?5, updated_at = ?6 WHERE id = ?1",
                    rusqlite::params![existing, connection_id, name, sql, folder, now],
                )?;
                SavedQueryRow {
                    id: existing.to_owned(),
                    connection_id: connection_id.map(ToOwned::to_owned),
                    name: name.to_owned(),
                    sql: sql.to_owned(),
                    folder: folder.map(ToOwned::to_owned),
                    created_at,
                    updated_at: now,
                }
            }
            None => {
                let new = new_id("sq");
                conn.execute(
                    "INSERT INTO saved_queries (id, connection_id, name, sql, folder,
                                                created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    rusqlite::params![new, connection_id, name, sql, folder, now, now],
                )?;
                SavedQueryRow {
                    id: new,
                    connection_id: connection_id.map(ToOwned::to_owned),
                    name: name.to_owned(),
                    sql: sql.to_owned(),
                    folder: folder.map(ToOwned::to_owned),
                    created_at: now,
                    updated_at: now,
                }
            }
        };
        Ok(row)
    }

    pub fn delete_saved_query(&self, id: &str) -> AppResult<()> {
        let conn = self.conn.lock().map_err(|_| poisoned())?;
        let affected = conn.execute("DELETE FROM saved_queries WHERE id = ?1", [id])?;
        if affected == 0 {
            return Err(AppError::NotFound(format!("保存的查询 {id}")));
        }
        Ok(())
    }
}

/// 待写入的查询历史（id 由调用方生成）
pub struct HistoryRecord {
    pub id: String,
    pub connection_id: String,
    pub sql: String,
    pub status: String,
    pub rows: Option<i64>,
    pub duration_ms: Option<i64>,
    pub error: Option<String>,
}

/// 查询历史行
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRow {
    pub id: String,
    pub connection_id: String,
    pub sql: String,
    pub status: String,
    pub rows: Option<i64>,
    pub duration_ms: Option<i64>,
    pub error: Option<String>,
    pub executed_at: i64,
}

fn history_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<HistoryRow> {
    Ok(HistoryRow {
        id: row.get("id")?,
        connection_id: row.get("connection_id")?,
        sql: row.get("sql")?,
        status: row.get("status")?,
        rows: row.get("rows")?,
        duration_ms: row.get("duration_ms")?,
        error: row.get("error")?,
        executed_at: row.get("executed_at")?,
    })
}

/// 标签会话行（tabs_session）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabRecord {
    pub id: String,
    pub connection_id: Option<String>,
    pub title: Option<String>,
    pub sql: Option<String>,
    pub scroll_top: Option<i64>,
    pub cursor_from: Option<i64>,
    pub cursor_to: Option<i64>,
    pub updated_at: i64,
}

fn tab_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<TabRecord> {
    Ok(TabRecord {
        id: row.get("id")?,
        connection_id: row.get("connection_id")?,
        title: row.get("title")?,
        sql: row.get("sql")?,
        scroll_top: row.get("scroll_top")?,
        cursor_from: row.get("cursor_from")?,
        cursor_to: row.get("cursor_to")?,
        updated_at: row.get("updated_at")?,
    })
}

/// 保存的查询行
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedQueryRow {
    pub id: String,
    pub connection_id: Option<String>,
    pub name: String,
    pub sql: String,
    pub folder: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

fn saved_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SavedQueryRow> {
    Ok(SavedQueryRow {
        id: row.get("id")?,
        connection_id: row.get("connection_id")?,
        name: row.get("name")?,
        sql: row.get("sql")?,
        folder: row.get("folder")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> MetaStore {
        // rusqlite 对 ":memory:" 特判为内存库
        MetaStore::open(Path::new(":memory:")).expect("open in-memory meta store")
    }

    fn sample_row(id: &str, name: &str) -> ConnectionRow {
        ConnectionRow {
            id: id.to_owned(),
            name: name.to_owned(),
            driver: "postgres".to_owned(),
            host: Some("127.0.0.1".to_owned()),
            port: Some(5432),
            database: Some("postgres".to_owned()),
            username: Some("postgres".to_owned()),
            ssl_mode: Some("prefer".to_owned()),
            color: Some("#4F8CFF".to_owned()),
            group_name: Some("开发".to_owned()),
            read_only: false,
            created_at: 1,
            updated_at: 1,
        }
    }

    #[test]
    fn settings_roundtrip_and_upsert() {
        let s = store();
        assert_eq!(s.get_setting("ui.theme").unwrap(), None);
        s.set_setting("ui.theme", "dark").unwrap();
        s.set_setting("ui.theme", "light").unwrap();
        assert_eq!(s.get_setting("ui.theme").unwrap().as_deref(), Some("light"));
        assert_eq!(s.get_setting("other.key").unwrap(), None);
    }

    #[test]
    fn rejects_invalid_keys() {
        let s = store();
        assert!(s.set_setting("Bad Key", "1").is_err());
        assert!(s.set_setting("1abc", "1").is_err());
        assert!(s.set_setting("", "1").is_err());
        assert!(s.set_setting("a..b", "1").is_err());
        assert!(s.set_setting("ui.theme", "1").is_ok());
    }

    #[test]
    fn migrations_applied_on_open() {
        let s = store();
        let conn = s.conn.lock().unwrap();
        let version: u32 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, 3);
        let tables: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type = 'table'
                 AND name IN ('connections','query_history','saved_queries',
                              'settings','tabs_session','favorites')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(tables, 6);
    }

    #[test]
    fn connections_crud_and_favorite() {
        let s = store();
        assert_eq!(s.list_connections().unwrap().len(), 0);

        let mut row = sample_row("conn_1", "本地库");
        row.read_only = true;
        s.insert_connection(&row).unwrap();
        s.insert_connection(&sample_row("conn_2", "远端库")).unwrap();

        let listed = s.list_connections().unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].name, "本地库"); // ORDER BY name
        assert!(listed[0].read_only);
        assert_eq!(listed[0].group_name.as_deref(), Some("开发"));

        let fetched = s.get_connection("conn_1").unwrap().unwrap();
        assert_eq!(fetched.host.as_deref(), Some("127.0.0.1"));

        row.name = "本地库改名".to_owned();
        s.update_connection(&row).unwrap();
        assert_eq!(
            s.get_connection("conn_1").unwrap().unwrap().name,
            "本地库改名"
        );

        assert!(!s.is_favorite("conn_1").unwrap());
        s.set_connection_favorite("conn_1", true).unwrap();
        assert!(s.is_favorite("conn_1").unwrap());
        s.set_connection_favorite("conn_1", true).unwrap(); // 幂等
        assert!(s.is_favorite("conn_1").unwrap());
        s.set_connection_favorite("conn_1", false).unwrap();
        assert!(!s.is_favorite("conn_1").unwrap());

        s.delete_connection("conn_1").unwrap();
        assert!(s.get_connection("conn_1").unwrap().is_none());
    }

    #[test]
    fn new_id_is_unique_and_prefixed() {
        let a = new_id("conn");
        let b = new_id("conn");
        assert_ne!(a, b);
        assert!(a.starts_with("conn_"));
        assert!(b.starts_with("conn_"));
    }

    #[test]
    fn query_history_insert_list_clear() {
        let s = store();
        s.insert_query_history(&HistoryRecord {
            id: "h1".into(),
            connection_id: "conn_1".into(),
            sql: "SELECT 1".into(),
            status: "ok".into(),
            rows: Some(1),
            duration_ms: Some(5),
            error: None,
        })
        .unwrap();
        s.insert_query_history(&HistoryRecord {
            id: "h2".into(),
            connection_id: "conn_2".into(),
            sql: "BAD;".into(),
            status: "error".into(),
            rows: None,
            duration_ms: Some(2),
            error: Some("语法错误".into()),
        })
        .unwrap();

        let all = s.list_query_history(None, 100).unwrap();
        assert_eq!(all.len(), 2);
        // 最新在前
        assert_eq!(all[0].id, "h2");
        assert_eq!(all[0].error.as_deref(), Some("语法错误"));

        let filtered = s.list_query_history(Some("conn_1"), 100).unwrap();
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].status, "ok");

        let limited = s.list_query_history(None, 1).unwrap();
        assert_eq!(limited.len(), 1);

        s.clear_query_history().unwrap();
        assert!(s.list_query_history(None, 100).unwrap().is_empty());
    }

    #[test]
    fn tabs_session_replace_roundtrip() {
        let s = store();
        s.replace_tabs_session(&[TabRecord {
            id: "tab_1".into(),
            connection_id: Some("conn_1".into()),
            title: Some("查询 1".into()),
            sql: Some("SELECT 1;".into()),
            scroll_top: Some(120),
            cursor_from: Some(3),
            cursor_to: Some(9),
            updated_at: 10,
        }])
        .unwrap();
        let tabs = s.list_tabs_session().unwrap();
        assert_eq!(tabs.len(), 1);
        assert_eq!(tabs[0].title.as_deref(), Some("查询 1"));
        assert_eq!(tabs[0].cursor_to, Some(9));

        // 整表替换（含清空）
        s.replace_tabs_session(&[]).unwrap();
        assert!(s.list_tabs_session().unwrap().is_empty());
    }

    #[test]
    fn saved_queries_upsert_and_delete() {
        let s = store();
        let created = s
            .upsert_saved_query(None, Some("conn_1"), "常用查询", "SELECT 1", None)
            .unwrap();
        assert_eq!(created.name, "常用查询");

        let updated = s
            .upsert_saved_query(
                Some(&created.id),
                Some("conn_1"),
                "常用查询 v2",
                "SELECT 2",
                Some("报表"),
            )
            .unwrap();
        assert_eq!(updated.id, created.id);
        assert_eq!(updated.name, "常用查询 v2");
        assert_eq!(updated.folder.as_deref(), Some("报表"));
        assert_eq!(updated.created_at, created.created_at);

        let listed = s.list_saved_queries(Some("conn_1")).unwrap();
        assert_eq!(listed.len(), 1);
        assert!(s.list_saved_queries(Some("other")).unwrap().is_empty());

        s.delete_saved_query(&created.id).unwrap();
        assert!(s.list_saved_queries(None).unwrap().is_empty());
        assert!(s.delete_saved_query(&created.id).is_err());
    }
}
