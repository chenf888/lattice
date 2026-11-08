/** 结果面板：多语句标签切换、筛选条、虚拟网格、状态栏（行数/耗时/加载更多） */

import { BarChart3, Download, Plus, X } from "lucide-react";
import { useCallback, useMemo, useState, type ReactElement } from "react";

import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { ExecutionState, StatementResult } from "@/lib/types";
import { useUiStore } from "@/stores/ui";
import { useI18n } from "@/lib/i18n";
import { ResultsGrid } from "./ResultsGrid";
import { applyFilters, FILTER_OP_LABEL, type FilterOp, type FilterRule } from "./grid-utils";

export interface ResultsViewProps {
  execution: ExecutionState | null;
  connectionName: string | null;
  /** 「加载更多」：按 2 倍上限重跑（仅全部语句为读时由父层提供） */
  onLoadMore?: () => void;
}

const STATUS_BADGE: Record<StatementResult["status"], { label: string; className: string }> = {
  pending: { label: "等待", className: "text-muted" },
  running: { label: "运行中", className: "text-accent" },
  ok: { label: "完成", className: "text-success" },
  error: { label: "错误", className: "text-danger" },
  cancelled: { label: "已取消", className: "text-warning" },
};

export function ResultsView({ execution, connectionName, onLoadMore }: ResultsViewProps): ReactElement {
  const { t } = useI18n();
  const setChartOpen = useUiStore((state) => state.setChartOpen);
  const openTransfer = useUiStore((state) => state.openTransfer);
  // 多结果集标签的用户切换（限定当前执行；新执行回到事件驱动的 activeIndex）
  const [override, setOverride] = useState<{ queryId: string; index: number } | null>(null);
  const statement: StatementResult | null = useMemo(() => {
    if (!execution) {
      return null;
    }
    const index =
      override && override.queryId === execution.queryId
        ? override.index
        : execution.activeIndex;
    return execution.statements[index] ?? execution.statements[0] ?? null;
  }, [execution, override]);

  const [rules, setRules] = useState<FilterRule[]>([]);

  const filteredRows = useMemo(() => {
    if (!statement) {
      return [];
    }
    return applyFilters(statement.rows, rules);
  }, [statement, rules]);

  const addRule = useCallback(() => {
    const col = statement?.columns[0];
    if (!col) {
      return;
    }
    setRules((previous) => [...previous, { col: 0, op: "eq", value: "" }]);
  }, [statement]);

  const onFilterByValue = useCallback((col: number, value: string) => {
    setRules((previous) => [...previous, { col, op: "eq", value }]);
  }, []);

  if (!execution || !statement) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <p className="text-[13px] text-muted">{t("尚无结果集")}</p>
          <p className="mt-1 text-xs text-muted/80">{t("按 Ctrl/⌘+Enter 执行编辑器中的 SQL")}</p>
        </div>
      </div>
    );
  }

  const running = execution.status === "running";
  const canLoadMore =
    !running && statement.truncated && execution.rerunnable && onLoadMore !== undefined;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 多结果集标签 */}
      {execution.statements.length > 1 && (
        <div className="flex h-8 shrink-0 items-center gap-1 overflow-x-auto border-b border-line px-2">
          {execution.statements.map((item) => {
            const badge = STATUS_BADGE[item.status];
            const active = item.index === execution.activeIndex;
            return (
              <button
                key={item.index}
                type="button"
                className={cn(
                  "flex shrink-0 items-center gap-1.5 rounded-token px-2 py-1 text-[12px] hover:bg-hover",
                  active && "bg-active/60 text-fg",
                  !active && "text-muted",
                )}
                onClick={() => setOverride({ queryId: execution.queryId, index: item.index })}
              >
                <span className={badge.className}>●</span>
                {t("结果")} {item.index + 1}
              </button>
            );
          })}
        </div>
      )}

      {/* 筛选条 */}
      <div className="flex shrink-0 flex-col gap-1 border-b border-line px-2 py-1.5">
        {rules.map((rule, ruleIndex) => (
          <div key={ruleIndex} className="flex items-center gap-1.5">
            <Select
              aria-label={t("筛选列")}
              className="w-36"
              value={String(rule.col)}
              onChange={(event) => {
                const col = Number(event.target.value);
                setRules((previous) =>
                  previous.map((item, index) => (index === ruleIndex ? { ...item, col } : item)),
                );
              }}
            >
              {statement.columns.map((column, index) => (
                <option key={index} value={index}>
                  {column.name}
                </option>
              ))}
            </Select>
            <Select
              aria-label={t("筛选操作符")}
              className="w-24"
              value={rule.op}
              onChange={(event) => {
                const op = event.target.value as FilterOp;
                setRules((previous) =>
                  previous.map((item, index) => (index === ruleIndex ? { ...item, op } : item)),
                );
              }}
            >
              {(Object.keys(FILTER_OP_LABEL) as FilterOp[]).map((op) => (
                <option key={op} value={op}>
                  {FILTER_OP_LABEL[op]}
                </option>
              ))}
            </Select>
            {!FILTER_OP_NULLISH.has(rule.op) && (
              <Input
                aria-label={t("筛选值")}
                className="w-44"
                value={rule.value}
                placeholder="值…"
                onChange={(event) => {
                  const value = event.target.value;
                  setRules((previous) =>
                    previous.map((item, index) => (index === ruleIndex ? { ...item, value } : item)),
                  );
                }}
              />
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              aria-label={t("移除筛选")}
              onClick={() => setRules((previous) => previous.filter((_, index) => index !== ruleIndex))}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-2 text-xs"
            onClick={addRule}
            disabled={statement.columns.length === 0}
          >
            <Plus className="h-3 w-3" aria-hidden />
            {t("添加筛选")}
          </Button>
          {rules.length > 0 && (
            <span className="text-[11px] text-muted">
              {t("已筛选：")}{filteredRows.length}/{statement.rows.length} {t("行")}
            </span>
          )}
        </div>
      </div>

      {/* 网格 */}
      <div className="min-h-0 flex-1">
        {statement.status === "error" ? (
          <div className="p-4">
            <p className="text-[13px] text-danger">{t("执行出错")}</p>
            <pre className="mt-2 whitespace-pre-wrap break-all rounded-token border border-line bg-base p-3 font-mono text-xs text-fg">
              {statement.error ?? t("未知错误")}
            </pre>
          </div>
        ) : statement.columns.length === 0 && statement.status === "pending" ? (
          <div className="grid h-full place-items-center">
            <div className="w-2/3 space-y-2" aria-hidden>
              {[0, 1, 2].map((index) => (
                <div key={index} className="h-4 animate-pulse rounded bg-hover" />
              ))}
            </div>
          </div>
        ) : statement.columns.length === 0 ? (
          <div className="p-4 text-xs text-muted">
            {t("语句已执行，无结果集（影响行数：")}{statement.rowsAffected ?? 0}{t("）")}
          </div>
        ) : (
          <ResultsGrid
            key={`${execution.queryId}:${statement.index}`}
            columns={statement.columns}
            rows={filteredRows}
            onFilterByValue={onFilterByValue}
          />
        )}
      </div>

      {/* 状态栏 */}
      <div className="flex h-7 shrink-0 items-center gap-3 border-t border-line bg-elevated px-2 text-[11px] text-muted">
        <span>
          {filteredRows.length.toLocaleString()} {t("行")}
          {statement.truncated && <span className="ml-1 text-warning">{t("（已截断）")}</span>}
        </span>
        {statement.durationMs !== null && <span>{t("耗时")} {statement.durationMs} ms</span>}
        {connectionName && <span>{t("连接：")}{connectionName}</span>}
        {execution.error && execution.status === "error" && (
          <span className="truncate text-danger" title={execution.error}>
            {execution.error}
          </span>
        )}
        <span className="flex-1" />
        {statement.columns.length > 0 && (
          <>
            <Button
              variant="ghost"
              size="sm"
              className="h-5 gap-1 px-2 text-[11px]"
              onClick={() => setChartOpen(true)}
            >
              <BarChart3 className="h-3 w-3" aria-hidden />
              {t("图表")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-5 gap-1 px-2 text-[11px]"
              onClick={() => openTransfer("export")}
            >
              <Download className="h-3 w-3" aria-hidden />
              {t("导出结果")}
            </Button>
          </>
        )}
        {canLoadMore && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="sm" className="h-5 px-2 text-[11px]" onClick={onLoadMore}>
                {t("加载更多")}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("按 2 倍行数上限重新执行（仅纯读取语句可用）")}</TooltipContent>
          </Tooltip>
        )}
        {running && <span className="text-accent">{t("执行中…")}</span>}
      </div>
    </div>
  );
}

const FILTER_OP_NULLISH: ReadonlySet<FilterOp> = new Set<FilterOp>(["isNull", "notNull"]);
