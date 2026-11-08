import {
  ChevronDown,
  ChevronRight,
  Database,
  Folder,
  Hash,
  Pencil,
  RotateCw,
  Table,
  FunctionSquare,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { createContext, useContext, useMemo, type ReactElement } from "react";

import { useUiStore } from "@/stores/ui";
import { useI18n } from "@/lib/i18n";
import { requestRun, useTabsStore } from "@/stores/tabs";
import type { DriverKind } from "@/lib/types";
import { parseLeafObjectId, quoteIdent } from "./tree-utils";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { api } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import type { TreeNode } from "@/lib/types";
import { toast, toastError } from "@/stores/toast";
import { useConnections, useDisconnectConnection } from "@/features/connections/use-connections";
import { parseNodeId, schemaGroupNodes, splitHighlight } from "./tree-utils";

export interface TreeContextValue {
  expanded: ReadonlySet<string>;
  toggle: (id: string) => void;
  showSystem: boolean;
  sortDesc: boolean;
  search: string;
  refresh: (id: string) => void;
  /** 定位高亮（ER 图 / 快速打开联动） */
  highlightId: string | null;
}

export const TreeContext = createContext<TreeContextValue | null>(null);

function useTreeContext(): TreeContextValue {
  const value = useContext(TreeContext);
  if (!value) {
    throw new Error("TreeContext 缺失：TreeNodeRow 必须渲染在 ExplorerTree 内");
  }
  return value;
}

const KIND_ICON: Record<string, ReactElement> = {
  root: <Database className="h-3.5 w-3.5 text-accent" aria-hidden />,
  database: <Database className="h-3.5 w-3.5 text-muted" aria-hidden />,
  schema: <Folder className="h-3.5 w-3.5 text-muted" aria-hidden />,
  group: <Folder className="h-3.5 w-3.5 text-muted" aria-hidden />,
  table: <Table className="h-3.5 w-3.5 text-muted" aria-hidden />,
  view: <Table className="h-3.5 w-3.5 text-muted/80" aria-hidden />,
  function: <FunctionSquare className="h-3.5 w-3.5 text-muted" aria-hidden />,
  sequence: <Hash className="h-3.5 w-3.5 text-muted" aria-hidden />,
};

function HighlightLabel({ label, query }: { label: string; query: string }): ReactElement {
  return (
    <span className="min-w-0 truncate">
      {splitHighlight(label, query).map((part, index) =>
        part.hit ? (
          <mark key={index} className="rounded-sm bg-warning/30 px-0.5 text-fg">
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </span>
  );
}

function copyName(label: string, successText: string, failText: string): void {
  navigator.clipboard
    .writeText(label)
    .then(() => toast.success(successText))
    .catch((error: unknown) => toastError(error, failText));
}

export function TreeNodeRow({
  node,
  connId,
  depth,
}: {
  node: TreeNode;
  connId: string;
  depth: number;
}): ReactElement {
  const tree = useTreeContext();
  const disconnectMutation = useDisconnectConnection();
  const isExpanded = tree.expanded.has(node.id);
  const connections = useConnections();
  const openTab = useTabsStore((state) => state.openTab);
  const navigate = useUiStore((state) => state.navigate);
  const pushRecentTable = useUiStore((state) => state.pushRecentTable);
  const { t } = useI18n();

  /** 表/视图：打开数据（SELECT * LIMIT 100 并执行）/ 生成 SELECT */
  const leaf = parseLeafObjectId(node.id);
  const driver: DriverKind | null =
    connections.data?.find((connection) => connection.id === connId)?.driver ?? null;
  const tableRef = leaf
    ? [
        leaf.schema !== "" && driver !== "sqlite" && driver !== "mysql"
          ? quoteIdent(leaf.schema, driver)
          : null,
        quoteIdent(leaf.table, driver),
      ]
        .filter((part) => part !== null)
        .join(".")
    : null;

  const openAsQuery = (withLimit: boolean): void => {
    if (!tableRef || !leaf) {
      return;
    }
    const sql = withLimit ? `SELECT * FROM ${tableRef} LIMIT 100;` : `SELECT * FROM ${tableRef};`;
    openTab({ connectionId: connId, title: leaf.table, sql });
    navigate({ view: "workbench" });
    const driver = connections.data?.find((connection) => connection.id === connId)?.driver;
    if (driver && driver !== "sqlite") {
      pushRecentTable({
        connectionId: connId,
        database: leaf.database,
        schema: leaf.schema,
        table: leaf.table,
      });
    } else if (driver === "sqlite") {
      pushRecentTable({
        connectionId: connId,
        database: "main",
        schema: "main",
        table: leaf.table,
      });
    }
    if (withLimit) {
      requestRun(sql);
    }
  };

  // schema 节点的子级为前端构造的四类容器，不走服务端
  const serverPath = node.nodeKind === "schema" ? null : parseNodeId(node.id);
  const childrenQuery = useQuery({
    queryKey: ["tree", node.id],
    queryFn: () => {
      const path = serverPath;
      if (!path) {
        return Promise.resolve([] as TreeNode[]);
      }
      return api.browseTree(connId, path);
    },
    enabled: isExpanded && node.hasChildren && serverPath !== null,
    staleTime: 60_000,
  });

  const children: TreeNode[] = useMemo(() => {
    if (node.nodeKind === "schema") {
      return schemaGroupNodes(node.id);
    }
    let list = childrenQuery.data ?? [];
    if (!tree.showSystem) {
      list = list.filter((child) => !child.isSystem);
    }
    const query = tree.search.trim().toLowerCase();
    if (query) {
      list = list.filter((child) => child.label.toLowerCase().includes(query));
    }
    if (tree.sortDesc) {
      list = [...list].reverse();
    }
    return list;
  }, [node.nodeKind, node.id, childrenQuery.data, tree.showSystem, tree.search, tree.sortDesc]);

  const loading = isExpanded && node.hasChildren && serverPath !== null && childrenQuery.isPending;
  const failed = isExpanded && node.hasChildren && serverPath !== null && childrenQuery.isError;

  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            data-node-id={node.id}
            className={cn(
              "flex w-full items-center gap-1.5 rounded-token py-[3px] pr-2 text-left text-[13px] text-fg",
              "hover:bg-hover focus-visible:bg-hover",
              isExpanded && "bg-active/40",
              tree.highlightId === node.id && "ring-2 ring-accent",
            )}
            style={{ paddingLeft: depth * 14 + 6 }}
            aria-expanded={node.hasChildren ? isExpanded : undefined}
            onClick={() => {
              if (node.hasChildren) {
                tree.toggle(node.id);
              }
            }}
          >
            {node.hasChildren ? (
              isExpanded ? (
                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
              )
            ) : (
              <span className="w-3.5 shrink-0" aria-hidden />
            )}
            {KIND_ICON[node.nodeKind] ?? <Pencil className="h-3.5 w-3.5" aria-hidden />}
            <HighlightLabel label={node.label} query={tree.search} />
            {node.meta && (
              <span className="ml-auto min-w-0 truncate text-[11px] text-muted">{node.meta}</span>
            )}
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {leaf !== null && (
            <>
              <ContextMenuItem onSelect={() => openAsQuery(true)}>{t("打开数据")}</ContextMenuItem>
              <ContextMenuItem onSelect={() => openAsQuery(false)}>{t("生成 SELECT")}</ContextMenuItem>
              <ContextMenuSeparator />
            </>
          )}
          <ContextMenuItem onSelect={() => copyName(node.label, t("已复制名称"), t("复制失败"))}>复制名称</ContextMenuItem>
          {node.hasChildren && (
            <ContextMenuItem onSelect={() => tree.refresh(node.id)}>{t("刷新")}</ContextMenuItem>
          )}
          {node.nodeKind === "root" && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                onSelect={() => {
                  navigate({ view: "erd" });
                  // ER 图选择器默认聚焦该连接
                  useUiStore.getState().focusTree(connId, "");
                }}
              >
                {t("查看 ER 图")}
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => disconnectMutation.mutate(connId)}>
                {t("断开连接")}
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>

      {isExpanded && node.hasChildren && (
        <div role="group">
          {loading ? (
            <div className="grid gap-1 py-1" style={{ paddingLeft: (depth + 1) * 14 + 26 }}>
              {[0, 1, 2].map((index) => (
                <div key={index} className="h-4 animate-pulse rounded bg-hover" />
              ))}
            </div>
          ) : failed ? (
            <button
              type="button"
              className="flex items-center gap-1.5 rounded-token py-1 text-xs text-danger hover:bg-hover"
              style={{ paddingLeft: (depth + 1) * 14 + 26 }}
              onClick={() => void childrenQuery.refetch()}
            >
              <RotateCw className="h-3 w-3" aria-hidden />
              {t("加载失败，点击重试")}
            </button>
          ) : (
            children.map((child) => (
              <TreeNodeRow key={child.id} node={child} connId={connId} depth={depth + 1} />
            ))
          )}
        </div>
      )}
    </div>
  );
}
