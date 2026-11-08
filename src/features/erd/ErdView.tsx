/** ER 图视图：连接/库/Schema 选择 → 分层布局 SVG，节点拖拽、平移缩放、框选、导出、树定位 */

import { useQuery } from "@tanstack/react-query";
import { Download, Image as ImageIcon, RotateCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from "react";

import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { api } from "@/lib/ipc";
import type { ErdTable } from "@/lib/types";
import { useConnections } from "@/features/connections/use-connections";
import { useI18n } from "@/lib/i18n";
import { toastError } from "@/stores/toast";
import { useUiStore } from "@/stores/ui";
import { computeLayout, NODE_HEADER_HEIGHT, NODE_ROW_HEIGHT, type ErdLayoutNode } from "./layout";
import { exportPng, exportSvg } from "./erd-export";

interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

interface DragState {
  mode: "node" | "group" | "pan" | "select";
  startX: number;
  startY: number;
  origin: { x: number; y: number };
  targets: string[];
}

export function ErdView(): ReactElement {
  const { t } = useI18n();
  const { data: connections } = useConnections();
  const [connectionId, setConnectionId] = useState<string>("");
  const [database, setDatabase] = useState<string>("");
  const [schema, setSchema] = useState<string>("");
  const svgRef = useRef<SVGSVGElement | null>(null);

  const focus = useUiStore((state) => state.focus);
  const clearFocus = useUiStore((state) => state.clearFocus);
  const focusTree = useUiStore((state) => state.focusTree);

  // 焦点联动（来自 ER 图/其他入口）→ 选中连接与库
  useEffect(() => {
    if (!focus) {
      return;
    }
    setConnectionId(focus.connectionId);
    clearFocus();
  }, [focus, clearFocus]);

  const databasesQuery = useQuery({
    queryKey: ["erd-databases", connectionId],
    queryFn: () => api.browseTree(connectionId, { kind: "databases" }),
    enabled: connectionId !== "",
  });

  const schemasQuery = useQuery({
    queryKey: ["erd-schemas", connectionId, database],
    queryFn: () =>
      api.browseTree(connectionId, { kind: "schemas", database }),
    enabled: connectionId !== "" && database !== "",
  });

  // 默认选择：首个连接 / 首个非系统库 / 首个非系统 schema
  useEffect(() => {
    if (connectionId === "" && connections && connections.length > 0) {
      setConnectionId(connections[0]?.id ?? "");
    }
  }, [connections, connectionId]);

  useEffect(() => {
    const dbs = databasesQuery.data ?? [];
    if (database === "" && dbs.length > 0) {
      const preferred = dbs.find((node) => !node.isSystem) ?? dbs[0];
      setDatabase(preferred?.label ?? "");
    }
  }, [databasesQuery.data, database]);

  useEffect(() => {
    const schemas = schemasQuery.data ?? [];
    if (schema === "" && schemas.length > 0) {
      const preferred = schemas.find((node) => !node.isSystem) ?? schemas[0];
      setSchema(preferred?.label ?? "");
    }
  }, [schemasQuery.data, schema]);

  const effectiveSchema = connectionId !== "" && schema === "" && connections?.find((c) => c.id === connectionId)?.driver === "sqlite" ? "main" : schema;
  const erdQuery = useQuery({
    queryKey: ["erd", connectionId, database, effectiveSchema],
    queryFn: () => api.describeErd(connectionId, database, effectiveSchema),
    enabled: connectionId !== "" && database !== "" && effectiveSchema !== "",
  });

  const tables: ErdTable[] = useMemo(() => erdQuery.data ?? [], [erdQuery.data]);
  const baseLayout = useMemo(() => computeLayout(tables), [tables]);

  // 位置可拖拽覆盖
  const [positions, setPositions] = useState<Map<string, { x: number; y: number }>>(new Map());
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [viewport, setViewport] = useState<Viewport>({ x: 40, y: 40, zoom: 1 });
  const [selectBox, setSelectBox] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const dragRef = useRef<DragState | null>(null);

  // 数据变化时重置位置
  useEffect(() => {
    const next = new Map<string, { x: number; y: number }>();
    for (const [name, node] of baseLayout) {
      next.set(name, { x: node.x, y: node.y });
    }
    setPositions(next);
    setSelected(new Set());
    setViewport({ x: 40, y: 40, zoom: 1 });
  }, [baseLayout]);

  const toCanvas = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } => {
      const rect = svgRef.current?.getBoundingClientRect();
      const offsetX = clientX - (rect?.left ?? 0);
      const offsetY = clientY - (rect?.top ?? 0);
      return {
        x: (offsetX - viewport.x) / viewport.zoom,
        y: (offsetY - viewport.y) / viewport.zoom,
      };
    },
    [viewport],
  );

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<Element>, target: { kind: "background"; shift: boolean } | { kind: "node"; name: string }) => {
      event.preventDefault();
      (event.target as Element).setPointerCapture?.(event.pointerId);
      const point = toCanvas(event.clientX, event.clientY);
      if (target.kind === "background") {
        if (event.shiftKey) {
          dragRef.current = { mode: "select", startX: point.x, startY: point.y, origin: point, targets: [] };
          setSelectBox({ x1: point.x, y1: point.y, x2: point.x, y2: point.y });
        } else {
          dragRef.current = { mode: "pan", startX: event.clientX, startY: event.clientY, origin: { x: viewport.x, y: viewport.y }, targets: [] };
        }
        return;
      }
      const name = target.name;
      const targets = selected.has(name) ? [...selected] : [name];
      if (!selected.has(name)) {
        setSelected(new Set(targets));
      }
      dragRef.current = { mode: selected.has(name) && selected.size > 1 ? "group" : "node", startX: point.x, startY: point.y, origin: { x: 0, y: 0 }, targets };
    },
    [selected, toCanvas, viewport.x, viewport.y],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      const drag = dragRef.current;
      if (!drag) {
        return;
      }
      if (drag.mode === "pan") {
        setViewport((previous) => ({
          ...previous,
          x: drag.origin.x + (event.clientX - drag.startX),
          y: drag.origin.y + (event.clientY - drag.startY),
        }));
        return;
      }
      const point = toCanvas(event.clientX, event.clientY);
      if (drag.mode === "select") {
        setSelectBox((previous) =>
          previous ? { ...previous, x2: point.x, y2: point.y } : previous,
        );
        return;
      }
      const dx = point.x - drag.startX;
      const dy = point.y - drag.startY;
      setPositions((previous) => {
        const next = new Map(previous);
        for (const name of drag.targets) {
          const current = next.get(name);
          if (!current) {
            continue;
          }
          const base = baseLayout.get(name);
          if (!base) {
            continue;
          }
          next.set(name, { x: base.x + dx, y: base.y + dy });
        }
        return next;
      });
    },
    [baseLayout, toCanvas],
  );

  const onPointerUp = useCallback(() => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag?.mode === "select") {
      setSelectBox((box) => {
        if (box) {
          const minX = Math.min(box.x1, box.x2);
          const maxX = Math.max(box.x1, box.x2);
          const minY = Math.min(box.y1, box.y2);
          const maxY = Math.max(box.y1, box.y2);
          const hits = new Set<string>();
          for (const [name, node] of positions) {
            const layout = baseLayout.get(name);
            const width = layout?.width ?? 200;
            const height = layout?.height ?? 80;
            if (node.x < maxX && node.x + width > minX && node.y < maxY && node.y + height > minY) {
              hits.add(name);
            }
          }
          setSelected(hits);
        }
        return null;
      });
    }
  }, [baseLayout, positions]);

  const onWheel = useCallback((event: React.WheelEvent<SVGSVGElement>) => {
    event.preventDefault();
    setViewport((previous) => {
      const zoom = Math.min(2, Math.max(0.5, previous.zoom * (event.deltaY > 0 ? 0.9 : 1.1)));
      return { ...previous, zoom };
    });
  }, []);

  const contentSize = useMemo(() => {
    let maxX = 800;
    let maxY = 600;
    for (const node of positions.values()) {
      maxX = Math.max(maxX, node.x + 240);
      maxY = Math.max(maxY, node.y + 120);
    }
    return { width: maxX, height: maxY };
  }, [positions]);

  const locateInTree = useCallback(
    (table: ErdLayoutNode) => {
      const schemaName = effectiveSchema || "main";
      const kind = "tables";
      focusTree(
        connectionId,
        `objects/${encodeURIComponent(database)}/${encodeURIComponent(schemaName)}/${kind}/${encodeURIComponent(table.table.name)}`,
      );
    },
    [connectionId, database, effectiveSchema, focusTree],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 工具栏 */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-2">
        <span className="text-[13px] font-medium">{t("ER 图")}</span>
        <Select
          aria-label={t("选择连接…").replace("…", "")}
          className="w-40"
          value={connectionId}
          onChange={(event) => {
            setConnectionId(event.target.value);
            setDatabase("");
            setSchema("");
          }}
        >
          <option value="">选择连接…</option>
          {(connections ?? []).map((connection) => (
            <option key={connection.id} value={connection.id}>
              {connection.name}
            </option>
          ))}
        </Select>
        {connections?.find((connection) => connection.id === connectionId)?.driver !== "sqlite" && (
          <>
            <Select
              aria-label={t("选择数据库…").replace("…", "")}
              className="w-40"
              value={database}
              onChange={(event) => {
                setDatabase(event.target.value);
                setSchema("");
              }}
            >
              <option value="">{t("选择数据库…")}</option>
              {(databasesQuery.data ?? []).map((node) => (
                <option key={node.id} value={node.label}>
                  {node.label}
                </option>
              ))}
            </Select>
            <Select
              aria-label={t("选择 Schema…").replace("…", "")}
              className="w-40"
              value={schema}
              onChange={(event) => setSchema(event.target.value)}
            >
              <option value="">{t("选择 Schema…")}</option>
              {(schemasQuery.data ?? []).map((node) => (
                <option key={node.id} value={node.label}>
                  {node.label}
                </option>
              ))}
            </Select>
          </>
        )}
        <span className="flex-1" />
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label={t("重新加载")}
          onClick={() => void erdQuery.refetch()}
        >
          <RotateCw className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 text-xs"
          disabled={tables.length === 0}
          onClick={() => {
            if (svgRef.current) {
              void exportSvg(svgRef.current).catch((error: unknown) => toastError(error, "导出 SVG 失败"));
            }
          }}
        >
          <Download className="h-3.5 w-3.5" aria-hidden />
          SVG
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 text-xs"
          disabled={tables.length === 0}
          onClick={() => {
            if (svgRef.current) {
              void exportPng(svgRef.current, contentSize.width, contentSize.height).catch(
                (error: unknown) => toastError(error, "导出 PNG 失败"),
              );
            }
          }}
        >
          <ImageIcon className="h-3.5 w-3.5" aria-hidden />
          PNG
        </Button>
      </div>

      {/* 画布 */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {erdQuery.isPending ? (
          <div className="grid h-full place-items-center text-xs text-muted">加载中…</div>
        ) : erdQuery.isError ? (
          <button
            type="button"
            className="m-4 rounded-token border border-line p-4 text-xs text-danger hover:bg-hover"
            onClick={() => void erdQuery.refetch()}
          >
            加载失败，点击重试
          </button>
        ) : tables.length === 0 ? (
          <div className="grid h-full place-items-center text-center">
            <div>
              <p className="text-[13px]">{t("当前 Schema 没有表")}</p>
              <p className="mt-1 text-xs text-muted">{t("选择其他连接或 Schema，或在对象树中右键连接「查看 ER 图」")}</p>
            </div>
          </div>
        ) : (
          <svg
            ref={svgRef}
            className="h-full w-full select-none bg-base"
            role="application"
            aria-label="ER 图画布"
            onPointerDown={(event) => {
              if (event.target === svgRef.current || (event.target as Element).getAttribute("data-bg") === "true") {
                onPointerDown(event, { kind: "background", shift: event.shiftKey });
              }
            }}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
            onWheel={onWheel}
          >
            <defs>
              <pattern id="erd-grid" width="24" height="24" patternUnits="userSpaceOnUse">
                <circle cx="1" cy="1" r="1" fill="var(--border)" />
              </pattern>
              <marker id="erd-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                <path d="M0,0 L8,4 L0,8" fill="none" stroke="var(--text-muted)" strokeWidth="1.2" />
              </marker>
            </defs>
            <rect data-bg="true" width="100%" height="100%" fill="url(#erd-grid)" />
            <g transform={`translate(${viewport.x},${viewport.y}) scale(${viewport.zoom})`}>
              {/* 外键连线 */}
              {tables.flatMap((table) => {
                const source = positions.get(table.name);
                if (!source) {
                  return [];
                }
                return table.foreignKeys.map((fk, index) => {
                  const ref = positions.get(fk.refTable);
                  if (!ref) {
                    return null;
                  }
                  const refHeight = baseLayout.get(fk.refTable)?.height ?? 80;
                  const x1 = source.x;
                  const y1 = source.y + NODE_HEADER_HEIGHT + (NODE_ROW_HEIGHT * Math.min(index + 1, table.columns.length)) - NODE_ROW_HEIGHT / 2 + 4;
                  const x2 = ref.x + 200;
                  const y2 = ref.y + refHeight / 2;
                  const hit = selected.has(table.name) || selected.has(fk.refTable);
                  return (
                    <path
                      key={`${table.name}:${fk.column}:${index}`}
                      d={`M ${x1} ${y1} C ${(x1 + x2) / 2} ${y1}, ${(x1 + x2) / 2} ${y2}, ${x2} ${y2}`}
                      fill="none"
                      stroke={hit ? "var(--accent)" : "var(--text-muted)"}
                      strokeWidth={hit ? 1.8 : 1.2}
                      markerEnd="url(#erd-arrow)"
                      opacity={hit ? 1 : 0.6}
                    />
                  );
                });
              })}
              {/* 表节点 */}
              {[...positions.entries()].map(([name, position]) => {
                const layout = baseLayout.get(name);
                if (!layout) {
                  return null;
                }
                const isSelected = selected.has(name);
                return (
                  <g
                    key={name}
                    transform={`translate(${position.x},${position.y})`}
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      onPointerDown(event, { kind: "node", name });
                    }}
                    onDoubleClick={() => locateInTree(layout)}
                    className="cursor-grab"
                  >
                    <rect
                      width={200}
                      height={layout.height}
                      rx="6"
                      fill="var(--bg-elevated)"
                      stroke={isSelected ? "var(--accent)" : "var(--border)"}
                      strokeWidth={isSelected ? 2 : 1}
                    />
                    <rect width={200} height={NODE_HEADER_HEIGHT} rx="6" fill="var(--bg-active)" />
                    <text x="10" y={NODE_HEADER_HEIGHT - 10} fontSize="12" fontWeight="600" fill="var(--text-primary)">
                      {name}
                    </text>
                    {layout.table.columns.map((column, index) => {
                      const isPk = layout.table.primaryKeys.includes(column.name);
                      const isFk = layout.table.foreignKeys.some((fk) => fk.column === column.name);
                      return (
                        <text
                          key={column.name}
                          x="10"
                          y={NODE_HEADER_HEIGHT + NODE_ROW_HEIGHT * index + 14}
                          fontSize="11"
                          fontFamily="var(--app-font-mono)"
                          fill={isPk ? "var(--accent)" : isFk ? "var(--warning)" : "var(--text-muted)"}
                        >
                          {isPk ? "· " : isFk ? "∘ " : "  "}
                          {column.name}
                        </text>
                      );
                    })}
                    <title>双击在对象树中定位</title>
                  </g>
                );
              })}
              {/* 框选矩形 */}
              {selectBox && (
                <rect
                  x={Math.min(selectBox.x1, selectBox.x2)}
                  y={Math.min(selectBox.y1, selectBox.y2)}
                  width={Math.abs(selectBox.x2 - selectBox.x1)}
                  height={Math.abs(selectBox.y2 - selectBox.y1)}
                  fill="color-mix(in srgb, var(--accent) 15%, transparent)"
                  stroke="var(--accent)"
                  strokeWidth="1"
                />
              )}
            </g>
          </svg>
        )}
      </div>
      <div className="flex h-7 shrink-0 items-center gap-3 border-t border-line bg-elevated px-2 text-[11px] text-muted">
        <span>{tables.length} {t("表")}</span>
        <span>{tables.reduce((sum, table) => sum + table.foreignKeys.length, 0)} {t("外键")}</span>
        <span>{t("拖拽移动 · Shift+拖拽框选 · 滚轮缩放 · 双击节点定位对象树")}</span>
      </div>
    </div>
  );
}
