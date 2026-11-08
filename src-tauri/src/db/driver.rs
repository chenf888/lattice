//! 统一驱动抽象：新增数据源只实现 [`DatabaseDriver`]，
//! 经 [`DriverHandle`] 枚举静态分发（避免 dyn-async 依赖），上层命令零改动。
//!
//! 阶段三契约：`query` 一次性物化 → `execute` 流式分批（行经 [`RowSink`]
//! 批量流出，消费方可提前叫停），并新增 `describe_table` / `apply_read_only`。

use serde::{Deserialize, Serialize};

use crate::error::AppResult;

/// 结果值的统一表示（serde：`"null"` | `{"int":1}` | `{"text":"…"}` …）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Cell {
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
    Text(String),
    Bytes(Vec<u8>),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMeta {
    pub name: String,
    pub type_name: String,
}

/// 单语句流式执行结果（行本身已经 [`RowSink`] 流出，不在此保留）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatementOutcome {
    pub rows_total: u64,
    pub rows_affected: u64,
    /// 达到行数上限或消费方叫停后仍有剩余
    pub truncated: bool,
    pub duration_ms: u64,
}

/// 行消费方：`rows` 返回 false 表示停止拉取（取消/达到上限）
pub trait RowSink: Send {
    fn columns(&mut self, columns: Vec<ColumnMeta>);
    fn rows(&mut self, rows: Vec<Vec<Cell>>) -> bool;
}

/// 丢弃全部输出的 sink（ping / 自检等只关心成功与否的场景）
pub struct NullRowSink;

impl RowSink for NullRowSink {
    fn columns(&mut self, _columns: Vec<ColumnMeta>) {}
    fn rows(&mut self, _rows: Vec<Vec<Cell>>) -> bool {
        false
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ObjectKind {
    Tables,
    Views,
    Functions,
    Sequences,
}

impl ObjectKind {
    pub fn id_segment(self) -> &'static str {
        match self {
            Self::Tables => "tables",
            Self::Views => "views",
            Self::Functions => "functions",
            Self::Sequences => "sequences",
        }
    }
}

/// 懒加载路径；serde 形如 {"kind":"objects","database":..,"schema":..,"objectKind":..}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum NodePath {
    Databases,
    Schemas { database: String },
    Objects { database: String, schema: String, object_kind: ObjectKind },
}

/// 层级 id（TanStack Query key）；段内经 [`encode_segment`] 转义，无 `/` 歧义。
/// 前端按同一规则解析节点 id；服务端保留编码基准实现
#[allow(dead_code)]
impl NodePath {
    pub fn id(&self) -> String {
        match self {
            Self::Databases => "databases".to_owned(),
            Self::Schemas { database } => {
                format!("schemas/{}", encode_segment(database))
            }
            Self::Objects { database, schema, object_kind } => {
                format!(
                    "objects/{}/{}/{}",
                    encode_segment(database),
                    encode_segment(schema),
                    object_kind.id_segment()
                )
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TreeNodeKind {
    /// 连接根节点（由前端构造）
    #[allow(dead_code)]
    Root,
    Database,
    Schema,
    /// 表/视图/函数/序列四类容器节点（由前端构造）
    #[allow(dead_code)]
    Group,
    Table,
    View,
    Function,
    Sequence,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    pub id: String,
    pub label: String,
    pub node_kind: TreeNodeKind,
    pub has_children: bool,
    pub is_system: bool,
    pub meta: Option<String>,
}

/// ER 图外键边（表.列 → 表.列）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErdForeignKey {
    pub column: String,
    pub ref_table: String,
    pub ref_column: String,
}

/// ER 图表节点（列 + 主键 + 外键）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErdTable {
    pub name: String,
    pub columns: Vec<ColumnMeta>,
    pub primary_keys: Vec<String>,
    pub foreign_keys: Vec<ErdForeignKey>,
}

/// 统一驱动接口：新增数据源只实现此 trait
/// （异步 trait 方法仅在本 crate 内静态分发使用，无需 dyn 兼容）
#[allow(async_fn_in_trait)]
pub trait DatabaseDriver: Send + Sync {
    fn name(&self) -> &'static str;
    async fn ping(&self) -> AppResult<()>;
    /// 流式执行单条语句：列先于行送达 sink；每批 ≤ batch 行
    async fn execute(
        &self,
        sql: &str,
        cap: usize,
        batch: usize,
        sink: &mut dyn RowSink,
    ) -> AppResult<StatementOutcome>;
    async fn children(&self, path: &NodePath) -> AppResult<Vec<TreeNode>>;
    async fn describe_table(&self, schema: &str, table: &str) -> AppResult<Vec<ColumnMeta>>;
    /// ER 图：schema 下全部基础表的列/主键/外键（SQLite 无 schema 概念，忽略该参数）
    async fn describe_erd(&self, schema: &str) -> AppResult<Vec<ErdTable>>;
    async fn primary_keys(&self, schema: &str, table: &str) -> AppResult<Vec<String>>;
    /// 连接级只读强制；SQLite 在打开时已生效，无需会话设置
    async fn apply_read_only(&self) -> AppResult<()>;
}

/// 段编码：保留 RFC3986 unreserved 字符，其余转 %XX（重点是 '/'）
pub fn encode_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for byte in s.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// 分发枚举：唯一集成点；新增数据源 = 实现 [`DatabaseDriver`] + 新增分支
#[derive(Clone)]
pub enum DriverHandle {
    Postgres(crate::db::postgres::PostgresDriver),
    Mysql(crate::db::mysql::MysqlDriver),
    Sqlite(crate::db::sqlite::SqliteDriver),
}

impl DriverHandle {
    pub fn name(&self) -> &'static str {
        match self {
            Self::Postgres(driver) => driver.name(),
            Self::Mysql(driver) => driver.name(),
            Self::Sqlite(driver) => driver.name(),
        }
    }

    pub async fn ping(&self) -> AppResult<()> {
        match self {
            Self::Postgres(driver) => driver.ping().await,
            Self::Mysql(driver) => driver.ping().await,
            Self::Sqlite(driver) => driver.ping().await,
        }
    }

    pub async fn execute(
        &self,
        sql: &str,
        cap: usize,
        batch: usize,
        sink: &mut dyn RowSink,
    ) -> AppResult<StatementOutcome> {
        match self {
            Self::Postgres(driver) => driver.execute(sql, cap, batch, sink).await,
            Self::Mysql(driver) => driver.execute(sql, cap, batch, sink).await,
            Self::Sqlite(driver) => driver.execute(sql, cap, batch, sink).await,
        }
    }

    pub async fn children(&self, path: &NodePath) -> AppResult<Vec<TreeNode>> {
        match self {
            Self::Postgres(driver) => driver.children(path).await,
            Self::Mysql(driver) => driver.children(path).await,
            Self::Sqlite(driver) => driver.children(path).await,
        }
    }

    pub async fn describe_table(&self, schema: &str, table: &str) -> AppResult<Vec<ColumnMeta>> {
        match self {
            Self::Postgres(driver) => driver.describe_table(schema, table).await,
            Self::Mysql(driver) => driver.describe_table(schema, table).await,
            Self::Sqlite(driver) => driver.describe_table(schema, table).await,
        }
    }

    pub async fn describe_erd(&self, schema: &str) -> AppResult<Vec<ErdTable>> {
        match self {
            Self::Postgres(driver) => driver.describe_erd(schema).await,
            Self::Mysql(driver) => driver.describe_erd(schema).await,
            Self::Sqlite(driver) => driver.describe_erd(schema).await,
        }
    }

    pub async fn primary_keys(&self, schema: &str, table: &str) -> AppResult<Vec<String>> {
        match self {
            Self::Postgres(driver) => driver.primary_keys(schema, table).await,
            Self::Mysql(driver) => driver.primary_keys(schema, table).await,
            Self::Sqlite(driver) => driver.primary_keys(schema, table).await,
        }
    }

    pub async fn apply_read_only(&self) -> AppResult<()> {
        match self {
            Self::Postgres(driver) => driver.apply_read_only().await,
            Self::Mysql(driver) => driver.apply_read_only().await,
            Self::Sqlite(driver) => driver.apply_read_only().await,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_segment_keeps_safe_and_escapes_separator() {
        assert_eq!(encode_segment("public"), "public");
        assert_eq!(encode_segment("my-db_1.0"), "my-db_1.0");
        assert_eq!(encode_segment("a/b"), "a%2Fb");
        assert_eq!(encode_segment("库 名"), "%E5%BA%93%20%E5%90%8D");
        assert!(!encode_segment("a/b/c").contains('/'));
    }

    #[test]
    fn node_path_ids_are_stable() {
        assert_eq!(NodePath::Databases.id(), "databases");
        assert_eq!(
            NodePath::Schemas { database: "my/db".into() }.id(),
            "schemas/my%2Fdb"
        );
        assert_eq!(
            NodePath::Objects {
                database: "db".into(),
                schema: "public".into(),
                object_kind: ObjectKind::Tables,
            }
            .id(),
            "objects/db/public/tables"
        );
    }

    #[test]
    fn object_kind_and_node_path_serde_roundtrip() {
        assert_eq!(
            serde_json::to_string(&ObjectKind::Tables).unwrap(),
            "\"tables\""
        );
        let json = r#"{"kind":"objects","database":"db","schema":"public","objectKind":"views"}"#;
        let parsed: NodePath = serde_json::from_str(json).unwrap();
        assert_eq!(
            parsed.id(),
            "objects/db/public/views"
        );
        let schemas: NodePath = serde_json::from_str(r#"{"kind":"schemas","database":"d"}"#).unwrap();
        assert!(matches!(schemas, NodePath::Schemas { .. }));
    }

    #[test]
    fn cell_serde_roundtrip_all_variants() {
        for cell in [
            Cell::Null,
            Cell::Bool(true),
            Cell::Int(-5),
            Cell::Float(1.25),
            Cell::Text("文本".into()),
            Cell::Bytes(vec![0, 255]),
        ] {
            let json = serde_json::to_string(&cell).unwrap();
            let back: Cell = serde_json::from_str(&json).unwrap();
            assert_eq!(format!("{json:?}"), format!("{:?}", serde_json::to_string(&back).unwrap()));
        }
        assert_eq!(serde_json::to_string(&Cell::Null).unwrap(), "\"null\"");
        assert_eq!(serde_json::to_string(&Cell::Int(3)).unwrap(), "{\"int\":3}");
    }
}
