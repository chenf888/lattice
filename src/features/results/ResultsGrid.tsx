/** 虚拟化结果网格：TanStack Table（列模型/排序语义）+ TanStack Virtual（行虚拟化） */

import {
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, ArrowUpDown, EyeOff, Pin, PinOff } from "lucide-react";
import { useCallback, useMemo, useRef, useState, type ReactElement } from "react";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/ipc";
import type { Cell, ColumnMeta } from "@/lib/types";
import { toast, toastError } from "@/stores/toast";
import {
  cellToDisplay,
  inferNumericColumn,
  makeRowComparator,
} from "./grid-utils";

const DEFAULT_WIDTH = 160;
const MIN_WIDTH = 60;
const MAX_WIDTH = 560;
const ROW_HEIGHT = 28;
const CHAR_WIDTH = 7.2;

export interface ResultsGridProps {
  columns: ColumnMeta[];
  /** 已经过筛选的行（筛选条在 ResultsView） */
  rows: Cell[][];
  onFilterByValue: (col: number, value: string) => void;
}

interface SortState {
  col: number;
  dir: "asc" | "desc";
}

export function ResultsGrid({ columns, rows, onFilterByValue }: ResultsGridProps): ReactElement {
  const [sort, setSort] = useState<SortState | null>(null);
  const [hidden, setHidden] = useState<ReadonlySet<number>>(new Set());
  const [pinned, setPinned] = useState<ReadonlySet<number>>(new Set());
  const [widths, setWidths] = useState<number[]>(() => columns.map(() => DEFAULT_WIDTH));
  const [detail, setDetail] = useState<{ title: string; text: string } | null>(null);
  const [insertDraft, setInsertDraft] = useState<{ rows: Cell[][]; columns: string[]; table: string } | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const dragState = useRef<{ col: number; startX: number; startWidth: number } | null>(null);

  const numeric = useMemo(() => {
    const flags = columns.map((_, index) => inferNumericColumn(rows, index));
    return flags;
  }, [columns, rows]);

  const sortedRows = useMemo(() => {
    if (!sort) {
      return rows;
    }
    return [...rows].sort(makeRowComparator(sort.col, sort.dir, numeric[sort.col] ?? false));
  }, [rows, sort, numeric]);

  // TanStack Table：列模型与表头语义（数据行虚拟渲染走 virtualizer）
  const columnDefs = useMemo<ColumnDef<Cell[], unknown>[]>(
    () =>
      columns
        .map((column, index) => ({ column, index }))
        .filter(({ index }) => !hidden.has(index))
        .map(({ column, index }) => ({
          id: `c${index}`,
          header: column.name,
          accessorFn: (row: Cell[]) => row[index],
          size: widths[index] ?? DEFAULT_WIDTH,
          meta: { index, pinned: pinned.has(index) },
        })),
    [columns, hidden, widths, pinned],
  );

  const table = useReactTable({
    data: sortedRows,
    columns: columnDefs,
    getCoreRowModel: getCoreRowModel(),
  });

  const virtualizer = useVirtualizer({
    count: sortedRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 14,
  });

  const visibleColumns = useMemo(
    () => columns.map((column, index) => ({ column, index })).filter(({ index }) => !hidden.has(index)),
    [columns, hidden],
  );

  /** 固定列的 sticky 左偏移（按可见顺序累计） */
  const pinnedOffsets = useMemo(() => {
    const offsets = new Map<number, number>();
    let offset = 0;
    for (const { index } of visibleColumns) {
      if (pinned.has(index)) {
        offsets.set(index, offset);
        offset += widths[index] ?? DEFAULT_WIDTH;
      }
    }
    return offsets;
  }, [visibleColumns, pinned, widths]);

  const toggleSort = useCallback((col: number) => {
    setSort((current) => {
      if (!current || current.col !== col) {
        return { col, dir: "asc" };
      }
      if (current.dir === "asc") {
        return { col, dir: "desc" };
      }
      return null;
    });
  }, []);

  const onResizeStart = useCallback(
    (col: number, clientX: number) => {
      dragState.current = { col, startX: clientX, startWidth: widths[col] ?? DEFAULT_WIDTH };
      const onMove = (event: PointerEvent) => {
        const drag = dragState.current;
        if (!drag) {
          return;
        }
        const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, drag.startWidth + event.clientX - drag.startX));
        setWidths((previous) => {
          const copy = [...previous];
          copy[drag.col] = next;
          return copy;
        });
      };
      const onUp = () => {
        dragState.current = null;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [widths],
  );

  const autoFit = useCallback(
    (col: number) => {
      let maxLen = 0;
      const sample = Math.min(rows.length, 500);
      for (let i = 0; i < sample; i += 1) {
        const display = cellToDisplay(rows[i]?.[col]);
        if (display) {
          maxLen = Math.max(maxLen, display.length);
        }
      }
      const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.ceil(maxLen * CHAR_WIDTH) + 28));
      setWidths((previous) => {
        const copy = [...previous];
        copy[col] = width;
        return copy;
      });
    },
    [rows],
  );

  const copyToClipboard = useCallback(async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(label);
    } catch (error) {
      toastError(error, "复制失败");
    }
  }, []);

  const copyAs = useCallback(
    async (format: "csv" | "json" | "insert", subset: Cell[][], cols: ColumnMeta[]) => {
      if (format === "insert") {
        setInsertDraft({ rows: subset, columns: cols.map((column) => column.name), table: "" });
        return;
      }
      try {
        const { text } = await api.formatRows({
          rows: subset,
          columns: cols.map((column) => column.name),
          format,
          table: null,
        });
        await navigator.clipboard.writeText(text);
        toast.success(`已复制为 ${format.toUpperCase()}`);
      } catch (error) {
        toastError(error, "复制失败");
      }
    },
    [],
  );

  const confirmInsertCopy = useCallback(async () => {
    if (!insertDraft) {
      return;
    }
    try {
      const { text } = await api.formatRows({
        rows: insertDraft.rows,
        columns: insertDraft.columns,
        format: "insert",
        table: insertDraft.table,
      });
      await navigator.clipboard.writeText(text);
      toast.success("已复制为 INSERT");
      setInsertDraft(null);
    } catch (error) {
      toastError(error, "复制失败");
    }
  }, [insertDraft]);

  const rowPinnedOffset = pinnedOffsets.size > 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        {/* 表头 */}
        <div
          className="sticky top-0 z-10 flex w-max border-b border-line bg-elevated"
          style={{ minWidth: "100%" }}
          role="row"
        >
          {table.getHeaderGroups()[0]?.headers.map((header) => {
            const meta = header.column.columnDef.meta as { index: number; pinned: boolean } | undefined;
            const index = meta?.index ?? 0;
            const width = widths[index] ?? DEFAULT_WIDTH;
            const isSorted = sort?.col === index;
            return (
              <ContextMenu key={header.id}>
                <ContextMenuTrigger asChild>
                  <div
                    className="group relative flex shrink-0 select-none items-center gap-1 border-r border-line px-2 text-[12px] font-medium text-fg hover:bg-hover"
                    style={{
                      width,
                      position: meta?.pinned ? "sticky" : undefined,
                      left: meta?.pinned ? (pinnedOffsets.get(index) ?? 0) : undefined,
                      zIndex: meta?.pinned ? 11 : undefined,
                    }}
                    role="columnheader"
                    aria-sort={isSorted ? (sort?.dir === "asc" ? "ascending" : "descending") : "none"}
                    onClick={() => toggleSort(index)}
                  >
                    <span className="min-w-0 truncate">{header.column.columnDef.header as string}</span>
                    {isSorted ? (
                      sort?.dir === "asc" ? (
                        <ArrowUp className="h-3 w-3 shrink-0 text-accent" aria-hidden />
                      ) : (
                        <ArrowDown className="h-3 w-3 shrink-0 text-accent" aria-hidden />
                      )
                    ) : (
                      <ArrowUpDown className="h-3 w-3 shrink-0 text-muted opacity-0 group-hover:opacity-100" aria-hidden />
                    )}
                    {meta?.pinned && <Pin className="h-3 w-3 shrink-0 text-accent" aria-hidden />}
                    {/* 拖拽调宽把手 */}
                    <span
                      className="absolute inset-y-0 right-0 w-1.5 cursor-col-resize hover:bg-accent/40"
                      onPointerDown={(event) => {
                        event.stopPropagation();
                        onResizeStart(index, event.clientX);
                      }}
                      onDoubleClick={(event) => {
                        event.stopPropagation();
                        autoFit(index);
                      }}
                      aria-hidden
                    />
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem onSelect={() => autoFit(index)}>自适应宽度</ContextMenuItem>
                  <ContextMenuItem
                    onSelect={() => {
                      setPinned((previous) => {
                        const next = new Set(previous);
                        if (next.has(index)) {
                          next.delete(index);
                        } else {
                          next.add(index);
                        }
                        return next;
                      });
                    }}
                  >
                    {pinned.has(index) ? (
                      <>
                        <PinOff className="h-3.5 w-3.5" aria-hidden /> 取消固定
                      </>
                    ) : (
                      <>
                        <Pin className="h-3.5 w-3.5" aria-hidden /> 固定列
                      </>
                    )}
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem onSelect={() => void copyToClipboard(columns[index]?.name ?? "", "已复制列名")}>
                    复制列名
                  </ContextMenuItem>
                  <ContextMenuItem
                    onSelect={() => {
                      setHidden((previous) => {
                        const next = new Set(previous);
                        next.add(index);
                        return next;
                      });
                    }}
                  >
                    <EyeOff className="h-3.5 w-3.5" aria-hidden /> 隐藏列
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            );
          })}
        </div>

        {/* 虚拟行 */}
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {hidden.size < columns.length ? (
            virtualizer.getVirtualItems().map((virtualRow) => {
              const rowIndex = virtualRow.index;
              const row = sortedRows[rowIndex];
              if (!row) {
                return null;
              }
              return (
                <div
                  key={virtualRow.key}
                  className="absolute inset-x-0 flex border-b border-line/60 hover:bg-hover/40"
                  style={{
                    height: virtualRow.size,
                    transform: `translateY(${virtualRow.start}px)`,
                    minWidth: "100%",
                    width: "max-content",
                  }}
                  role="row"
                >
                  {visibleColumns.map(({ column, index }) => {
                    const display = cellToDisplay(row[index]);
                    const isPinned = pinned.has(index);
                    const width = widths[index] ?? DEFAULT_WIDTH;
                    return (
                      <ContextMenu key={`${rowIndex}:${index}`}>
                        <ContextMenuTrigger asChild>
                          <div
                            className="flex shrink-0 items-center overflow-hidden border-r border-line/40 px-2 font-mono text-[12.5px] text-fg"
                            style={{
                              width,
                              height: ROW_HEIGHT,
                              position: isPinned ? "sticky" : undefined,
                              left: isPinned ? (pinnedOffsets.get(index) ?? 0) : undefined,
                              backgroundColor: isPinned ? "var(--bg-elevated)" : undefined,
                              zIndex: isPinned ? 1 : undefined,
                            }}
                            role="gridcell"
                            onClick={() => {
                              if (display !== null && display.length > 60) {
                                setDetail({ title: `${column.name}（第 ${rowIndex + 1} 行）`, text: display });
                              }
                            }}
                          >
                            {display === null ? (
                              <span className="truncate italic text-muted/70" title="NULL">
                                NULL
                              </span>
                            ) : (
                              <span
                                className="cursor-pointer truncate"
                                title={display.length > 60 ? "点击查看详情" : undefined}
                              >
                                {display}
                              </span>
                            )}
                          </div>
                        </ContextMenuTrigger>
                        <ContextMenuContent>
                          <ContextMenuItem
                            onSelect={() => void copyToClipboard(display ?? "", "已复制单元格")}
                          >
                            复制单元格
                          </ContextMenuItem>
                          <ContextMenuItem
                            onSelect={() =>
                              void copyToClipboard(
                                row.map((cell) => cellToDisplay(cell) ?? "").join("\t"),
                                "已复制行",
                              )
                            }
                          >
                            复制行
                          </ContextMenuItem>
                          <ContextMenuSeparator />
                          <ContextMenuItem onSelect={() => void copyAs("csv", [row], columns)}>
                            复制为 CSV
                          </ContextMenuItem>
                          <ContextMenuItem onSelect={() => void copyAs("json", [row], columns)}>
                            复制为 JSON
                          </ContextMenuItem>
                          <ContextMenuItem onSelect={() => void copyAs("insert", [row], columns)}>
                            复制为 INSERT…
                          </ContextMenuItem>
                          <ContextMenuSeparator />
                          {display !== null && (
                            <ContextMenuItem onSelect={() => onFilterByValue(index, display)}>
                              筛选该值（=）
                            </ContextMenuItem>
                          )}
                        </ContextMenuContent>
                      </ContextMenu>
                    );
                  })}
                </div>
              );
            })
          ) : (
            <div className="p-4 text-xs text-muted">所有列已隐藏——在列头右键恢复</div>
          )}
        </div>
      </div>

      {/* 长文本详情 */}
      <Dialog open={detail !== null} onOpenChange={(open) => !open && setDetail(null)}>
        {detail && (
          <DialogContent className="w-[640px]">
            <DialogTitle>{detail.title}</DialogTitle>
            <pre className="mt-3 max-h-[50vh] overflow-auto whitespace-pre-wrap break-all rounded-token border border-line bg-base p-3 font-mono text-[12.5px] text-fg">
              {detail.text}
            </pre>
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-token border border-line px-3 py-1 text-xs hover:bg-hover"
                onClick={() => void copyToClipboard(detail.text, "已复制")}
              >
                复制
              </button>
              <button
                type="button"
                className="rounded-token bg-accent px-3 py-1 text-xs text-accent-fg hover:bg-accent-hover"
                onClick={() => setDetail(null)}
              >
                关闭
              </button>
            </div>
          </DialogContent>
        )}
      </Dialog>

      {/* INSERT 复制需表名 */}
      <Dialog open={insertDraft !== null} onOpenChange={(open) => !open && setInsertDraft(null)}>
        {insertDraft && (
          <DialogContent className="w-[420px]">
            <DialogTitle>复制为 INSERT 语句</DialogTitle>
            <p className="mt-1 text-xs text-muted">指定目标表名，列名取自结果集列头。</p>
            <Input
              autoFocus
              value={insertDraft.table}
              placeholder="表名，如 users"
              onChange={(event) =>
                setInsertDraft((draft) => (draft ? { ...draft, table: event.target.value } : draft))
              }
              className="mt-3"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-token border border-line px-3 py-1 text-xs hover:bg-hover"
                onClick={() => setInsertDraft(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="rounded-token bg-accent px-3 py-1 text-xs text-accent-fg hover:bg-accent-hover disabled:opacity-50"
                disabled={!insertDraft.table.trim()}
                onClick={() => void confirmInsertCopy()}
              >
                复制
              </button>
            </div>
          </DialogContent>
        )}
      </Dialog>

      {/* 供无障碍/测试的行数锚点 */}
      <span className="sr-only" aria-live="polite">
        {rowPinnedOffset ? "存在固定列。" : ""}
        共 {sortedRows.length} 行
      </span>
    </div>
  );
}
