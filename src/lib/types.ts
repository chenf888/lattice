/** 与 Rust 侧共享的领域类型；随阶段只增不改语义 */

export interface AppInfo {
  name: string;
  version: string;
  platform: "macos" | "windows" | "linux";
  arch: string;
  dataDir: string;
  logDir: string;
}

export type ThemeMode = "dark" | "light" | "system";
export type Density = "compact" | "comfortable";
export type RightPanelKind = "history" | "details";
export type Route = { view: "workbench" | "connections" | "erd" | "settings" };

/** settings 表已约定键；后续阶段随设置项扩展（只增） */
export const SETTING_KEYS = {
  theme: "ui.theme",
  density: "ui.density",
  sidebarCollapsed: "ui.sidebar_collapsed",
  language: "ui.language",
  uiFontSize: "ui.font_size",
  recentTables: "ui.recent_tables",
  hotkeys: "ui.hotkeys",
  editorFontSize: "editor.font_size",
  editorTabSize: "editor.tab_size",
  editorCompletions: "editor.completions",
  editorAutoFormat: "editor.auto_format",
  queryMaxRows: "query.max_rows",
  queryTimeoutSeconds: "query.timeout_seconds",
  dataAutocommit: "data.autocommit",
} as const;

export type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS];

// ── 连接域（阶段二）──────────────────────────────────────

export type DriverKind = "postgres" | "mysql" | "sqlite";
export type SslMode = "disable" | "prefer" | "require" | "verify-ca" | "verify-full";

export interface ConnectionSummary {
  id: string;
  name: string;
  driver: DriverKind;
  host: string | null;
  port: number | null;
  database: string | null;
  username: string | null;
  sslMode: string | null;
  color: string | null;
  groupName: string | null;
  readOnly: boolean;
  favorite: boolean;
  connected: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ConnectionInput {
  name: string;
  driver: DriverKind;
  host: string;
  port: number;
  database: string;
  username: string;
  /** null/空 = 编辑时保留原密码 */
  password: string | null;
  sslMode: SslMode;
  color: string | null;
  groupName: string | null;
  readOnly: boolean;
}

export type TestErrorKind = "network" | "auth" | "database" | "ssl" | "unknown";

export interface TestError {
  kind: TestErrorKind;
  message: string;
}

export interface TestResult {
  ok: boolean;
  latencyMs: number;
  error: TestError | null;
}

export const TEST_ERROR_LABEL: Record<TestErrorKind, string> = {
  network: "网络不可达",
  auth: "认证失败",
  database: "数据库不存在",
  ssl: "SSL 错误",
  unknown: "连接失败",
};

// ── 对象树（阶段二）──────────────────────────────────────

export type ObjectKind = "tables" | "views" | "functions" | "sequences";

export type NodePath =
  | { kind: "databases" }
  | { kind: "schemas"; database: string }
  | { kind: "objects"; database: string; schema: string; objectKind: ObjectKind };

export type TreeNodeKind =
  | "root"
  | "database"
  | "schema"
  | "group"
  | "table"
  | "view"
  | "function"
  | "sequence";

export interface TreeNode {
  id: string;
  label: string;
  nodeKind: TreeNodeKind;
  hasChildren: boolean;
  isSystem: boolean;
  meta: string | null;
}

// ── 执行与结果（阶段三）──────────────────────────────────

/** Rust Cell 枚举的 serde 形态："null" | {"int":1} | {"text":"…"} … */
export type Cell =
  | "null"
  | { bool: boolean }
  | { int: number }
  | { float: number }
  | { text: string }
  | { bytes: number[] };

export interface ColumnMeta {
  name: string;
  typeName: string;
}

export type StatementStatus = "pending" | "running" | "ok" | "error" | "cancelled";

export interface StatementResult {
  index: number;
  status: StatementStatus;
  columns: ColumnMeta[];
  rows: Cell[][];
  rowsAffected: number | null;
  truncated: boolean;
  durationMs: number | null;
  error: string | null;
}

export type ExecutionStatus = "running" | "completed" | "cancelled" | "error";

/** 一个标签的一次执行（多语句 → 多结果集标签） */
export interface ExecutionState {
  queryId: string;
  statementCount: number;
  /** 全部语句为纯读取：截断后「加载更多」可安全重跑 */
  rerunnable: boolean;
  statements: StatementResult[];
  activeIndex: number;
  status: ExecutionStatus;
  error: string | null;
  durationMs: number | null;
  /** 本次执行的 SQL 原文（「加载更多」按倍增上限重跑） */
  sql: string;
}

export interface QueryStarted {
  queryId: string;
  statementCount: number;
  /** 全部语句为纯读取：截断后「加载更多」可安全重跑 */
  rerunnable: boolean;
}

// ── 历史 / 保存查询 / 标签会话（阶段三）──────────────────

export interface HistoryEntry {
  id: string;
  connectionId: string;
  sql: string;
  status: "ok" | "error" | "cancelled";
  rows: number | null;
  durationMs: number | null;
  error: string | null;
  executedAt: number;
}

export interface SavedQuery {
  id: string;
  connectionId: string | null;
  name: string;
  sql: string;
  folder: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface SavedQueryInput {
  id: string | null;
  connectionId: string | null;
  name: string;
  sql: string;
  folder: string | null;
}

export interface TabRecord {
  id: string;
  connectionId: string | null;
  title: string | null;
  sql: string | null;
  scrollTop: number | null;
  cursorFrom: number | null;
  cursorTo: number | null;
  updatedAt: number;
}

// ── ER 图 / 任务 / 传输（阶段四）──────────────────────────

export interface ErdForeignKey {
  column: string;
  refTable: string;
  refColumn: string;
}

export interface ErdTable {
  name: string;
  columns: ColumnMeta[];
  primaryKeys: string[];
  foreignKeys: ErdForeignKey[];
}

export interface CsvPreview {
  headers: string[];
  rows: string[][];
  totalRows: number;
}

export type ExportFormatKind = "csv" | "json" | "insert";
export type ExportEncodingKind = "utf8" | "utf8-bom" | "gbk";

export interface ExportInput {
  format: ExportFormatKind;
  columns: string[] | null;
  encoding: ExportEncodingKind;
  lineSeparator: "\n" | "\r\n";
  filePath: string;
  table: string | null;
  maxRows: number | null;
}

export interface ImportInput {
  filePath: string;
  delimiter: string;
  hasHeader: boolean;
  columnMapping: Array<{ source: string; target: string | null }>;
  conflict: "error" | "skip" | "overwrite";
  batchSize: number | null;
}

export type TaskKind = "export" | "import";
export type TaskStatus = "running" | "completed" | "cancelled" | "error";

export interface TaskProgressPayload {
  taskId: string;
  kind: TaskKind;
  done: number;
  total: number | null;
  message: string | null;
}

export interface TaskDonePayload {
  taskId: string;
  status: "completed" | "cancelled" | "error";
  error: string | null;
  result: { rows: number; skippedRows: number[]; durationMs: number } | null;
}

/** 任务托盘条目（前端聚合状态） */
export interface TaskItem {
  id: string;
  kind: TaskKind;
  title: string;
  status: TaskStatus;
  done: number;
  total: number | null;
  error: string | null;
  result: TaskDonePayload["result"];
  startedAt: number;
  logs: string[];
}
