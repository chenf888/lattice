/** 图表数据准备（纯函数）：维度/数值列推断与行→图形数据映射 */

import type { Cell, ColumnMeta } from "@/lib/types";
import { cellToDisplay, cellToNumber, inferNumericColumn } from "@/features/results/grid-utils";

export type ChartKind = "bar" | "line" | "pie";

/** 维度列：首个非数值列；全数值则取第一列 */
export function inferDimension(columns: ColumnMeta[], rows: Cell[][]): number {
  for (let index = 0; index < columns.length; index += 1) {
    if (!inferNumericColumn(rows, index)) {
      return index;
    }
  }
  return 0;
}

/** 数值列：全列数值推断，最多取 3 个 */
export function inferNumericColumns(columns: ColumnMeta[], rows: Cell[][]): number[] {
  const numeric: number[] = [];
  for (let index = 0; index < columns.length && numeric.length < 3; index += 1) {
    if (inferNumericColumn(rows, index)) {
      numeric.push(index);
    }
  }
  return numeric;
}

export interface ChartRow {
  dimension: string;
  [series: string]: string | number;
}

const CHART_ROW_LIMIT = 2_000;

/** 行数据 → Recharts 数据（截断到渲染上限；数值缺失按 0） */
export function buildChartData(
  rows: Cell[][],
  dimensionCol: number,
  valueCols: number[],
  columns: ColumnMeta[],
): ChartRow[] {
  const dimName = columns[dimensionCol]?.name ?? "维度";
  return rows.slice(0, CHART_ROW_LIMIT).map((row) => {
    const entry: ChartRow = {
      dimension: cellToDisplay(row[dimensionCol]) ?? "(NULL)",
    };
    for (const col of valueCols) {
      const name = columns[col]?.name ?? `列${col}`;
      const value = cellToNumber(row[col]);
      entry[name] = value ?? 0;
    }
    void dimName;
    return entry;
  });
}
