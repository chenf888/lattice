import type { NodePath, ObjectKind, TreeNode } from "@/lib/types";

/** Schema 节点展开后的四类容器（前端构造，展开时各自发起服务端查询） */
export const SCHEMA_KIND_GROUPS: ReadonlyArray<{ kind: ObjectKind; label: string }> = [
  { kind: "tables", label: "表" },
  { kind: "views", label: "视图" },
  { kind: "functions", label: "函数" },
  { kind: "sequences", label: "序列" },
];

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * 由服务端节点 id 反解 NodePath：
 * - `databases/{connectionId}` → {kind:"databases"}（连接根展开）
 * - `db/{database}`            → {kind:"schemas", database}
 * - `objects/{db}/{schema}/{kind}` → {kind:"objects", ...}（四类容器节点）
 * - 其余（schema 节点、对象叶子）返回 null：无服务端子查询
 */
export function parseNodeId(id: string): NodePath | null {
  const parts = id.split("/").map(decodeSegment);
  if (parts[0] === "databases" && parts.length === 2) {
    return { kind: "databases" };
  }
  if (parts[0] === "db" && parts.length === 2 && parts[1]) {
    return { kind: "schemas", database: parts[1] };
  }
  if (parts[0] === "objects" && parts.length === 4) {
    const kind = parts[3];
    if (kind === "tables" || kind === "views" || kind === "functions" || kind === "sequences") {
      return {
        kind: "objects",
        database: parts[1] ?? "",
        schema: parts[2] ?? "",
        objectKind: kind,
      };
    }
  }
  return null;
}

/** 搜索高亮：命片段落以 <mark> 呈现（逻辑拆分，渲染在组件内） */
export function splitHighlight(label: string, query: string): Array<{ text: string; hit: boolean }> {
  const q = query.trim();
  if (!q) return [{ text: label, hit: false }];
  const index = label.toLowerCase().indexOf(q.toLowerCase());
  if (index < 0) return [{ text: label, hit: false }];
  return [
    { text: label.slice(0, index), hit: false },
    { text: label.slice(index, index + q.length), hit: true },
    { text: label.slice(index + q.length), hit: false },
  ].filter((part) => part.text.length > 0);
}

export function schemaGroupNodes(schemaNodeId: string): TreeNode[] {
  const parts = schemaNodeId.split("/").map(decodeSegment);
  const database = parts[1] ?? "";
  const schema = parts[2] ?? "";
  return SCHEMA_KIND_GROUPS.map(({ kind, label }) => ({
    id: `objects/${encodeURIComponent(database)}/${encodeURIComponent(schema)}/${kind}`,
    label,
    nodeKind: "group" as const,
    hasChildren: true,
    isSystem: false,
    meta: null,
  }));
}

/** 对象叶子节点 id 反解：`objects/{db}/{schema}/{kind}/{table}` */
export interface LeafObjectId {
  database: string;
  schema: string;
  objectKind: ObjectKind;
  table: string;
}

export function parseLeafObjectId(id: string): LeafObjectId | null {
  const parts = id.split("/").map(decodeSegment);
  if (parts[0] !== "objects" || parts.length !== 5) {
    return null;
  }
  const kind = parts[3];
  if (kind !== "tables" && kind !== "views") {
    return null;
  }
  return {
    database: parts[1] ?? "",
    schema: parts[2] ?? "",
    objectKind: kind,
    table: parts[4] ?? "",
  };
}

/** 按驱动引用标识符 */
export function quoteIdent(name: string, driver: string | null): string {
  return driver === "mysql" ? "`" + name + "`" : '"' + name + '"';
}
