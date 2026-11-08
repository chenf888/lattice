import { ArrowDownAZ, ArrowUpAZ, ChevronsDownUp, Eye, EyeOff, Search } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useGlobalHotkeys } from "@/lib/hotkeys";
import { useUiStore } from "@/stores/ui";
import { useHotkeyCombo } from "@/stores/hotkeys";
import { useI18n } from "@/lib/i18n";
import type { TreeNode } from "@/lib/types";
import { useConnections } from "@/features/connections/use-connections";
import { TreeContext, TreeNodeRow, type TreeContextValue } from "./TreeNodeRow";

/** 对象浏览器：搜索过滤（已加载层）、按名称排序、系统对象开关、折叠全部、F5 刷新 */
export function ExplorerTree(): ReactElement {
  const { t } = useI18n();
  const { data: connections } = useConnections();
  const queryClient = useQueryClient();

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [showSystem, setShowSystem] = useState(true);
  const [sortDesc, setSortDesc] = useState(false);
  const [search, setSearch] = useState("");
  const [highlightId, setHighlightId] = useState<string | null>(null);

  // ER 图 / 快速打开 → 定位对象树节点（展开祖先链 + 滚动 + 闪烁）
  const focus = useUiStore((state) => state.focus);
  const clearFocus = useUiStore((state) => state.clearFocus);
  useEffect(() => {
    if (!focus || focus.nodeId === "") {
      return;
    }
    const segments = focus.nodeId.split("/").map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
    // objects/{db}/{schema}/{kind}/{table} → 祖先链
    const ancestors: string[] = [`databases/${focus.connectionId}`];
    if (segments[0] === "objects" && segments.length === 5) {
      const database = segments[1] ?? "";
      const schema = segments[2] ?? "";
      ancestors.push(`db/${database}`);
      ancestors.push(`schemas/${database}/${schema}`);
      ancestors.push(focus.nodeId);
    } else {
      ancestors.push(focus.nodeId);
    }
    setExpanded((previous) => new Set([...previous, ...ancestors]));
    clearFocus();
    setHighlightId(focus.nodeId);
    const scrollTimer = setTimeout(() => {
      const target = document.querySelector(
        '[data-node-id="' + (window.CSS?.escape ? window.CSS.escape(focus.nodeId) : focus.nodeId) + '"]',
      );
      target?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 700);
    const flashTimer = setTimeout(() => setHighlightId(null), 2600);
    return () => {
      clearTimeout(scrollTimer);
      clearTimeout(flashTimer);
    };
  }, [focus, clearFocus]);

  const toggle = useCallback((id: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const collapseAll = useCallback(() => setExpanded(new Set()), []);

  const refresh = useCallback(
    (id: string) => {
      void queryClient.invalidateQueries({ queryKey: ["tree", id] });
    },
    [queryClient],
  );

  const refreshVisible = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["tree"] });
  }, [queryClient]);

  const refreshCombo = useHotkeyCombo("refreshTree");
  useGlobalHotkeys(useMemo(() => ({ [refreshCombo]: refreshVisible }), [refreshCombo, refreshVisible]));

  const roots: TreeNode[] = useMemo(
    () =>
      (connections ?? []).map((connection) => ({
        id: `databases/${connection.id}`,
        label: connection.name,
        nodeKind: "root" as const,
        hasChildren: true,
        isSystem: false,
        meta: connection.connected ? "已连接" : null,
      })),
    [connections],
  );

  const contextValue = useMemo<TreeContextValue>(
    () => ({ expanded, toggle, showSystem, sortDesc, search, refresh, highlightId }),
    [expanded, toggle, showSystem, sortDesc, search, refresh, highlightId],
  );

  return (
    <TreeContext.Provider value={contextValue}>
      <div className="flex h-full flex-col">
        <div className="flex shrink-0 items-center gap-1 px-2 py-1.5">
          <div className="relative min-w-0 flex-1">
            <Search
              className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted"
              aria-hidden
            />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("输入即过滤…")}
              className="h-6 pl-6 text-xs"
              aria-label={t("过滤对象树")}
            />
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                aria-label={showSystem ? t("隐藏系统对象") : t("显示系统对象")}
                onClick={() => setShowSystem((value) => !value)}
              >
                {showSystem ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{showSystem ? t("隐藏系统对象") : t("显示系统对象")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                aria-label={sortDesc ? t("按名称升序") : t("按名称降序")}
                onClick={() => setSortDesc((value) => !value)}
              >
                {sortDesc ? <ArrowDownAZ className="h-3.5 w-3.5" /> : <ArrowUpAZ className="h-3.5 w-3.5" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{sortDesc ? t("按名称升序") : t("按名称降序")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                aria-label={t("折叠全部")}
                onClick={collapseAll}
              >
                <ChevronsDownUp className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("折叠全部")}</TooltipContent>
          </Tooltip>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
          {roots.map((node) => (
            <TreeNodeRow key={node.id} node={node} connId={node.id} depth={0} />
          ))}
          {roots.length === 0 && (
            <p className="px-3 py-4 text-xs text-muted">{t("尚无连接可浏览")}</p>
          )}
        </div>
      </div>
    </TreeContext.Provider>
  );
}
