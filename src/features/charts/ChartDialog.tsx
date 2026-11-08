/** 图表对话框：当前结果集一键可视化（柱/折/饼），X/Y 手动切换 */

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell as PieCell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useEffect, useMemo, useState, type ReactElement } from "react";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import type { Cell, ColumnMeta } from "@/lib/types";
import { buildChartData, inferDimension, inferNumericColumns, type ChartKind } from "./chart-utils";
import { inferNumericColumn } from "@/features/results/grid-utils";

const SERIES_COLORS = ["#4F8CFF", "#3FB950", "#D29922", "#F85149", "#8B93A1"];

export interface ChartDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  columns: ColumnMeta[];
  rows: Cell[][];
}

export function ChartDialog({ open, onOpenChange, columns, rows }: ChartDialogProps): ReactElement {
  const { t } = useI18n();
  const [kind, setKind] = useState<ChartKind>("bar");
  const [dimensionCol, setDimensionCol] = useState(0);
  const [valueCols, setValueCols] = useState<number[]>([]);

  // 打开时按列推断重置
  useEffect(() => {
    if (open && columns.length > 0) {
      setDimensionCol(inferDimension(columns, rows));
      setValueCols(inferNumericColumns(columns, rows).slice(0, 1));
    }
    // rows 变化不重置（保持用户选择）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, columns]);

  const data = useMemo(
    () => buildChartData(rows, dimensionCol, valueCols, columns),
    [rows, dimensionCol, valueCols, columns],
  );

  const numericColumnOptions = useMemo(
    () =>
      columns
        .map((column, index) => ({ column, index }))
        .filter(({ index }) => inferNumericColumn(rows.slice(0, 500), index)),
    [columns, rows],
  );

  const toggleSeries = (col: number): void => {
    setValueCols((previous) => {
      if (previous.includes(col)) {
        return previous.filter((index) => index !== col);
      }
      if (previous.length >= 3) {
        return [...previous.slice(1), col];
      }
      return [...previous, col];
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <DialogContent className="flex h-[560px] w-[860px] flex-col">
          <DialogTitle>{t("结果可视化")}</DialogTitle>
          <div className="mt-3 flex shrink-0 items-center gap-2">
            {(
              [
                { kind: "bar", label: t("柱状图") },
                { kind: "line", label: t("折线图") },
                { kind: "pie", label: t("饼图") },
              ] as const
            ).map((item) => (
              <Button
                key={item.kind}
                variant={kind === item.kind ? "default" : "ghost"}
                size="sm"
                className="h-7 px-2.5 text-xs"
                onClick={() => setKind(item.kind)}
              >
                {item.label}
              </Button>
            ))}
            <span className="mx-1 h-4 w-px bg-line" aria-hidden />
            <Select
              aria-label="维度列（X）"
              className="w-40"
              value={String(dimensionCol)}
              onChange={(event) => setDimensionCol(Number(event.target.value))}
            >
              {columns.map((column, index) => (
                <option key={index} value={index}>
                  X：{column.name}
                </option>
              ))}
            </Select>
            {numericColumnOptions.map(({ column, index }) => (
              <button
                key={index}
                type="button"
                className={cn(
                  "rounded-token border px-2 py-1 text-xs",
                  valueCols.includes(index)
                    ? "border-accent bg-accent/10 text-fg"
                    : "border-line text-muted hover:bg-hover",
                )}
                onClick={() => toggleSeries(index)}
              >
                {column.name}
              </button>
            ))}
            <span className="flex-1" />
            <span className="text-[11px] text-muted">
              {t("渲染前")} {Math.min(rows.length, 2000).toLocaleString()} {t("行")}
            </span>
          </div>

          <div className="min-h-0 flex-1">
            {valueCols.length === 0 || data.length === 0 ? (
              <div className="grid h-full place-items-center text-xs text-muted">
                {t("选择至少一个数值列（Y 轴）")}
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                {kind === "bar" ? (
                  <BarChart data={data}>
                    <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                    <XAxis dataKey="dimension" stroke="var(--text-muted)" fontSize={11} />
                    <YAxis stroke="var(--text-muted)" fontSize={11} />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "var(--bg-elevated)",
                        border: "1px solid var(--border)",
                        borderRadius: 6,
                        fontSize: 12,
                      }}
                    />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    {valueCols.map((col, seriesIndex) => (
                      <Bar
                        key={col}
                        dataKey={columns[col]?.name ?? `列${col}`}
                        fill={SERIES_COLORS[seriesIndex % SERIES_COLORS.length]}
                      />
                    ))}
                  </BarChart>
                ) : kind === "line" ? (
                  <LineChart data={data}>
                    <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                    <XAxis dataKey="dimension" stroke="var(--text-muted)" fontSize={11} />
                    <YAxis stroke="var(--text-muted)" fontSize={11} />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "var(--bg-elevated)",
                        border: "1px solid var(--border)",
                        borderRadius: 6,
                        fontSize: 12,
                      }}
                    />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    {valueCols.map((col, seriesIndex) => (
                      <Line
                        key={col}
                        type="monotone"
                        dataKey={columns[col]?.name ?? `列${col}`}
                        stroke={SERIES_COLORS[seriesIndex % SERIES_COLORS.length]}
                        dot={false}
                      />
                    ))}
                  </LineChart>
                ) : (
                  <PieChart>
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "var(--bg-elevated)",
                        border: "1px solid var(--border)",
                        borderRadius: 6,
                        fontSize: 12,
                      }}
                    />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Pie
                      data={data}
                      dataKey={(() => {
                        const first = valueCols[0];
                        return first === undefined ? "value" : (columns[first]?.name ?? "value");
                      })()}
                      nameKey="dimension"
                    >
                      {data.map((_entry, index) => (
                        <PieCell key={index} fill={SERIES_COLORS[index % SERIES_COLORS.length]} />
                      ))}
                    </Pie>
                  </PieChart>
                )}
              </ResponsiveContainer>
            )}
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
