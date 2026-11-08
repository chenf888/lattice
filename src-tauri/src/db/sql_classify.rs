//! 语句分类（保守启发式）：跳过前导注释/空白后按首关键字判定。
//! 用途：①截断「加载更多」的重跑安全门（仅 Read 可重跑）；②只读连接的
//! 前端二次确认提示。不可识别一律归 Other（按不可重跑处理，宁严勿松）。

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatementClass {
    /// 纯读取（SELECT/WITH/TABLE/VALUES/SHOW/EXPLAIN/DESC…）
    Read,
    /// 数据/结构变更（INSERT/UPDATE/DELETE/CREATE/DROP…）
    Write,
    /// 事务控制、会话设置等（BEGIN/SET/PRAGMA…）与不可识别
    Other,
}

fn skip_prefix(input: &str) -> &str {
    let mut rest = input.trim_start();
    loop {
        if rest.starts_with("--") {
            match rest.find('\n') {
                Some(pos) => rest = rest[pos + 1..].trim_start(),
                None => return "",
            }
        } else if rest.starts_with("/*") {
            match rest.find("*/") {
                Some(pos) => rest = rest[pos + 2..].trim_start(),
                None => return "",
            }
        } else {
            return rest;
        }
    }
}

/// 取首关键字：返回大写关键字与其后剩余文本
fn take_word(s: &str) -> (String, &str) {
    let end = s
        .find(|ch: char| !(ch.is_ascii_alphabetic() || ch == '_'))
        .unwrap_or(s.len());
    (s[..end].to_ascii_uppercase(), &s[end..])
}

pub fn classify(sql: &str) -> StatementClass {
    let rest = skip_prefix(sql);
    let (keyword, after) = take_word(rest.trim_start_matches('(').trim_start());
    match keyword.as_str() {
        "SELECT" | "WITH" | "TABLE" | "VALUES" | "SHOW" | "DESC" | "DESCRIBE" | "LIST" => {
            StatementClass::Read
        }
        "EXPLAIN" => {
            // EXPLAIN ANALYZE 会真实执行内层语句：仅内层为 Read 时才视为可重跑
            let (word2, after2) = take_word(after.trim_start_matches('(').trim_start());
            if word2 == "ANALYZE" || word2 == "ANALYSE" {
                match classify(after2) {
                    StatementClass::Read => StatementClass::Read,
                    _ => StatementClass::Other,
                }
            } else {
                StatementClass::Read
            }
        }
        "INSERT" | "UPDATE" | "DELETE" | "MERGE" | "REPLACE" | "CREATE" | "ALTER" | "DROP"
        | "TRUNCATE" | "GRANT" | "REVOKE" | "COPY" | "CALL" | "LOCK" | "REINDEX" | "CLUSTER"
        | "COMMENT" | "RENAME" | "HANDLER" | "IMPORT" | "LOAD" => StatementClass::Write,
        _ => StatementClass::Other,
    }
}

/// 多语句整体类别：任一非 Read 即不可整体重跑
pub fn classify_all(statements: &[String]) -> StatementClass {
    let mut all_read = !statements.is_empty();
    for statement in statements {
        match classify(statement) {
            StatementClass::Read => {}
            _ => all_read = false,
        }
    }
    if all_read {
        StatementClass::Read
    } else {
        StatementClass::Other
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_are_detected_with_comments_and_parens() {
        assert_eq!(classify("SELECT 1"), StatementClass::Read);
        assert_eq!(classify("  select * from t"), StatementClass::Read);
        assert_eq!(classify("-- note;\nWITH x AS (SELECT 1) SELECT * FROM x"), StatementClass::Read);
        assert_eq!(classify("/* c */ (SELECT 1)"), StatementClass::Read);
        assert_eq!(classify("SHOW TABLES"), StatementClass::Read);
        assert_eq!(classify("DESC t"), StatementClass::Read);
        assert_eq!(classify("VALUES (1)"), StatementClass::Read);
        assert_eq!(classify("EXPLAIN SELECT 1"), StatementClass::Read);
        assert_eq!(classify("EXPLAIN ANALYZE SELECT 1"), StatementClass::Read);
    }

    #[test]
    fn writes_and_others_are_conservative() {
        assert_eq!(classify("INSERT INTO t VALUES (1)"), StatementClass::Write);
        assert_eq!(classify("UPDATE t SET a = 1"), StatementClass::Write);
        assert_eq!(classify("DELETE FROM t"), StatementClass::Write);
        assert_eq!(classify("create table t (id int)"), StatementClass::Write);
        assert_eq!(classify("DROP TABLE t"), StatementClass::Write);
        // 事务控制 / 会话设置不可重跑
        assert_eq!(classify("BEGIN"), StatementClass::Other);
        assert_eq!(classify("COMMIT"), StatementClass::Other);
        assert_eq!(classify("SET search_path = public"), StatementClass::Other);
        assert_eq!(classify("PRAGMA foreign_keys = ON"), StatementClass::Other);
        // EXPLAIN ANALYZE 下的写语句不可重跑
        assert_eq!(classify("EXPLAIN ANALYZE INSERT INTO t VALUES (1)"), StatementClass::Other);
        // 未知/空语句一律 Other
        assert_eq!(classify(""), StatementClass::Other);
        assert_eq!(classify("some_random_word"), StatementClass::Other);
        assert_eq!(classify("-- only comment"), StatementClass::Other);
    }

    #[test]
    fn classify_all_requires_every_statement_read() {
        assert_eq!(
            classify_all(&["select 1".into(), "select 2".into()]),
            StatementClass::Read
        );
        assert_eq!(
            classify_all(&["select 1".into(), "update t set a=1".into()]),
            StatementClass::Other
        );
        assert_eq!(classify_all(&[]), StatementClass::Other);
    }
}
