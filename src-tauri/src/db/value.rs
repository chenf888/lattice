//! 值映射：rusqlite / mysql_async 的原生值 → 统一 [`Cell`]。
//! 时间类一律格式化为文本（ISO 风格），二进制保留字节；纯函数 + 单测。

use rusqlite::types::ValueRef;

use crate::db::driver::Cell;

/// rusqlite 行值 → Cell
pub fn cell_from_rusqlite(value: ValueRef<'_>) -> Cell {
    match value {
        ValueRef::Null => Cell::Null,
        ValueRef::Integer(i) => Cell::Int(i),
        ValueRef::Real(f) => Cell::Float(f),
        ValueRef::Text(text) => Cell::Text(String::from_utf8_lossy(text).into_owned()),
        ValueRef::Blob(blob) => Cell::Bytes(blob.to_vec()),
    }
}

/// MySQL 字节列/字节值 → Cell：二进制列或非法 UTF-8 视为字节，否则文本
pub fn cell_from_mysql_bytes(bytes: Vec<u8>, binary_column: bool) -> Cell {
    if binary_column {
        return Cell::Bytes(bytes);
    }
    match String::from_utf8(bytes) {
        Ok(text) => Cell::Text(text),
        Err(err) => Cell::Bytes(err.into_bytes()),
    }
}

fn format_date_time(
    year: u32,
    month: u32,
    day: u32,
    hour: u32,
    minute: u32,
    second: u32,
    micros: u32,
) -> String {
    let has_date = year != 0 || month != 0 || day != 0;
    let has_time = hour != 0 || minute != 0 || second != 0 || micros != 0;
    let mut out = String::new();
    if has_date {
        out.push_str(&format!("{year:04}-{month:02}-{day:02}"));
    }
    if has_time {
        if has_date {
            out.push(' ');
        }
        out.push_str(&format!("{hour:02}:{minute:02}:{second:02}"));
        if micros != 0 {
            out.push_str(&format!(".{micros:06}"));
        }
    }
    if out.is_empty() {
        out.push_str("0000-00-00");
    }
    out
}

/// MySQL 原生值 → Cell（binary_column 标记该列是否为二进制类型）
pub fn cell_from_mysql(value: mysql_async::Value, binary_column: bool) -> Cell {
    match value {
        mysql_async::Value::NULL => Cell::Null,
        mysql_async::Value::Bytes(bytes) => cell_from_mysql_bytes(bytes, binary_column),
        mysql_async::Value::Int(i) => Cell::Int(i),
        mysql_async::Value::UInt(u) => match i64::try_from(u) {
            Ok(i) => Cell::Int(i),
            Err(_) => Cell::Float(u as f64),
        },
        mysql_async::Value::Float(f) => Cell::Float(f64::from(f)),
        mysql_async::Value::Double(f) => Cell::Float(f),
        mysql_async::Value::Date(year, month, day, hour, minute, second, micros) => {
            Cell::Text(format_date_time(
                u32::from(year),
                u32::from(month),
                u32::from(day),
                u32::from(hour),
                u32::from(minute),
                u32::from(second),
                micros,
            ))
        }
        mysql_async::Value::Time(negative, days, hours, minutes, seconds, micros) => {
            let total_hours = days * 24 + u32::from(hours);
            let mut out = String::new();
            if negative {
                out.push('-');
            }
            out.push_str(&format!("{total_hours:02}:{minutes:02}:{seconds:02}"));
            if micros != 0 {
                out.push_str(&format!(".{micros:06}"));
            }
            Cell::Text(out)
        }
        #[allow(unreachable_patterns)]
        _ => Cell::Null,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_rusqlite_values() {
        assert!(matches!(cell_from_rusqlite(ValueRef::Null), Cell::Null));
        assert!(matches!(cell_from_rusqlite(ValueRef::Integer(7)), Cell::Int(7)));
        let real = cell_from_rusqlite(ValueRef::Real(1.5));
        assert!(matches!(real, Cell::Float(f) if f == 1.5));
        let text = cell_from_rusqlite(ValueRef::Text(b"abc"));
        assert!(matches!(text, Cell::Text(t) if t == "abc"));
        let blob = cell_from_rusqlite(ValueRef::Blob(&[1, 2, 3]));
        assert!(matches!(blob, Cell::Bytes(b) if b == vec![1, 2, 3]));
    }

    #[test]
    fn maps_mysql_bytes_by_column_type_and_utf8() {
        assert!(matches!(
            cell_from_mysql_bytes(vec![0x00, 0xff], false),
            Cell::Bytes(_)
        ));
        assert!(matches!(
            cell_from_mysql_bytes(b"ok".to_vec(), false),
            Cell::Text(t) if t == "ok"
        ));
        assert!(matches!(
            cell_from_mysql_bytes(b"ok".to_vec(), true),
            Cell::Bytes(_)
        ));
    }

    #[test]
    fn maps_mysql_scalars_and_dates() {
        assert!(matches!(cell_from_mysql(mysql_async::Value::NULL, false), Cell::Null));
        assert!(matches!(
            cell_from_mysql(mysql_async::Value::Int(-3), false),
            Cell::Int(-3)
        ));
        assert!(matches!(
            cell_from_mysql(mysql_async::Value::UInt(9), false),
            Cell::Int(9)
        ));
        assert!(matches!(
            cell_from_mysql(mysql_async::Value::UInt(u64::MAX), false),
            Cell::Float(_)
        ));
        let date = cell_from_mysql(
            mysql_async::Value::Date(2026, 11, 8, 14, 30, 5, 0),
            false,
        );
        assert!(matches!(date, Cell::Text(t) if t == "2026-11-08 14:30:05"));
        let time = cell_from_mysql(mysql_async::Value::Time(false, 1, 2, 3, 4, 0), false);
        assert!(matches!(time, Cell::Text(t) if t == "26:03:04"));
        let neg_time = cell_from_mysql(mysql_async::Value::Time(true, 0, 1, 2, 3, 500_000), false);
        assert!(matches!(neg_time, Cell::Text(t) if t == "-01:02:03.500000"));
    }

    #[test]
    fn date_only_and_time_only_renderings() {
        let date_only = cell_from_mysql(mysql_async::Value::Date(2026, 1, 2, 0, 0, 0, 0), false);
        assert!(matches!(date_only, Cell::Text(t) if t == "2026-01-02"));
        let time_only = cell_from_mysql(mysql_async::Value::Date(0, 0, 0, 9, 5, 1, 0), false);
        assert!(matches!(time_only, Cell::Text(t) if t == "09:05:01"));
    }
}
