/** 结果网格纯工具：Cell 渲染、数值推断、筛选、排序比较器、写语句启发式 */

import type { Cell } from "@/lib/types";

export type FilterOp =
  | "eq"
  | "ne"
  | "contains"
  | "gt"
  | "lt"
  | "ge"
  | "le"
  | "isNull"
  | "notNull";

export const FILTER_OP_LABEL: Record<FilterOp, string> = {
  eq: "=",
  ne: "≠",
  contains: "包含",
  gt: ">",
  lt: "<",
  ge: "≥",
  le: "≤",
  isNull: "为 NULL",
  notNull: "非 NULL",
};

export interface FilterRule {
  col: number;
  op: FilterOp;
  value: string;
}

/** NULL → null；字节 → <BLOB n bytes>；其余字符串化 */
export function cellToDisplay(cell: Cell | undefined): string | null {
  if (cell === undefined || cell === "null") {
    return null;
  }
  if ("text" in cell) {
    return cell.text;
  }
  if ("bytes" in cell) {
    return `<BLOB ${cell.bytes.length} bytes>`;
  }
  if ("bool" in cell) {
    return cell.bool ? "TRUE" : "FALSE";
  }
  if ("int" in cell) {
    return String(cell.int);
  }
  return String(cell.float);
}

/** 网格数字比较用：仅 int/float 可比较；text 数值不当数字（避免混合列误判） */
export function cellToNumber(cell: Cell | undefined): number | null {
  if (cell === undefined || cell === "null") {
    return null;
  }
  if ("int" in cell) {
    return cell.int;
  }
  if ("float" in cell) {
    return cell.float;
  }
  return null;
}

export function isNumericCell(cell: Cell | undefined): boolean {
  return cellToNumber(cell) !== null;
}

/** 列级数值推断：抽样 ≤500 个非空值全部为数值才按数值排序 */
export function inferNumericColumn(rows: Cell[][], col: number): boolean {
  let seen = 0;
  for (const row of rows) {
    const cell = row[col];
    if (cell === undefined || cell === "null") {
      continue;
    }
    if (cellToNumber(cell) === null) {
      return false;
    }
    seen += 1;
    if (seen >= 500) {
      break;
    }
  }
  return seen > 0;
}

function compareNullable(
  a: Cell | undefined,
  b: Cell | undefined,
  numeric: boolean,
): number {
  const aNull = a === undefined || a === "null";
  const bNull = b === undefined || b === "null";
  if (aNull && bNull) return 0;
  if (aNull) return 1; // NULL 恒排末尾
  if (bNull) return -1;
  if (numeric) {
    const na = cellToNumber(a) ?? 0;
    const nb = cellToNumber(b) ?? 0;
    return na - nb;
  }
  const ta = cellToDisplay(a) ?? "";
  const tb = cellToDisplay(b) ?? "";
  return ta < tb ? -1 : ta > tb ? 1 : 0;
}

export function makeRowComparator(
  col: number,
  dir: "asc" | "desc",
  numeric: boolean,
): (a: Cell[], b: Cell[]) => number {
  const factor = dir === "asc" ? 1 : -1;
  return (a, b) => compareNullable(a[col], b[col], numeric) * factor;
}

function matchesFilter(cell: Cell | undefined, op: FilterOp, value: string): boolean {
  const display = cellToDisplay(cell);
  switch (op) {
    case "isNull":
      return display === null;
    case "notNull":
      return display !== null;
    case "eq":
      return display === value;
    case "ne":
      return display !== value;
    case "contains":
      return display !== null && value !== "" && display.includes(value);
    case "gt":
    case "lt":
    case "ge":
    case "le": {
      if (display === null || value === "") {
        return false;
      }
      const num = cellToNumber(cell);
      const target = Number(value);
      if (num !== null && Number.isFinite(target)) {
        return op === "gt" ? num > target : op === "lt" ? num < target : op === "ge" ? num >= target : num <= target;
      }
      // 非数值列退化为字典序
      const cmp = (display ?? "") < value ? -1 : (display ?? "") > value ? 1 : 0;
      return op === "gt" ? cmp > 0 : op === "lt" ? cmp < 0 : op === "ge" ? cmp >= 0 : cmp <= 0;
    }
    default: {
      const unreachable: never = op;
      return unreachable;
    }
  }
}

/** 叠加筛选：全部规则同时满足 */
export function applyFilters(rows: Cell[][], rules: FilterRule[]): Cell[][] {
  if (rules.length === 0) {
    return rows;
  }
  return rows.filter((row) => rules.every((rule) => matchesFilter(row[rule.col], rule.op, rule.value)));
}

// ── 写语句启发式（只读连接二次确认提示用；权威拦截在后端会话）──

const READ_KEYWORDS = new Set([
  "SELECT", "WITH", "TABLE", "VALUES", "SHOW", "DESC", "DESCRIBE", "LIST", "EXPLAIN",
]);

/** 保守判定是否可能是写语句：非读取关键字开头即按写处理 */
export function looksLikeWrite(sql: string): boolean {
  let rest = sql.trimStart();
  // 跳过前导注释
  for (;;) {
    if (rest.startsWith("--")) {
      const newline = rest.indexOf("\n");
      if (newline < 0) return true;
      rest = rest.slice(newline + 1).trimStart();
    } else if (rest.startsWith("/*")) {
      const end = rest.indexOf("*/");
      if (end < 0) return true;
      rest = rest.slice(end + 2).trimStart();
    } else {
      break;
    }
  }
  rest = rest.replace(/^\(+/, "").trimStart();
  const word = /^([A-Za-z_]+)/.exec(rest);
  if (!word) {
    return true; // 不可识别 → 保守按写
  }
  const upper = word[1]?.toUpperCase() ?? "";
  if (upper !== "EXPLAIN") {
    return !READ_KEYWORDS.has(upper);
  }
  // EXPLAIN ANALYZE 会真实执行内层语句
  const after = rest.slice(word[1]?.length ?? 0).trimStart();
  const inner = /^([A-Za-z_]+)/.exec(after);
  if (!inner) {
    return false;
  }
  const innerUpper = inner[1]?.toUpperCase() ?? "";
  if (innerUpper === "ANALYZE" || innerUpper === "ANALYSE") {
    const target = after.slice(inner[1]?.length ?? 0).trimStart();
    return looksLikeWrite(target);
  }
  return false;
}
