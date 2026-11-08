/**
 * 查询执行事件订阅：Rust 后台任务经 Tauri event 分批推送行与状态。
 * 事件名与载荷与 src-tauri/src/commands/query.rs 镜像。
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { Cell, ColumnMeta } from "./types";

export interface QueryStartedPayload {
  queryId: string;
  statementCount: number;
}

export interface QueryColumnsPayload {
  queryId: string;
  statementIndex: number;
  columns: ColumnMeta[];
}

export interface QueryRowsPayload {
  queryId: string;
  statementIndex: number;
  rows: Cell[][];
  batchIndex: number;
}

export interface QueryStatementPayload {
  queryId: string;
  statementIndex: number;
  status: "ok" | "error" | "cancelled";
  rows: number;
  rowsAffected: number;
  truncated: boolean;
  durationMs: number;
  error: string | null;
}

export interface QueryDonePayload {
  queryId: string;
  status: "completed" | "cancelled" | "error";
  error: string | null;
  durationMs: number;
}

export interface QueryEventHandlers {
  onStarted?: (payload: QueryStartedPayload) => void;
  onColumns?: (payload: QueryColumnsPayload) => void;
  onRows?: (payload: QueryRowsPayload) => void;
  onStatement?: (payload: QueryStatementPayload) => void;
  onDone?: (payload: QueryDonePayload) => void;
}

/** 订阅全部查询事件；返回取消订阅函数 */
export async function subscribeQueryEvents(
  handlers: QueryEventHandlers,
): Promise<() => void> {
  const wrapped = <P>(handler: ((payload: P) => void) | undefined) => {
    return (event: { payload: unknown }): void => {
      handler?.(event.payload as P);
    };
  };
  const unlisteners: UnlistenFn[] = await Promise.all([
    listen("query:started", wrapped(handlers.onStarted)),
    listen("query:columns", wrapped(handlers.onColumns)),
    listen("query:rows", wrapped(handlers.onRows)),
    listen("query:statement", wrapped(handlers.onStatement)),
    listen("query:done", wrapped(handlers.onDone)),
  ]);
  return () => {
    for (const unlisten of unlisteners) {
      unlisten();
    }
  };
}
