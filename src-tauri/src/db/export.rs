//! 流式导出：CSV / JSON / INSERT 三种写入器直接消费 RowSink 批次写文件，
//! 不在内存累积整表（行上限由执行层控制）。编码/行分隔符按规格支持。
//! 值格式化原语（CSV 转义、SQL 字面量、base64）为本 crate 单一来源，
//! `commands::format` 的复制功能同样复用。

use std::fs::File;
use std::io::{BufWriter, Write};

use crate::db::driver::Cell;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportFormat {
    Csv,
    Json,
    Insert,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportEncoding {
    Utf8,
    Utf8Bom,
    Gbk,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineSeparator {
    Lf,
    Crlf,
}

impl LineSeparator {
    fn as_str(self) -> &'static str {
        match self {
            Self::Lf => "\n",
            Self::Crlf => "\r\n",
        }
    }
}

// ── 值格式化原语（commands::format 复用）────────────────────

pub fn csv_field(value: &str) -> String {
    if value.contains(',')
        || value.contains('"')
        || value.contains('\n')
        || value.contains('\r')
    {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_owned()
    }
}

pub fn sql_text(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

pub fn sql_value(cell: &Cell) -> String {
    match cell {
        Cell::Null => "NULL".into(),
        Cell::Bool(b) => {
            if *b {
                "TRUE".into()
            } else {
                "FALSE".into()
            }
        }
        Cell::Int(i) => i.to_string(),
        Cell::Float(f) => {
            if f.is_finite() {
                format!("{f}")
            } else {
                "NULL".into()
            }
        }
        Cell::Text(text) => sql_text(text),
        Cell::Bytes(bytes) => {
            let hex: String = bytes.iter().map(|byte| format!("{byte:02X}")).collect();
            format!("X'{hex}'")
        }
    }
}

pub fn quoted_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// MySQL 侧标识符引用（反引号）
pub fn mysql_ident(name: &str) -> String {
    format!("`{}`", name.replace('`', "``"))
}

/// CSV/JSON 之外的统一文本化：NULL → 空串，字节 → 占位
pub fn cell_export_text(cell: &Cell) -> String {
    match cell {
        Cell::Null => String::new(),
        Cell::Bool(b) => b.to_string(),
        Cell::Int(i) => i.to_string(),
        Cell::Float(f) => format!("{f}"),
        Cell::Text(text) => text.clone(),
        Cell::Bytes(bytes) => format!("<BLOB {} bytes>", bytes.len()),
    }
}

fn cell_json_value(cell: &Cell) -> String {
    match cell {
        Cell::Null => "null".to_owned(),
        Cell::Bool(b) => b.to_string(),
        Cell::Int(i) => i.to_string(),
        Cell::Float(f) => {
            if f.is_finite() {
                format!("{f}")
            } else {
                "null".to_owned()
            }
        }
        Cell::Text(text) => serde_json::to_string(text).unwrap_or_default(),
        Cell::Bytes(bytes) => serde_json::to_string(&format!(
            "data:application/octet-stream;base64,{}",
            base64_encode(bytes)
        ))
        .unwrap_or_default(),
    }
}

/// 极简 base64（RFC 4648 标准字母表，带填充）；避免仅为复制/导出引入新依赖
pub fn base64_encode(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[(triple >> 18) as usize & 0x3F] as char);
        out.push(TABLE[(triple >> 12) as usize & 0x3F] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(triple >> 6) as usize & 0x3F] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[triple as usize & 0x3F] as char
        } else {
            '='
        });
    }
    out
}

// ── 写入器 ──────────────────────────────────────────────────

pub trait RowsWriter: Send {
    /// 写文件头（BOM / CSV 表头 / JSON 开括号）；table 仅 INSERT 需要
    fn start(&mut self, columns: &[String], table: Option<&str>) -> std::io::Result<()>;
    fn write_row(&mut self, cells: &[Cell]) -> std::io::Result<()>;
    fn finish(&mut self) -> std::io::Result<()>;
}

fn encode_chunk(encoding: ExportEncoding, text: &str) -> std::io::Result<Vec<u8>> {
    match encoding {
        ExportEncoding::Utf8 | ExportEncoding::Utf8Bom => Ok(text.as_bytes().to_vec()),
        ExportEncoding::Gbk => {
            let owned = text.to_owned();
            let (bytes, _, had_errors) = encoding_rs::GBK.encode(&owned);
            if had_errors {
                // 无法映射的字符以 HTML 实体兜底，避免整文件失败
                let replaced: String = text
                    .chars()
                    .map(|ch| {
                        let single = ch.to_string();
                        let (bytes, _, err) = encoding_rs::GBK.encode(&single);
                        if err {
                            format!("&#{};", u32::from(ch))
                        } else {
                            String::from_utf8_lossy(&bytes).into_owned()
                        }
                    })
                    .collect();
                return Ok(replaced.into_bytes());
            }
            Ok(bytes.into_owned())
        }
    }
}

pub struct CsvWriter {
    out: BufWriter<File>,
    columns: Vec<String>,
    encoding: ExportEncoding,
    separator: &'static str,
}

impl CsvWriter {
    pub fn new(file: File, encoding: ExportEncoding, separator: LineSeparator) -> Self {
        Self {
            out: BufWriter::new(file),
            columns: Vec::new(),
            encoding,
            separator: separator.as_str(),
        }
    }

    fn write_line(&mut self, line: String) -> std::io::Result<()> {
        let bytes = encode_chunk(self.encoding, &line)?;
        self.out.write_all(&bytes)?;
        self.out.write_all(self.separator.as_bytes())
    }
}

impl RowsWriter for CsvWriter {
    fn start(&mut self, columns: &[String], _table: Option<&str>) -> std::io::Result<()> {
        self.columns = columns.to_vec();
        if self.encoding == ExportEncoding::Utf8Bom {
            self.out.write_all(b"\xEF\xBB\xBF")?;
        }
        let header = columns
            .iter()
            .map(|name| csv_field(name))
            .collect::<Vec<_>>()
            .join(",");
        self.write_line(header)
    }

    fn write_row(&mut self, cells: &[Cell]) -> std::io::Result<()> {
        let line = cells
            .iter()
            .map(cell_export_text)
            .map(|text| csv_field(&text))
            .collect::<Vec<_>>()
            .join(",");
        self.write_line(line)
    }

    fn finish(&mut self) -> std::io::Result<()> {
        self.out.flush()
    }
}

pub struct JsonWriter {
    out: BufWriter<File>,
    columns: Vec<String>,
    encoding: ExportEncoding,
    separator: &'static str,
    first: bool,
}

impl JsonWriter {
    pub fn new(file: File, encoding: ExportEncoding, separator: LineSeparator) -> Self {
        Self {
            out: BufWriter::new(file),
            columns: Vec::new(),
            encoding,
            separator: separator.as_str(),
            first: true,
        }
    }
}

impl RowsWriter for JsonWriter {
    fn start(&mut self, columns: &[String], _table: Option<&str>) -> std::io::Result<()> {
        self.columns = columns.to_vec();
        if self.encoding == ExportEncoding::Utf8Bom {
            self.out.write_all(b"\xEF\xBB\xBF")?;
        }
        self.out.write_all(b"[")
    }

    fn write_row(&mut self, cells: &[Cell]) -> std::io::Result<()> {
        let mut line = String::new();
        if !self.first {
            line.push(',');
        }
        self.first = false;
        line.push('{');
        for (index, name) in self.columns.iter().enumerate() {
            if index > 0 {
                line.push(',');
            }
            line.push_str(&serde_json::to_string(name).unwrap_or_default());
            line.push(':');
            line.push_str(&match cells.get(index) {
                None => "null".to_owned(),
                Some(cell) => cell_json_value(cell),
            });
        }
        line.push('}');
        let bytes = encode_chunk(self.encoding, &line)?;
        self.out.write_all(&bytes)?;
        self.out.write_all(self.separator.as_bytes())
    }

    fn finish(&mut self) -> std::io::Result<()> {
        self.out.write_all(b"]")?;
        self.out.flush()
    }
}

pub struct InsertWriter {
    out: BufWriter<File>,
    columns: Vec<String>,
    table: String,
    encoding: ExportEncoding,
    separator: &'static str,
}

impl InsertWriter {
    pub fn new(file: File, encoding: ExportEncoding, separator: LineSeparator) -> Self {
        Self {
            out: BufWriter::new(file),
            columns: Vec::new(),
            table: String::new(),
            encoding,
            separator: separator.as_str(),
        }
    }
}

impl RowsWriter for InsertWriter {
    fn start(&mut self, columns: &[String], table: Option<&str>) -> std::io::Result<()> {
        self.columns = columns.to_vec();
        self.table = table.unwrap_or("exported_table").to_owned();
        if self.encoding == ExportEncoding::Utf8Bom {
            self.out.write_all(b"\xEF\xBB\xBF")?;
        }
        Ok(())
    }

    fn write_row(&mut self, cells: &[Cell]) -> std::io::Result<()> {
        let values: Vec<String> = cells.iter().map(sql_value).collect();
        let line = format!(
            "INSERT INTO {} ({}) VALUES ({});",
            quoted_ident(&self.table),
            self.columns
                .iter()
                .map(|name| quoted_ident(name))
                .collect::<Vec<_>>()
                .join(", "),
            values.join(", ")
        );
        let bytes = encode_chunk(self.encoding, &line)?;
        self.out.write_all(&bytes)?;
        self.out.write_all(self.separator.as_bytes())
    }

    fn finish(&mut self) -> std::io::Result<()> {
        self.out.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "lattice-export-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    #[test]
    fn csv_writer_escapes_and_streams() {
        let path = temp_path("a.csv");
        let file = File::create(&path).unwrap();
        let mut writer = CsvWriter::new(file, ExportEncoding::Utf8, LineSeparator::Lf);
        writer
            .start(&["a".into(), "b,x".into(), "c\"y".into()], None)
            .unwrap();
        writer
            .write_row(&[Cell::Text("plain".into()), Cell::Text("with,comma".into()), Cell::Int(3)])
            .unwrap();
        writer
            .write_row(&[Cell::Null, Cell::Bytes(vec![1, 2]), Cell::Float(1.5)])
            .unwrap();
        writer.finish().unwrap();
        let content = std::fs::read_to_string(&path).unwrap();
        // <BLOB n bytes> 无特殊字符，不加引号
        assert_eq!(
            content,
            "a,\"b,x\",\"c\"\"y\"\nplain,\"with,comma\",3\n,<BLOB 2 bytes>,1.5\n"
        );
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn csv_writer_gbk_and_crlf_and_bom() {
        let path = temp_path("b.csv");
        let file = File::create(&path).unwrap();
        let mut writer = CsvWriter::new(file, ExportEncoding::Gbk, LineSeparator::Crlf);
        writer.start(&["名称".into()], None).unwrap();
        writer.write_row(&[Cell::Text("中文".into())]).unwrap();
        writer.finish().unwrap();
        let raw = std::fs::read(&path).unwrap();
        // GBK「名称」= C3 FB B3 C6；行分隔为 \r\n
        assert_eq!(&raw[0..4], &[0xC3, 0xFB, 0xB3, 0xC6]);
        assert!(raw.ends_with(b"\r\n"));
        std::fs::remove_file(&path).ok();

        let path = temp_path("c.csv");
        let file = File::create(&path).unwrap();
        let mut writer = CsvWriter::new(file, ExportEncoding::Utf8Bom, LineSeparator::Lf);
        writer.start(&["x".into()], None).unwrap();
        writer.finish().unwrap();
        let raw = std::fs::read(&path).unwrap();
        assert!(raw.starts_with(b"\xEF\xBB\xBF"));
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn json_writer_streams_array() {
        let path = temp_path("d.json");
        let file = File::create(&path).unwrap();
        let mut writer = JsonWriter::new(file, ExportEncoding::Utf8, LineSeparator::Lf);
        writer.start(&["n".into(), "t".into()], None).unwrap();
        writer.write_row(&[Cell::Int(5), Cell::Text("he\"llo".into())]).unwrap();
        writer.write_row(&[Cell::Null, Cell::Bool(false)]).unwrap();
        writer.finish().unwrap();
        let content = std::fs::read_to_string(&path).unwrap();
        // 行分隔符写入为换行（JSON 语义等价，利于 diff 阅读）
        assert_eq!(
            content,
            "[{\"n\":5,\"t\":\"he\\\"llo\"}\n,{\"n\":null,\"t\":false}\n]"
        );
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn insert_writer_quotes_and_escapes() {
        let path = temp_path("e.sql");
        let file = File::create(&path).unwrap();
        let mut writer = InsertWriter::new(file, ExportEncoding::Utf8, LineSeparator::Lf);
        writer
            .start(&["id".into(), "name".into()], Some("users"))
            .unwrap();
        writer
            .write_row(&[Cell::Int(1), Cell::Text("O'Brien".into())])
            .unwrap();
        writer
            .write_row(&[Cell::Null, Cell::Bytes(vec![0xDE, 0xAD])])
            .unwrap();
        writer.finish().unwrap();
        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(
            content,
            "INSERT INTO \"users\" (\"id\", \"name\") VALUES (1, 'O''Brien');\n\
             INSERT INTO \"users\" (\"id\", \"name\") VALUES (NULL, X'DEAD');\n"
        );
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn base64_known_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn csv_field_and_sql_value_escape() {
        assert_eq!(csv_field("plain"), "plain");
        assert_eq!(csv_field("a,\"b\""), "\"a,\"\"b\"\"\"");
        assert_eq!(sql_value(&Cell::Text("O'Brien".into())), "'O''Brien'");
        assert_eq!(sql_value(&Cell::Null), "NULL");
    }
}
