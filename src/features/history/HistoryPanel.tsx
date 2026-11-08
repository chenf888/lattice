/** 执行历史面板：按连接过滤、点击回填活动标签、清空 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, RotateCw, Trash2 } from "lucide-react";
import { useState, type ReactElement } from "react";

import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { api } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import type { HistoryEntry } from "@/lib/types";
import { useConnections } from "@/features/connections/use-connections";
import { toast } from "@/stores/toast";
import { useTabsStore } from "@/stores/tabs";
import { useI18n } from "@/lib/i18n";

const HISTORY_KEY = ["history"] as const;

const STATUS_DOT: Record<HistoryEntry["status"], string> = {
  ok: "bg-success",
  error: "bg-danger",
  cancelled: "bg-warning",
};

function formatTime(executedAt: number): string {
  const date = new Date(executedAt);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function HistoryPanel(): ReactElement {
  const { t } = useI18n();
  const { data: connections } = useConnections();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<string>("");

  const historyQuery = useQuery({
    queryKey: [...HISTORY_KEY, filter],
    queryFn: () => api.listQueryHistory(filter === "" ? null : filter, 200),
  });

  const clearMutation = useMutation({
    mutationFn: api.clearQueryHistory,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: HISTORY_KEY });
      toast.success(t("已清空历史"));
    },
  });

  const restore = useTabsStore((state) => {
    const active = state.tabs.find((tab) => tab.id === state.activeId);
    return active ? (sql: string) => state.updateSql(active.id, sql) : null;
  });

  const fill = (entry: HistoryEntry): void => {
    if (!restore) {
      toast.warning(t("没有活动标签可回填"));
      return;
    }
    restore(entry.sql);
    toast.info(t("已回填到当前标签"));
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-line px-2 py-1.5">
        <Clock className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
        <Select
          aria-label={t("按连接过滤")}
          className="h-6 flex-1 text-xs"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        >
          <option value="">{t("全部连接")}</option>
          {(connections ?? []).map((connection) => (
            <option key={connection.id} value={connection.id}>
              {connection.name}
            </option>
          ))}
        </Select>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          aria-label={t("刷新历史")}
          onClick={() => void historyQuery.refetch()}
        >
          <RotateCw className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 hover:text-danger"
          aria-label={t("清空历史")}
          onClick={() => {
            if (window.confirm(t("确认清空全部执行历史？"))) {
              clearMutation.mutate();
            }
          }}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {historyQuery.isPending ? (
          <div className="grid gap-2 p-2" aria-hidden>
            {[0, 1, 2, 3].map((index) => (
              <div key={index} className="h-10 animate-pulse rounded bg-hover" />
            ))}
          </div>
        ) : historyQuery.isError ? (
          <button
            type="button"
            className="m-2 rounded-token border border-line p-3 text-xs text-danger hover:bg-hover"
            onClick={() => void historyQuery.refetch()}
          >
            {t("加载失败，点击重试")}
          </button>
        ) : (historyQuery.data ?? []).length === 0 ? (
          <div className="flex flex-col items-center gap-1 px-4 pt-8 text-center">
            <Clock className="h-6 w-6 text-muted/60" aria-hidden />
            <p className="text-[13px]">{t("暂无执行历史")}</p>
            <p className="text-xs text-muted">{t("执行 SQL 后会在这里记录")}</p>
          </div>
        ) : (
          (historyQuery.data ?? []).map((entry) => (
            <button
              key={entry.id}
              type="button"
              className="block w-full rounded-token px-2 py-1.5 text-left hover:bg-hover focus-visible:bg-hover"
              onClick={() => fill(entry)}
              title={t("点击回填到当前标签")}
            >
              <div className="flex items-center gap-1.5">
                <span
                  className={cn("h-1.5 w-1.5 shrink-0 rounded-full", STATUS_DOT[entry.status])}
                  aria-hidden
                />
                <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg">
                  {entry.sql.split("\n")[0] ?? ""}
                </span>
                <span className="shrink-0 text-[10px] text-muted">{formatTime(entry.executedAt)}</span>
              </div>
              <div className="mt-0.5 flex items-center gap-2 pl-3 text-[10px] text-muted">
                <span>{entry.status === "ok" ? `${entry.rows ?? 0} ${t("行")}` : entry.status === "cancelled" ? t("已取消") : t("失败")}</span>
                {entry.durationMs !== null && <span>{entry.durationMs} ms</span>}
                {entry.error && <span className="min-w-0 flex-1 truncate text-danger">{entry.error}</span>}
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
