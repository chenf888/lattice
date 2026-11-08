/**
 * SQL 自动补全：关键字 + 表名（对象树缓存）+ 已引用表的列名（describe_table）。
 * SchemaCache 带进程内缓存；按连接懒加载，随树刷新失效由上层控制。
 */

import type { Completion, CompletionContext, CompletionSource } from "@codemirror/autocomplete";

import { api } from "@/lib/ipc";
import type { ColumnMeta, DriverKind } from "@/lib/types";

const SQL_KEYWORDS: readonly string[] = [
  "SELECT", "FROM", "WHERE", "INSERT", "INTO", "VALUES", "UPDATE", "SET", "DELETE",
  "CREATE", "ALTER", "DROP", "TRUNCATE", "TABLE", "VIEW", "INDEX", "JOIN", "LEFT",
  "RIGHT", "INNER", "OUTER", "CROSS", "FULL", "ON", "GROUP", "BY", "ORDER", "HAVING",
  "LIMIT", "OFFSET", "UNION", "ALL", "DISTINCT", "AS", "AND", "OR", "NOT", "NULL",
  "IS", "IN", "LIKE", "ILIKE", "BETWEEN", "EXISTS", "CASE", "WHEN", "THEN", "ELSE",
  "END", "ASC", "DESC", "COUNT", "SUM", "AVG", "MIN", "MAX", "RETURNING", "WITH",
  "BEGIN", "COMMIT", "ROLLBACK", "EXPLAIN", "PRIMARY", "KEY", "FOREIGN", "REFERENCES",
];

/** 默认目录上下文（补全加载表/列清单用） */
export interface CatalogContext {
  connectionId: string;
  driver: DriverKind;
  database: string;
  schema: string;
}

export class SchemaCache {
  private tables = new Map<string, string[]>();
  private columns = new Map<string, ColumnMeta[]>();
  private inflight = new Map<string, Promise<unknown>>();

  /** 表名清单（catalog 上下文缓存键 = 连接） */
  async getTables(catalog: CatalogContext): Promise<string[]> {
    const key = catalog.connectionId;
    const cached = this.tables.get(key);
    if (cached) {
      return cached;
    }
    const inflight = this.inflight.get(key) as Promise<string[]> | undefined;
    if (inflight) {
      return inflight;
    }
    const promise = api
      .browseTree(catalog.connectionId, {
        kind: "objects",
        database: catalog.database,
        schema: catalog.schema,
        objectKind: "tables",
      })
      .then((nodes) => {
        const names = nodes.map((node) => node.label);
        this.tables.set(key, names);
        this.inflight.delete(key);
        return names;
      })
      .catch(() => {
        this.inflight.delete(key);
        return [] as string[];
      });
    this.inflight.set(key, promise);
    return promise;
  }

  /** 列清单（键 = 连接|表；忽略库/schema 维度差异由调用方键名区分） */
  async getColumns(catalog: CatalogContext, table: string): Promise<ColumnMeta[]> {
    const key = `${catalog.connectionId}|${catalog.database}|${catalog.schema}|${table}`;
    const cached = this.columns.get(key);
    if (cached) {
      return cached;
    }
    const inflight = this.inflight.get(key) as Promise<ColumnMeta[]> | undefined;
    if (inflight) {
      return inflight;
    }
    const promise = api
      .describeTable(catalog.connectionId, catalog.database, catalog.schema, table)
      .then((columns) => {
        this.columns.set(key, columns);
        this.inflight.delete(key);
        return columns;
      })
      .catch(() => {
        this.inflight.delete(key);
        return [] as ColumnMeta[];
      });
    this.inflight.set(key, promise);
    return promise;
  }

  /** 对象树刷新后失效（连接维度） */
  invalidate(connectionId: string): void {
    this.tables.delete(connectionId);
    for (const key of this.columns.keys()) {
      if (key.startsWith(`${connectionId}|`)) {
        this.columns.delete(key);
      }
    }
  }
}

/** 从 SQL 文本提取 FROM/JOIN 后引用的表名（末段标识符，含引号包裹） */
export function extractReferencedTables(sql: string): string[] {
  const names = new Set<string>();
  const pattern = /(?:\bfrom\b|\bjoin\b)\s+(`[^`]+`|"[^"]+"|\[[^\]]+\]|[\w$]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(sql)) !== null) {
    const raw = match[1];
    if (!raw) {
      continue;
    }
    const trimmed = raw.replace(/^[`"[]+|[`"\]]+$/g, "");
    // schema.table 取末段
    const segments = trimmed.split(".");
    const table = segments[segments.length - 1];
    if (table && !table.startsWith("(")) {
      names.add(table);
    }
  }
  return [...names];
}

/** 构造补全源；catalog 由宿主按活动标签动态提供 */
export function makeCompletionSource(
  cache: SchemaCache,
  getCatalog: () => CatalogContext | null,
): CompletionSource {
  return async (context: CompletionContext) => {
    const catalog = getCatalog();
    if (!catalog) {
      return null;
    }
    const word = context.matchBefore(/[\w$]+/);
    if (!word && !context.explicit) {
      return null;
    }
    const from = word?.from ?? context.pos;

    const [tables, ...columnLists] = await Promise.all([
      cache.getTables(catalog),
      ...extractReferencedTables(context.state.doc.toString()).map((table) =>
        cache.getColumns(catalog, table),
      ),
    ]);

    const options: Completion[] = [
      ...tables.map((table) => ({ label: table, type: "table" as const })),
      ...columnLists.flat().map((column) => ({
        label: column.name,
        type: "property" as const,
        detail: column.typeName || undefined,
      })),
      ...SQL_KEYWORDS.map((keyword) => ({ label: keyword, type: "keyword" as const })),
    ];
    if (options.length === 0) {
      return null;
    }
    return { from, options, validFor: /^[\w$]*$/ };
  };
}
