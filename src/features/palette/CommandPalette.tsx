/** 命令面板：Ctrl/⌘+K 全局动作；Ctrl/⌘+P 快速打开（保存查询 + 最近表） */

import { useQuery } from "@tanstack/react-query";
import { CornerDownLeft, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";

import { Dialog, DialogContent } from "@/components/ui/dialog";
import { useGlobalHotkeys } from "@/lib/hotkeys";
import { api } from "@/lib/ipc";
import type { PaletteAction } from "./palette-actions";
import { matchActions } from "./palette-actions";
import { useConnections } from "@/features/connections/use-connections";
import { toast } from "@/stores/toast";
import { requestRun, useTabsStore } from "@/stores/tabs";
// openTab / requestRun 为具名导出（tabs store）
import { useUiStore } from "@/stores/ui";
import { useHotkeyCombo } from "@/stores/hotkeys";
import { useI18n } from "@/lib/i18n";

type Mode = "commands" | "open";

interface OpenEntry {
  id: string;
  kind: "saved" | "table";
  title: string;
  subtitle: string;
  sql: string;
  connectionId: string | null;
  recent?: { database: string; schema: string; table: string };
}

export function CommandPalette(): ReactElement | null {
  const { t } = useI18n();
  const [mode, setMode] = useState<Mode>("commands");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const navigate = useUiStore((state) => state.navigate);
  const setTheme = useUiStore((state) => state.setTheme);
  const theme = useUiStore((state) => state.theme);
  const toggleSidebar = useUiStore((state) => state.toggleSidebar);
  const openRightPanel = useUiStore((state) => state.openRightPanel);
  const openTransfer = useUiStore((state) => state.openTransfer);
  const focusTree = useUiStore((state) => state.focusTree);
  const recentTables = useUiStore((state) => state.recentTables);
  const { data: connections } = useConnections();

  const savedQueriesQuery = useQuery({
    queryKey: ["saved-queries", null],
    queryFn: () => api.listSavedQueries(null),
    enabled: open && mode === "open",
  });

  const paletteCombo = useHotkeyCombo("palette");
  const quickOpenCombo = useHotkeyCombo("quickOpen");
  useGlobalHotkeys(
    useMemo(
      () => ({
        [paletteCombo]: () => {
          setMode("commands");
          setOpen((value) => !value);
        },
        [quickOpenCombo]: () => {
          setMode("open");
          setOpen((value) => !value);
        },
      }),
      [paletteCombo, quickOpenCombo],
    ),
  );

  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
      // 等对话框渲染后聚焦
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open, mode]);

  const actions = useMemo<PaletteAction[]>(() => {
    const firstConnection = connections?.[0]?.id ?? null;
    return [
      {
        id: "goto-connections",
        title: t("打开连接管理"),
        keywords: "connections 连接 管理",
        run: () => navigate({ view: "connections" }),
      },
      {
        id: "goto-workbench",
        title: t("打开 SQL 工作台"),
        keywords: "workbench 工作台 查询",
        run: () => navigate({ view: "workbench" }),
      },
      {
        id: "goto-erd",
        title: t("打开 ER 图"),
        keywords: "erd er 关系图",
        run: () => navigate({ view: "erd" }),
      },
      {
        id: "new-tab",
        title: t("新建查询标签"),
        keywords: "new tab 查询 标签",
        run: () => {
          useTabsStore.getState().openTab({ connectionId: firstConnection });
          navigate({ view: "workbench" });
        },
      },
      {
        id: "toggle-sidebar",
        title: t("折叠 / 展开侧边栏"),
        keywords: "sidebar 侧边栏",
        run: toggleSidebar,
      },
      {
        id: "open-history",
        title: t("打开执行历史"),
        keywords: "history 历史",
        run: () => openRightPanel("history"),
      },
      {
        id: "export",
        title: t("导出当前结果…"),
        keywords: "export 导出 csv",
        run: () => {
          navigate({ view: "workbench" });
          openTransfer("export");
        },
      },
      {
        id: "import",
        title: t("导入 CSV…"),
        keywords: "import 导入 csv",
        run: () => openTransfer("import"),
      },
      {
        id: "theme",
        title: `${t("切换主题（当前：")}${theme === "dark" ? t("深色") : theme === "light" ? t("浅色") : t("跟随系统")}${t("）")}`,
        keywords: "theme 主题 dark light",
        run: () => setTheme(theme === "dark" ? "light" : theme === "light" ? "system" : "dark"),
      },
    ];
  }, [connections, navigate, toggleSidebar, openRightPanel, openTransfer, theme, setTheme, t]);

  const openEntries = useMemo<OpenEntry[]>(() => {
    const saved = (savedQueriesQuery.data ?? []).map((entry) => ({
      id: `saved:${entry.id}`,
      kind: "saved" as const,
      title: entry.name,
      subtitle: entry.sql.split("\n")[0] ?? "",
      sql: entry.sql,
      connectionId: entry.connectionId,
    }));
    const tables = recentTables.map((entry) => ({
      id: `table:${entry.connectionId}:${entry.schema}:${entry.table}`,
      kind: "table" as const,
      title: entry.table,
      subtitle: `${entry.database}/${entry.schema}`,
      sql: "",
      connectionId: entry.connectionId,
      recent: { database: entry.database, schema: entry.schema, table: entry.table },
    }));
    return [...tables, ...saved];
  }, [savedQueriesQuery.data, recentTables]);

  const results = useMemo(() => {
    if (mode === "commands") {
      return matchActions(query, actions).map(({ item }) => ({ key: item.id, action: item, entry: null }));
    }
    return matchActions(
      query,
      openEntries.map((entry) => ({ ...entry, title: entry.title, keywords: `${entry.title} ${entry.subtitle}` })),
    ).map(({ item }) => ({ key: item.id, action: null, entry: item }));
  }, [mode, query, actions, openEntries]);

  useEffect(() => {
    setActiveIndex((previous) => Math.min(previous, Math.max(0, results.length - 1)));
  }, [results.length]);

  const execute = (index: number): void => {
    const result = results[index];
    if (!result) {
      return;
    }
    setOpen(false);
    if (result.action) {
      result.action.run();
      return;
    }
    const entry = result.entry;
    if (!entry) {
      return;
    }
    if (entry.kind === "saved") {
      const connectionId =
        entry.connectionId ?? useTabsStore.getState().tabs.find((tab) => tab.id === useTabsStore.getState().activeId)?.connectionId ?? null;
      useTabsStore.getState().openTab({ connectionId, title: entry.title, sql: entry.sql });
      navigate({ view: "workbench" });
      return;
    }
    // 最近表：定位对象树 + 打开数据
    const recent = entry.recent;
    if (recent && entry.connectionId) {
      focusTree(
        entry.connectionId,
        `objects/${encodeURIComponent(recent.database)}/${encodeURIComponent(recent.schema)}/tables/${encodeURIComponent(recent.table)}`,
      );
      const sql = `SELECT * FROM ${quoteFor(recent.table)} LIMIT 100;`;
      useTabsStore.getState().openTab({ connectionId: entry.connectionId, title: recent.table, sql });
      navigate({ view: "workbench" });
      requestRun(sql);
    } else {
      toast.warning(t("该记录缺少连接上下文"));
    }
  };

  if (!open) {
    return null;
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="top-[18%] w-[560px] translate-y-0 p-0">
        <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
          <Search className="h-4 w-4 shrink-0 text-muted" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActiveIndex((previous) => Math.min(previous + 1, results.length - 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActiveIndex((previous) => Math.max(previous - 1, 0));
              } else if (event.key === "Enter") {
                event.preventDefault();
                execute(activeIndex);
              }
            }}
            placeholder={mode === "commands" ? t("搜索动作…") : t("打开保存的查询 / 最近表…")}
            className="min-w-0 flex-1 bg-transparent text-[14px] text-fg outline-none placeholder:text-muted/70"
            aria-label={mode === "commands" ? t("搜索动作…") : t("打开保存的查询或最近表")}
          />
          <span className="shrink-0 text-[10px] text-muted">{mode === "commands" ? "Ctrl/⌘+K" : "Ctrl/⌘+P"}</span>
        </div>
        <div ref={listRef} className="max-h-80 overflow-y-auto p-1.5" role="listbox">
          {results.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-muted">{t("无匹配项")}</p>
          ) : (
            results.map((result, index) => (
              <button
                key={result.key}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                className={
                  index === activeIndex
                    ? "flex w-full items-center gap-2 rounded-token bg-active/60 px-2.5 py-1.5 text-left"
                    : "flex w-full items-center gap-2 rounded-token px-2.5 py-1.5 text-left hover:bg-hover"
                }
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => execute(index)}
              >
                <span className="min-w-0 flex-1 truncate text-[13px] text-fg">
                  {result.action ? result.action.title : result.entry?.title}
                </span>
                {result.entry && (
                  <span className="max-w-40 shrink-0 truncate text-[11px] text-muted">{result.entry.subtitle}</span>
                )}
                {index === activeIndex && <CornerDownLeft className="h-3 w-3 shrink-0 text-muted" aria-hidden />}
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function quoteFor(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
