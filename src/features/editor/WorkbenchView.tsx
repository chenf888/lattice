/** 编辑器工作区：标签条 + 工具栏 + CodeMirror + 结果面板（可拖拽分割） */

import { Ban, History, Play, Save, Sparkles, SquareSplitHorizontal, Telescope } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Select } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useGlobalHotkeys } from "@/lib/hotkeys";
import { api, IpcFailure } from "@/lib/ipc";
import { subscribeQueryEvents } from "@/lib/query-events";
import { useConnections } from "@/features/connections/use-connections";
import { ChartDialog } from "@/features/charts/ChartDialog";
import { ExportDialog } from "@/features/transfer/ExportDialog";
import { ResultsView } from "@/features/results/ResultsView";
import { looksLikeWrite } from "@/features/results/grid-utils";
import { toast, toastError } from "@/stores/toast";
import {
  attachTabsPersistence,
  makeStatementList,
  registerRunHandler,
  selectActiveTab,
  useTabsStore,
} from "@/stores/tabs";
import { useUiStore } from "@/stores/ui";
import { useHotkeyCombo } from "@/stores/hotkeys";
import { useI18n } from "@/lib/i18n";
import { SchemaCache, type CatalogContext } from "./completions";
import { EditorTabsBar } from "./EditorTabsBar";
import { SaveQueryDialog } from "./SaveQueryDialog";
import { SqlEditor } from "./SqlEditor";

const MIN_EDITOR_HEIGHT = 120;
const MIN_RESULTS_HEIGHT = 140;

/** EXPLAIN 前缀按驱动 */
function explainPrefix(driver: string | null): string {
  return driver === "sqlite" ? "EXPLAIN QUERY PLAN " : "EXPLAIN ";
}

/** 取第一条语句（前端粗分句，仅用于 EXPLAIN 目标选择） */
function firstStatement(sql: string): string {
  return sql.split(";").find((part) => part.trim() !== "")?.trim() ?? sql.trim();
}

export function WorkbenchView(): ReactElement {
  const { t } = useI18n();
  const tabs = useTabsStore((state) => state.tabs);
  const activeId = useTabsStore((state) => state.activeId);
  const activeTab = useTabsStore(selectActiveTab);
  const { openTab, closeTab, reorder, setActive, updateSql, patchTab, setExecution } =
    useTabsStore.getState();
  const navigate = useUiStore((state) => state.navigate);
  const openRightPanel = useUiStore((state) => state.openRightPanel);
  const chartOpen = useUiStore((state) => state.chartOpen);
  const setChartOpen = useUiStore((state) => state.setChartOpen);
  const editorCompletions = useUiStore((state) => state.editorCompletions);
  const editorTabSize = useUiStore((state) => state.editorTabSize);
  const editorAutoFormat = useUiStore((state) => state.editorAutoFormat);
  const transferDialog = useUiStore((state) => state.transferDialog);
  const closeTransfer = useUiStore((state) => state.closeTransfer);
  const { data: connections } = useConnections();

  const [editorHeight, setEditorHeight] = useState(280);
  const [saveOpen, setSaveOpen] = useState(false);
  const [pendingRun, setPendingRun] = useState<string | null>(null);

  const schemaCache = useMemo(() => new SchemaCache(), []);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // 标签持久化订阅（一次性）
  useEffect(() => attachTabsPersistence(), []);

  // 外部一键执行入口（对象树「打开数据」等）
  useEffect(() => {
    registerRunHandler((sql) => {
      navigate({ view: "workbench" });
      runSqlRef.current(sql);
    });
    return () => registerRunHandler(null);
  }, [navigate, t]);

  // 查询事件 → 标签执行状态
  useEffect(() => {
    const unsubscribePromise = subscribeQueryEvents({
      onColumns: (payload) => {
        useTabsStore.getState().applyColumns(payload.queryId, payload.statementIndex, payload.columns);
      },
      onRows: (payload) => {
        useTabsStore.getState().appendRows(payload.queryId, payload.statementIndex, payload.rows);
      },
      onStatement: (payload) => {
        useTabsStore.getState().finishStatement(payload.queryId, payload.statementIndex, {
          status: payload.status,
          rows: payload.rows,
          rowsAffected: payload.rowsAffected,
          truncated: payload.truncated,
          durationMs: payload.durationMs,
          error: payload.error,
        });
      },
      onDone: (payload) => {
        useTabsStore
          .getState()
          .finishExecution(payload.queryId, payload.status, payload.error, payload.durationMs);
        if (payload.status === "error") {
          toast.error(`${t("执行失败")}：${payload.error ?? t("未知错误")}`);
        }
      },
    });
    return () => {
      void unsubscribePromise.then((unsubscribe) => unsubscribe());
    };
  }, [t]);

  const activeConnection = useMemo(
    () => connections?.find((connection) => connection.id === activeTab?.connectionId) ?? null,
    [connections, activeTab],
  );

  const catalog = useCallback((): CatalogContext | null => {
    const connection = activeConnection;
    if (!connection || connection.driver === "sqlite") {
      return connection
        ? { connectionId: connection.id, driver: connection.driver, database: "main", schema: "main" }
        : null;
    }
    const database = connection.database ?? "";
    if (database === "") {
      return null;
    }
    return {
      connectionId: connection.id,
      driver: connection.driver,
      database,
      schema: connection.driver === "mysql" ? database : "public",
    };
  }, [activeConnection]);

  /** 发起执行（readonly 二次确认之后） */
  const startExecution = useCallback(
    async (sql: string, maxRows: number | null) => {
      const tab = useTabsStore.getState().tabs.find((item) => item.id === useTabsStore.getState().activeId);
      if (!tab || !tab.connectionId) {
        toast.warning(t("标签未绑定连接，请先在工具栏选择连接"));
        return;
      }
      setPendingRun(null);
      try {
        const started = await api.executeQuery({
          connectionId: tab.connectionId,
          database: tab.database,
          sql,
          maxRows,
        });
        setExecution(tab.id, {
          queryId: started.queryId,
          statementCount: started.statementCount,
          rerunnable: started.rerunnable,
          statements: makeStatementList(started.statementCount),
          activeIndex: 0,
          status: "running",
          error: null,
          durationMs: null,
          sql,
        });
      } catch (error) {
        toastError(error, t("执行失败"));
      }
    },
    [setExecution, t],
  );

  const runSql = useCallback(
    (sql: string) => {
      if (sql.trim() === "") {
        toast.info(t("没有可执行的 SQL"));
        return;
      }
      const connection = activeConnection;
      if (connection?.readOnly && looksLikeWrite(sql)) {
        // 只读连接：前端二次确认（后端会话只读仍是权威拦截）
        setPendingRun(sql);
        return;
      }
      if (editorAutoFormat) {
        api
          .formatSql(sql)
          .then((formatted) => {
            if (activeTab) {
              updateSql(activeTab.id, formatted);
            }
            return startExecution(formatted, null);
          })
          .catch((error: unknown) => toastError(error, t("格式化失败")));
        return;
      }
      void startExecution(sql, null);
    },
    [activeConnection, startExecution, editorAutoFormat, activeTab, updateSql, t],
  );

  // runSql 的稳定转发（供注册钩子读取最新闭包）
  const runSqlRef = useRef(runSql);
  runSqlRef.current = runSql;

  const cancelExecution = useCallback(() => {
    const queryId = activeTab?.execution?.queryId;
    if (!queryId) {
      return;
    }
    api.cancelQuery(queryId).catch((error: unknown) => {
      if (error instanceof IpcFailure && error.code === "not_found") {
        return; // 已结束
      }
      toastError(error, "取消失败");
    });
  }, [activeTab]);

  const formatSql = useCallback(() => {
    if (!activeTab) {
      return;
    }
    api
      .formatSql(activeTab.sql)
      .then((formatted) => updateSql(activeTab.id, formatted))
      .catch((error: unknown) => toastError(error, "格式化失败"));
  }, [activeTab, updateSql]);

  const runExplain = useCallback(() => {
    if (!activeTab) {
      return;
    }
    const selected = activeTab.sql.slice(activeTab.cursorFrom, activeTab.cursorTo).trim();
    const target = selected !== "" ? selected : firstStatement(activeTab.sql);
    if (target === "") {
      toast.info(t("没有可执行的 SQL"));
      return;
    }
    runSql(`${explainPrefix(activeConnection?.driver ?? null)}${target};`);
  }, [activeTab, activeConnection, runSql, t]);

  const loadMore = useCallback(() => {
    const tab = activeTab;
    const statement = tab?.execution?.statements[tab.execution.activeIndex];
    if (!tab || !statement) {
      return;
    }
    const nextCap = Math.max(1_000, (statement.rows.length + 1) * 2);
    void startExecution(tab.execution?.sql ?? tab.sql, nextCap);
  }, [activeTab, startExecution]);

  // ── 热键（注册表可改绑；编辑器聚焦时同样生效）──
  const newTabCombo = useHotkeyCombo("newTab");
  const closeTabCombo = useHotkeyCombo("closeTab");
  const saveQueryCombo = useHotkeyCombo("saveQuery");
  const runAllCombo = useHotkeyCombo("runAll");
  const runSelectedCombo = useHotkeyCombo("runSelected");
  const hotkeys = useMemo(
    () => ({
      [newTabCombo]: () => {
        openTab({ connectionId: activeTab?.connectionId ?? null });
        navigate({ view: "workbench" });
      },
      [closeTabCombo]: () => {
        if (activeTab) {
          closeTab(activeTab.id);
        }
      },
      [saveQueryCombo]: () => {
        if (activeTab) {
          setSaveOpen(true);
        }
      },
      [runAllCombo]: () => runSql(activeTab?.sql ?? ""),
      [runSelectedCombo]: () => {
        if (!activeTab) {
          return;
        }
        const selected = activeTab.sql.slice(activeTab.cursorFrom, activeTab.cursorTo).trim();
        runSql(selected);
      },
    }),
    [newTabCombo, closeTabCombo, saveQueryCombo, runAllCombo, runSelectedCombo, openTab, closeTab, navigate, activeTab, runSql],
  );
  useGlobalHotkeys(hotkeys);

  // 编辑器/结果分割拖拽
  const onDividerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const container = containerRef.current;
      if (!container) {
        return;
      }
      const rect = container.getBoundingClientRect();
      const onMove = (moveEvent: PointerEvent) => {
        const offset = moveEvent.clientY - rect.top;
        const max = rect.height - MIN_RESULTS_HEIGHT;
        setEditorHeight(Math.min(max, Math.max(MIN_EDITOR_HEIGHT, offset)));
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [],
  );

  const running = activeTab?.execution?.status === "running";

  if (tabs.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 rounded-token border border-line bg-elevated/50">
        <p className="text-[14px]">{t("SQL 工作台")}</p>
        <p className="text-xs text-muted">{t("新建查询标签开始工作；从左侧对象树右键「打开数据」可直接浏览表")}</p>
        <div className="flex gap-2">
          <Button
            size="sm"
            onClick={() => {
              openTab({ connectionId: connections?.[0]?.id ?? null });
              navigate({ view: "workbench" });
            }}
          >
            <Play className="h-3.5 w-3.5" aria-hidden />
            {t("新建查询标签")}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => navigate({ view: "connections" })}>
            {t("管理连接")}
          </Button>
        </div>
        <SaveQueryDialog open={saveOpen} onOpenChange={setSaveOpen} tab={null} />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" ref={containerRef}>
      <EditorTabsBar
        tabs={tabs}
        activeId={activeId}
        onSelect={setActive}
        onClose={closeTab}
        onReorder={reorder}
      />

      {/* 工具栏 */}
      <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-line px-2">
        <Select
          aria-label={t("标签连接")}
          className="h-7 w-44"
          value={activeTab?.connectionId ?? ""}
          onChange={(event) => {
            if (activeTab) {
              patchTab(activeTab.id, { connectionId: event.target.value === "" ? null : event.target.value });
            }
          }}
        >
          <option value="">选择连接…</option>
          {(connections ?? []).map((connection) => (
            <option key={connection.id} value={connection.id}>
              {connection.name}
              {connection.readOnly ? "（只读）" : ""}
            </option>
          ))}
        </Select>
        {activeConnection?.readOnly && (
          <span className="rounded-token border border-warning/50 px-1.5 py-0.5 text-[10px] text-warning">
            只读
          </span>
        )}
        <span className="flex-1" />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="default"
              size="sm"
              className="h-7 gap-1 px-2.5"
              disabled={running || !activeTab}
              onClick={() => runSql(activeTab?.sql ?? "")}
            >
              <Play className="h-3.5 w-3.5" aria-hidden />
              {t("运行全部")}
            </Button>
          </TooltipTrigger>
          <TooltipContent>Ctrl/⌘+Enter</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2.5"
              disabled={running || !activeTab}
              onClick={() => {
                if (!activeTab) return;
                const selected = activeTab.sql.slice(activeTab.cursorFrom, activeTab.cursorTo).trim();
                runSql(selected);
              }}
            >
              {t("运行选中")}
            </Button>
          </TooltipTrigger>
          <TooltipContent>Ctrl/⌘+Shift+Enter</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2.5"
              disabled={!running}
              onClick={cancelExecution}
            >
              <Ban className="h-3.5 w-3.5" aria-hidden />
              {t("取消")}
            </Button>
          </TooltipTrigger>
          <TooltipContent>中断当前查询</TooltipContent>
        </Tooltip>
        <span className="mx-1 h-4 w-px bg-line" aria-hidden />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={t("格式化 SQL")} onClick={formatSql}>
              <Sparkles className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>格式化 SQL</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              aria-label="EXPLAIN"
              disabled={running}
              onClick={runExplain}
            >
              <Telescope className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>EXPLAIN 选中 / 第一条语句</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              aria-label={t("保存查询")}
              onClick={() => setSaveOpen(true)}
            >
              <Save className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>保存查询（Ctrl/⌘+S）</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              aria-label={t("执行历史")}
              onClick={() => openRightPanel("history")}
            >
              <History className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>执行历史</TooltipContent>
        </Tooltip>
      </div>

      {/* 编辑器 + 分割条 + 结果 */}
      <div className="min-h-0 flex-1">
        <div style={{ height: editorHeight }} className="min-h-0 overflow-hidden">
          {activeTab && (
            <SqlEditor
              key={`${activeTab.id}:${activeConnection?.driver ?? "none"}:${editorTabSize}:${String(editorCompletions)}`}
              value={activeTab.sql}
              dialect={activeConnection?.driver ?? null}
              schemaCache={schemaCache}
              getCatalog={catalog}
              completions={editorCompletions}
              tabSize={editorTabSize}
              restoreKey={activeTab.id}
              cursorFrom={activeTab.cursorFrom}
              cursorTo={activeTab.cursorTo}
              scrollTop={activeTab.scrollTop}
              onChange={(sql) => updateSql(activeTab.id, sql)}
              onSelectionChange={(from, to) => {
                patchTab(activeTab.id, { cursorFrom: from, cursorTo: to });
              }}
              onScroll={(scrollTop) => patchTab(activeTab.id, { scrollTop })}
            />
          )}
        </div>
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label={t("调整编辑器与结果区高度")}
          tabIndex={0}
          className="group flex h-1.5 shrink-0 cursor-row-resize items-center justify-center hover:bg-accent/30"
          onPointerDown={onDividerDown}
          onKeyDown={(event) => {
            if (event.key === "ArrowUp") {
              setEditorHeight((height) => height - 20);
            } else if (event.key === "ArrowDown") {
              setEditorHeight((height) => height + 20);
            }
          }}
        >
          <SquareSplitHorizontal className="h-3 w-3 text-muted opacity-0 group-hover:opacity-100" aria-hidden />
        </div>
        <div
          className="min-h-0 border-t border-line"
          style={{ height: `calc(100% - ${editorHeight + 6}px)` }}
        >
          <ResultsView
            execution={activeTab?.execution ?? null}
            connectionName={activeConnection?.name ?? null}
            onLoadMore={activeTab?.execution?.rerunnable ? loadMore : undefined}
          />
        </div>
      </div>

      <SaveQueryDialog open={saveOpen} onOpenChange={setSaveOpen} tab={activeTab} />

      <ChartDialog
        open={chartOpen}
        onOpenChange={setChartOpen}
        columns={activeTab?.execution?.statements[activeTab.execution.activeIndex]?.columns ?? []}
        rows={activeTab?.execution?.statements[activeTab.execution.activeIndex]?.rows ?? []}
      />
      {transferDialog === "export" && (
        <ExportDialog
          open
          onOpenChange={(open) => !open && closeTransfer()}
          connectionId={activeTab?.connectionId ?? null}
          database={activeTab?.database ?? null}
          sql={activeTab?.execution?.sql ?? null}
          columns={activeTab?.execution?.statements[activeTab.execution.activeIndex]?.columns ?? []}
          defaultTable={null}
        />
      )}

      {/* 只读连接写语句二次确认 */}
      <Dialog open={pendingRun !== null} onOpenChange={(open) => !open && setPendingRun(null)}>
        {pendingRun !== null && (
          <DialogContent className="w-[480px]">
            <DialogTitle>连接处于只读模式</DialogTitle>
            <DialogDescription>
              该语句可能包含写操作。确认后仍会提交执行——后端会话为只读，写操作将被数据库拒绝。
            </DialogDescription>
            <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-token border border-line bg-base p-3 font-mono text-xs">
              {pendingRun}
            </pre>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-token border border-line px-3 py-1.5 text-xs hover:bg-hover"
                onClick={() => setPendingRun(null)}
              >
                {t("取消")}
              </button>
              <button
                type="button"
                className="rounded-token bg-warning px-3 py-1.5 text-xs text-white hover:opacity-90"
                onClick={() => void startExecution(pendingRun, null)}
              >
                仍要执行
              </button>
            </div>
          </DialogContent>
        )}
      </Dialog>

      {/* 运行指示（无障碍） */}
      <span className="sr-only" aria-live="polite">
        {running ? t("查询执行中") : ""}
      </span>
    </div>
  );
}
