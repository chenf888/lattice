use rusqlite::Connection;

use crate::error::AppResult;

/// 迁移脚本清单（编译期内嵌，打包后无外部资源依赖）；新增迁移只在此追加
const MIGRATIONS: &[&str] = &[
    include_str!("../../migrations/0001_init.sql"),
    include_str!("../../migrations/0002_connection_flags.sql"),
    include_str!("../../migrations/0003_tab_cursor.sql"),
];

/// 依据 PRAGMA user_version 逐个执行未应用的迁移；每个脚本单事务
/// （版本号写入同一事务，失败一并回滚），返回最终版本
pub fn run(conn: &Connection) -> AppResult<u32> {
    let current: u32 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    for (idx, script) in MIGRATIONS.iter().enumerate() {
        let version = (idx + 1) as u32;
        if version <= current {
            continue;
        }
        let batch = format!(
            "BEGIN;\n{script}\nPRAGMA user_version = {version};\nCOMMIT;"
        );
        if let Err(err) = conn.execute_batch(&batch) {
            // 显式 BEGIN 失败后不会自动回滚，需手动清理
            let _ = conn.execute_batch("ROLLBACK;");
            return Err(err.into());
        }
    }
    Ok(current.max(MIGRATIONS.len() as u32))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn applies_schema_and_is_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        assert_eq!(run(&conn).unwrap(), 3);
        assert_eq!(run(&conn).unwrap(), 3);
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
        let indexes: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(indexes, 3);
    }
}
