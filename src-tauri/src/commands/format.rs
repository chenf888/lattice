//! 结果复制格式化：CSV（RFC4180）/ JSON / SQL INSERT。
//! 值格式化原语来自 `db::export`（单一来源）；纯函数 + 单测。

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::driver::Cell;
use crate::db::export::{base64_encode, cell_export_text, csv_field, quoted_ident, sql_value};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatRowsInput {
    pub rows: Vec<Vec<Cell>>,
    pub columns: Vec<String>,
    /// csv | json | insert
    pub format: String,
    /// insert 格式必需
    pub table: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatRowsOutput {
    pub text: String,
}

fn to_csv(columns: &[String], rows: &[Vec<Cell>]) -> String {
    let mut out = String::new();
    out.push_str(
        &columns
            .iter()
            .map(|name| csv_field(name))
            .collect::<Vec<_>>()
            .join(","),
    );
    out.push('\n');
    for row in rows {
        let fields: Vec<String> = row
            .iter()
            .map(|cell| match cell {
                Cell::Null => String::new(),
                Cell::Bool(b) => b.to_string(),
                Cell::Int(i) => i.to_string(),
                Cell::Float(f) => format!("{f}"),
                Cell::Text(text) => csv_field(text),
                Cell::Bytes(_) => csv_field(&cell_export_text(cell)),
            })
            .collect();
        out.push_str(&fields.join(","));
        out.push('\n');
    }
    out
}

fn to_json(columns: &[String], rows: &[Vec<Cell>]) -> String {
    let mut out = String::from("[");
    for (row_index, row) in rows.iter().enumerate() {
        if row_index > 0 {
            out.push(',');
        }
        out.push('{');
        for (index, name) in columns.iter().enumerate() {
            if index > 0 {
                out.push(',');
            }
            out.push_str(&format!("{}:", serde_json::to_string(name).unwrap_or_default()));
            let value = match row.get(index) {
                None | Some(Cell::Null) => "null".to_owned(),
                Some(Cell::Bool(b)) => b.to_string(),
                Some(Cell::Int(i)) => i.to_string(),
                Some(Cell::Float(f)) => {
                    if f.is_finite() {
                        format!("{f}")
                    } else {
                        "null".to_owned()
                    }
                }
                Some(cell @ (Cell::Text(_) | Cell::Bytes(_))) => {
                    let value = cell_export_text(cell);
                    if let Cell::Bytes(bytes) = cell {
                        serde_json::to_string(&format!(
                            "data:application/octet-stream;base64,{}",
                            base64_encode(bytes)
                        ))
                        .unwrap_or_default()
                    } else {
                        serde_json::to_string(&value).unwrap_or_default()
                    }
                }
            };
            out.push_str(&value);
        }
        out.push('}');
    }
    out.push(']');
    out
}

fn to_insert(table: &str, columns: &[String], rows: &[Vec<Cell>]) -> AppResult<String> {
    let table = table.trim();
    if table.is_empty() {
        return Err(AppError::Input("INSERT 格式需要目标表名".into()));
    }
    let column_list = columns
        .iter()
        .map(|name| quoted_ident(name))
        .collect::<Vec<_>>()
        .join(", ");
    let mut out = String::new();
    for row in rows {
        let values: Vec<String> = row
            .iter()
            .take(columns.len())
            .map(sql_value)
            .collect();
        out.push_str(&format!(
            "INSERT INTO {} ({}) VALUES ({});\n",
            quoted_ident(table),
            column_list,
            values.join(", ")
        ));
    }
    Ok(out)
}

#[tauri::command]
pub async fn format_sql(_state: State<'_, AppState>, sql: String) -> AppResult<String> {
    Ok(crate::db::sql_format::format_sql(&sql))
}

#[tauri::command]
pub async fn format_rows(
    _state: State<'_, AppState>,
    input: FormatRowsInput,
) -> AppResult<FormatRowsOutput> {
    let text = match input.format.as_str() {
        "csv" => to_csv(&input.columns, &input.rows),
        "json" => to_json(&input.columns, &input.rows),
        "insert" => to_insert(
            input.table.as_deref().unwrap_or(""),
            &input.columns,
            &input.rows,
        )?,
        other => return Err(AppError::Input(format!("未知格式：{other}"))),
    };
    Ok(FormatRowsOutput { text })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text_row(values: &[&str]) -> Vec<Cell> {
        values.iter().map(|v| Cell::Text((*v).to_owned())).collect()
    }

    #[test]
    fn csv_escapes_specials_per_rfc4180() {
        let columns = vec!["a".into(), "b,x".into(), "c\"y".into()];
        let rows = vec![
            text_row(&["plain", "with,comma", "with\"quote"]),
            vec![Cell::Null, Cell::Int(-3), Cell::Text("多\n行".into())],
        ];
        let out = to_csv(&columns, &rows);
        // 含引号转义与带内嵌换行的引号字段（整串比对）
        assert_eq!(
            out,
            "a,\"b,x\",\"c\"\"y\"\nplain,\"with,comma\",\"with\"\"quote\"\n,-3,\"多\n行\"\n"
        );
    }

    #[test]
    fn csv_blob_placeholder_and_bool() {
        let out = to_csv(
            &["v".into()],
            &[vec![Cell::Bytes(vec![1, 2]), Cell::Bool(true)]],
        );
        assert_eq!(out, "v\n<BLOB 2 bytes>,true\n");
    }

    #[test]
    fn json_renders_all_cell_types() {
        let out = to_json(
            &["n".into(), "t".into(), "b".into()],
            &[
                vec![Cell::Int(5), Cell::Text("he\"llo".into()), Cell::Null],
                vec![Cell::Float(1.5), Cell::Bool(false), Cell::Bytes(vec![72, 105])],
            ],
        );
        assert_eq!(
            out,
            r#"[{"n":5,"t":"he\"llo","b":null},{"n":1.5,"t":false,"b":"data:application/octet-stream;base64,SGk="}]"#
        );
    }

    #[test]
    fn insert_quotes_and_escapes() {
        let out = to_insert(
            "users",
            &["id".into(), "name".into()],
            &[vec![Cell::Int(1), Cell::Text("O'Brien".into())]],
        )
        .unwrap();
        assert_eq!(
            out,
            "INSERT INTO \"users\" (\"id\", \"name\") VALUES (1, 'O''Brien');\n"
        );
        // 空表名报错
        assert!(to_insert("  ", &["a".into()], &[]).is_err());
    }

    #[test]
    fn insert_handles_null_bool_bytes() {
        let out = to_insert(
            "t",
            &["a".into(), "b".into(), "c".into()],
            &[vec![Cell::Null, Cell::Bool(false), Cell::Bytes(vec![0xDE, 0xAD])]],
        )
        .unwrap();
        assert_eq!(
            out,
            "INSERT INTO \"t\" (\"a\", \"b\", \"c\") VALUES (NULL, FALSE, X'DEAD');\n"
        );
    }
}
