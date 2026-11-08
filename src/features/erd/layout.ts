/** ER 图分层布局（纯函数）：按外键依赖拓扑分层，同层从左到右排布 */

import type { ErdTable } from "@/lib/types";

export interface ErdLayoutNode {
  table: ErdTable;
  x: number;
  y: number;
  width: number;
  height: number;
}

export const NODE_WIDTH = 200;
export const NODE_HEADER_HEIGHT = 30;
export const NODE_ROW_HEIGHT = 20;
export const LAYER_GAP_X = 56;
export const LAYER_GAP_Y = 80;

export function nodeHeight(table: ErdTable): number {
  return NODE_HEADER_HEIGHT + Math.max(table.columns.length, 1) * NODE_ROW_HEIGHT + 8;
}

/**
 * 依赖分层：layer(t) = 1 + max(layer(被引用表))；环上节点回退为按序递增。
 * 返回按层分组（层内保持输入顺序）的表名分组。
 */
export function layerTables(tables: ErdTable[]): string[][] {
  const byName = new Map(tables.map((table) => [table.name, table]));
  const layerCache = new Map<string, number>();

  const computeLayer = (name: string, depth: number): number => {
    const cached = layerCache.get(name);
    if (cached !== undefined) {
      return cached;
    }
    if (depth > tables.length + 1) {
      return 0; // 环：封底
    }
    const table = byName.get(name);
    let layer = 0;
    if (table) {
      for (const fk of table.foreignKeys) {
        if (fk.refTable !== name && byName.has(fk.refTable)) {
          layer = Math.max(layer, computeLayer(fk.refTable, depth + 1) + 1);
        }
      }
    }
    layerCache.set(name, layer);
    return layer;
  };

  const grouped = new Map<number, string[]>();
  for (const table of tables) {
    const layer = computeLayer(table.name, 0);
    const bucket = grouped.get(layer) ?? [];
    bucket.push(table.name);
    grouped.set(layer, bucket);
  }
  return [...grouped.keys()]
    .sort((a, b) => a - b)
    .map((layer) => grouped.get(layer) ?? []);
}

/** 计算每个表的画布坐标（原点 0,0，由视图自行平移） */
export function computeLayout(tables: ErdTable[]): Map<string, ErdLayoutNode> {
  const byName = new Map(tables.map((table) => [table.name, table]));
  const layers = layerTables(tables);
  const layout = new Map<string, ErdLayoutNode>();
  let y = 0;
  for (const layer of layers) {
    let x = 0;
    let maxLayerHeight = 0;
    for (const name of layer) {
      const table = byName.get(name);
      if (!table) {
        continue;
      }
      const height = nodeHeight(table);
      layout.set(name, { table, x, y, width: NODE_WIDTH, height });
      x += NODE_WIDTH + LAYER_GAP_X;
      maxLayerHeight = Math.max(maxLayerHeight, height);
    }
    y += maxLayerHeight + LAYER_GAP_Y;
  }
  return layout;
}
