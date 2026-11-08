import { invoke as tauriInvoke } from "@tauri-apps/api/core";

import type {
  AppInfo,
  Cell,
  ColumnMeta,
  ConnectionInput,
  ConnectionSummary,
  CsvPreview,
  ErdTable,
  ExportInput,
  HistoryEntry,
  ImportInput,
  NodePath,
  QueryStarted,
  SavedQuery,
  SavedQueryInput,
  TabRecord,
  TreeNode,
  TestResult,
} from "./types";

export type { QueryStarted };

/** execute_query 入参（maxRows=null → Rust 侧按设置/默认值解析） */
export interface ExecuteQueryArgs {
  connectionId: string;
  database: string | null;
  sql: string;
  maxRows: number | null;
}

export interface FormatRowsArgs {
  rows: Cell[][];
  columns: string[];
  format: "csv" | "json" | "insert";
  table: string | null;
}

export type IpcErrorCode =
  | "db"
  | "input"
  | "not_found"
  | "connection"
  | "cancelled"
  | "io"
  | "internal";

export interface IpcErrorPayload {
  code: IpcErrorCode;
  message: string;
}

const ERROR_CODES: readonly string[] = [
  "db",
  "input",
  "not_found",
  "connection",
  "cancelled",
  "io",
  "internal",
];

function isIpcErrorCode(value: unknown): value is IpcErrorCode {
  return typeof value === "string" && ERROR_CODES.includes(value);
}

/** Rust AppError 的前端镜像；所有 IPC 失败统一归一化为此类后抛出 */
export class IpcFailure extends Error {
  readonly code: IpcErrorCode;

  constructor(code: IpcErrorCode, message: string) {
    super(message);
    this.name = "IpcFailure";
    this.code = code;
  }
}

function toIpcFailure(raw: unknown): IpcFailure {
  if (typeof raw === "object" && raw !== null) {
    const payload = raw as Record<string, unknown>;
    if (isIpcErrorCode(payload.code) && typeof payload.message === "string") {
      return new IpcFailure(payload.code, payload.message);
    }
  }
  return new IpcFailure("internal", raw instanceof Error ? raw.message : String(raw));
}

/** 全仓唯一 tauriInvoke 调用点：调用 Rust 命令，非 Lattice 结构的错误包装为 internal */
export async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await tauriInvoke<T>(command, args ?? {});
  } catch (raw) {
    throw toIpcFailure(raw);
  }
}

/** 按域命令客户端；各域命令随阶段在此追加 */
export const api = {
  getAppInfo: (): Promise<AppInfo> => invoke("get_app_info"),
  getSetting: (key: string): Promise<string | null> => invoke("get_setting", { key }),
  setSetting: (key: string, value: string): Promise<void> => invoke("set_setting", { key, value }),

  listConnections: (): Promise<ConnectionSummary[]> => invoke("list_connections"),
  createConnection: (input: ConnectionInput): Promise<ConnectionSummary> =>
    invoke("create_connection", { input }),
  updateConnection: (id: string, input: ConnectionInput): Promise<ConnectionSummary> =>
    invoke("update_connection", { id, input }),
  deleteConnection: (id: string): Promise<void> => invoke("delete_connection", { id }),
  setConnectionFavorite: (id: string, favorite: boolean): Promise<ConnectionSummary> =>
    invoke("set_connection_favorite", { id, favorite }),
  testConnection: (input: ConnectionInput, id: string | null): Promise<TestResult> =>
    invoke("test_connection", { input, id }),
  connectDatabase: (id: string): Promise<void> => invoke("connect_database", { id }),
  disconnectDatabase: (id: string): Promise<void> => invoke("disconnect_database", { id }),
  browseTree: (id: string, path: NodePath): Promise<TreeNode[]> =>
    invoke("browse_tree", { id, path }),

  // ── 执行与结果（阶段三）──────────────────────────────
  executeQuery: (args: ExecuteQueryArgs): Promise<QueryStarted> =>
    invoke("execute_query", {
      connectionId: args.connectionId,
      database: args.database,
      sql: args.sql,
      maxRows: args.maxRows,
    }),
  cancelQuery: (queryId: string): Promise<void> => invoke("cancel_query", { queryId }),
  describeTable: (
    connectionId: string,
    database: string | null,
    schema: string,
    table: string,
  ): Promise<ColumnMeta[]> =>
    invoke("describe_table", { connectionId, database, schema, table }),
  formatRows: (args: FormatRowsArgs): Promise<{ text: string }> =>
    invoke("format_rows", {
      rows: args.rows,
      columns: args.columns,
      format: args.format,
      table: args.table,
    }),
  formatSql: (sql: string): Promise<string> => invoke("format_sql", { sql }),

  // ── 历史 / 保存查询 / 标签会话（阶段三）──────────────
  listQueryHistory: (connectionId: string | null, limit?: number): Promise<HistoryEntry[]> =>
    invoke("list_query_history", { connectionId, limit: limit ?? 200 }),
  clearQueryHistory: (): Promise<void> => invoke("clear_query_history"),
  listSavedQueries: (connectionId: string | null): Promise<SavedQuery[]> =>
    invoke("list_saved_queries", { connectionId }),
  saveSavedQuery: (input: SavedQueryInput): Promise<SavedQuery> =>
    invoke("save_saved_query", { input }),
  deleteSavedQuery: (id: string): Promise<void> => invoke("delete_saved_query", { id }),
  loadTabsSession: (): Promise<TabRecord[]> => invoke("load_tabs_session"),
  saveTabsSession: (tabs: TabRecord[]): Promise<void> => invoke("save_tabs_session", { tabs }),

  // ── ER 图 / 传输 / 任务（阶段四）─────────────────────
  describeErd: (
    connectionId: string,
    database: string | null,
    schema: string,
  ): Promise<ErdTable[]> => invoke("describe_erd", { connectionId, database, schema }),
  previewCsv: (path: string, delimiter: string, hasHeader: boolean): Promise<CsvPreview> =>
    invoke("preview_csv", { path, delimiter, hasHeader }),
  pickSavePath: (defaultName: string): Promise<string | null> =>
    invoke("pick_save_path", { defaultName }),
  pickOpenPath: (): Promise<string | null> => invoke("pick_open_path"),
  saveBinaryFile: (path: string, bytes: number[]): Promise<void> =>
    invoke("save_binary_file", { path, bytes }),
  exportQuery: (
    connectionId: string,
    database: string | null,
    sql: string,
    input: ExportInput,
  ): Promise<QueryStarted> => invoke("export_query", { connectionId, database, sql, input }),
  importCsv: (
    connectionId: string,
    database: string | null,
    table: string,
    input: ImportInput,
  ): Promise<QueryStarted> => invoke("import_csv", { connectionId, database, table, input }),
  cancelTask: (taskId: string): Promise<void> => invoke("cancel_task", { taskId }),

  // ── 系统（阶段五）────────────────────────────────────
  restartApp: (): Promise<void> => invoke("restart_app"),
  openLogDir: (): Promise<void> => invoke("open_log_dir"),
  openDataDir: (): Promise<void> => invoke("open_data_dir"),
  checkUpdate: (): Promise<UpdateInfo> => invoke("check_update"),
} as const;

export interface UpdateInfo {
  current: string;
  latest: string;
  hasUpdate: boolean;
  note: string;
}
