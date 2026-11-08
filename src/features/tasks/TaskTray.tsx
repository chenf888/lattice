/** 右下角任务托盘：运行中任务进度、取消、日志展开、错误行报告、清空已完成 */

import { AlertTriangle, ChevronDown, ChevronUp, Loader2, X } from "lucide-react";
import { useState, type ReactElement } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { api } from "@/lib/ipc";
import type { TaskItem } from "@/lib/types";
import { useTasksStore } from "@/stores/tasks";
import { useI18n } from "@/lib/i18n";

function statusColor(status: TaskItem["status"]): string {
  switch (status) {
    case "running":
      return "text-accent";
    case "completed":
      return "text-success";
    case "cancelled":
      return "text-warning";
    case "error":
      return "text-danger";
    default: {
      const unreachable: never = status;
      return unreachable;
    }
  }
}

function TaskRow({ item }: { item: TaskItem }): ReactElement {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const percent =
    item.total !== null && item.total > 0
      ? Math.min(100, Math.round((item.done / item.total) * 100))
      : null;
  return (
    <div className="rounded-token border border-line bg-elevated p-2">
      <div className="flex items-center gap-1.5">
        {item.status === "running" ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" aria-hidden />
        ) : item.status === "error" ? (
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-danger" aria-hidden />
        ) : (
          <span className={cn("h-2 w-2 shrink-0 rounded-full", item.status === "completed" ? "bg-success" : "bg-warning")} aria-hidden />
        )}
        <span className="min-w-0 flex-1 truncate text-[12px] text-fg">
          {item.title}
          <span className={cn("ml-1.5 text-[11px]", statusColor(item.status))}>
            {item.status === "running" ? t("运行中") : item.status === "completed" ? t("完成") : item.status === "cancelled" ? t("已取消") : t("失败")}
          </span>
        </span>
        {item.status === "running" ? (
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5"
            aria-label={t("取消任务")}
            onClick={() => {
              api.cancelTask(item.id).catch(() => {
                // 已结束的任务取消报 NotFound，忽略
              });
            }}
          >
            <X className="h-3 w-3" />
          </Button>
        ) : null}
      </div>
      <div className="mt-1 flex items-center gap-2">
        <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-hover">
          <div
            className={cn("h-full rounded-token transition-[width] duration-150 ease-out", item.status === "error" ? "bg-danger" : "bg-accent")}
            style={{ width: `${percent ?? (item.status === "running" ? 15 : 100)}%` }}
          />
        </div>
        <span className="shrink-0 text-[10px] text-muted">
          {item.done.toLocaleString()} {t("行")}
          {item.result ? ` · ${item.result.durationMs} ms` : ""}
        </span>
      </div>
      {item.result && item.result.skippedRows.length > 0 && (
        <p className="mt-1 text-[10px] text-warning">
          {t("跳过")} {item.result.skippedRows.length} {t("行")}（{item.result.skippedRows.slice(0, 10).join(", ")}
          {item.result.skippedRows.length > 10 ? "…" : ""}）
        </p>
      )}
      {item.error && <p className="mt-1 truncate text-[10px] text-danger" title={item.error}>{item.error}</p>}
      <button
        type="button"
        className="mt-0.5 flex items-center gap-0.5 text-[10px] text-muted hover:text-fg"
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? <ChevronUp className="h-2.5 w-2.5" aria-hidden /> : <ChevronDown className="h-2.5 w-2.5" aria-hidden />}
        {t("日志")}
      </button>
      {expanded && (
        <pre className="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap break-all rounded bg-base p-1.5 font-mono text-[10px] text-muted">
          {item.logs.length > 0 ? item.logs.join("\n") : t("（无日志）")}
        </pre>
      )}
    </div>
  );
}

export function TaskTray(): ReactElement | null {
  const { t } = useI18n();
  const items = useTasksStore((state) => state.items);
  const trayOpen = useTasksStore((state) => state.trayOpen);
  const toggleTray = useTasksStore((state) => state.toggleTray);
  const clearFinished = useTasksStore((state) => state.clearFinished);

  const runningCount = items.filter((item) => item.status === "running").length;

  if (items.length === 0) {
    return null;
  }

  return (
    <div className="pointer-events-none fixed bottom-3 right-3 z-40 flex max-h-[50vh] w-72 flex-col">
      {trayOpen ? (
        <div className="pointer-events-auto flex min-h-0 flex-col rounded-token border border-line bg-base shadow-pop">
          <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-2 text-[12px] font-medium">
            {t("后台任务")}
            <span className="text-[10px] text-muted">{runningCount > 0 ? `${runningCount} 运行中` : ""}</span>
            <span className="flex-1" />
            <Button variant="ghost" size="icon" className="h-5 w-5" aria-label={t("收起托盘")} onClick={() => toggleTray(false)}>
              <ChevronDown className="h-3 w-3" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5"
              aria-label={t("清空已完成")}
              onClick={clearFinished}
            >
              <X className="h-3 w-3" />
            </Button>
          </div>
          <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
            {items.map((item) => (
              <TaskRow key={item.id} item={item} />
            ))}
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="pointer-events-auto ml-auto flex h-8 items-center gap-1.5 rounded-token border border-line bg-base px-2.5 text-[12px] shadow-pop hover:bg-hover"
          onClick={() => toggleTray(true)}
        >
          {runningCount > 0 && <Loader2 className="h-3 w-3 animate-spin text-accent" aria-hidden />}
          {t("后台任务")}（{items.length}）
          <ChevronUp className="h-3 w-3 text-muted" aria-hidden />
        </button>
      )}
    </div>
  );
}
