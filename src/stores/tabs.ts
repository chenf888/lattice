import { create } from "zustand";

import { api } from "@/lib/ipc";
import type { ExecutionState, TabRecord } from "@/lib/types";

/** 编辑器标签；dirty = sql 与上次保存内容不一致 */
export interface EditorTab {
  id: string;
  connectionId: string | null;
  /** 执行目标库（树节点跨库打开时携带）；null = 连接默认库 */
  database: string | null;
  title: string;
  sql: string;
  /** 上次「保存查询」的内容；null = 尚未保存过 */
  savedSql: string | null;
  scrollTop: number;
  cursorFrom: number;
  cursorTo: number;
  execution: ExecutionState | null;
}

export function isTabDirty(tab: EditorTab): boolean {
  return tab.sql !== (tab.savedSql ?? "");
}

export interface OpenTabInput {
  connectionId?: string | null;
  database?: string | null;
  title?: string;
  sql?: string;
}

interface TabsState {
  tabs: EditorTab[];
  activeId: string | null;
  /** 标签会话已从 app.db 恢复（恢复前不触发持久化订阅） */
  restored: boolean;

  openTab: (input: OpenTabInput) => string;
  closeTab: (id: string) => void;
  reorder: (from: number, to: number) => void;
  setActive: (id: string) => void;
  updateSql: (id: string, sql: string) => void;
  patchTab: (id: string, patch: Partial<Omit<EditorTab, "id">>) => void;
  markSaved: (id: string, name: string, sql: string) => void;
  setExecution: (id: string, execution: ExecutionState | null) => void;
  /** 事件应用：columns / rows / statement / done（按 queryId 定位标签） */
  applyColumns: (queryId: string, statementIndex: number, columns: ExecutionState["statements"][number]["columns"]) => void;
  appendRows: (queryId: string, statementIndex: number, rows: ExecutionState["statements"][number]["rows"]) => void;
  finishStatement: (
    queryId: string,
    statementIndex: number,
    result: {
      status: "ok" | "error" | "cancelled";
      rows: number;
      rowsAffected: number;
      truncated: boolean;
      durationMs: number;
      error: string | null;
    },
  ) => void;
  finishExecution: (
    queryId: string,
    status: ExecutionState["status"],
    error: string | null,
    durationMs: number,
  ) => void;
  restore: (records: TabRecord[]) => void;
}

/** 离线 id：与 Rust new_id 语义一致（纳秒 + 计数），仅前端本地唯一性使用 */
let tabCounter = 0;
function newTabId(): string {
  tabCounter += 1;
  return `tab_${Date.now().toString(36)}_${tabCounter.toString(36)}`;
}

export function makeStatementList(count: number): ExecutionState["statements"] {
  return Array.from({ length: count }, (_, index) => ({
    index,
    status: index === 0 ? ("running" as const) : ("pending" as const),
    columns: [],
    rows: [],
    rowsAffected: null,
    truncated: false,
    durationMs: null,
    error: null,
  }));
}

export const useTabsStore = create<TabsState>()((set, get) => {
  /** 按 queryId 找到持有该执行的标签；仅在执行处于 running 时应用 */
  function mutateExecution(
    queryId: string,
    mutate: (execution: ExecutionState) => ExecutionState,
  ): void {
    set((state) => {
      let changed = false;
      const tabs = state.tabs.map((tab) => {
        const execution = tab.execution;
        if (!execution || execution.queryId !== queryId || execution.status !== "running") {
          return tab;
        }
        changed = true;
        return { ...tab, execution: mutate(execution) };
      });
      return changed ? { tabs } : state;
    });
  }

  return {
    tabs: [],
    activeId: null,
    restored: false,

    openTab: (input) => {
      const id = newTabId();
      const tab: EditorTab = {
        id,
        connectionId: input.connectionId ?? null,
        database: input.database ?? null,
        title: input.title ?? `查询 ${get().tabs.length + 1}`,
        sql: input.sql ?? "",
        savedSql: null,
        scrollTop: 0,
        cursorFrom: 0,
        cursorTo: 0,
        execution: null,
      };
      set((state) => ({ tabs: [...state.tabs, tab], activeId: id }));
      return id;
    },

    closeTab: (id) => {
      set((state) => {
        const index = state.tabs.findIndex((tab) => tab.id === id);
        if (index < 0) {
          return state;
        }
        const tabs = state.tabs.filter((tab) => tab.id !== id);
        let activeId = state.activeId;
        if (activeId === id) {
          const next = tabs[index] ?? tabs[index - 1];
          activeId = next?.id ?? null;
        }
        return { tabs, activeId };
      });
    },

    reorder: (from, to) => {
      set((state) => {
        if (from === to || from < 0 || to < 0 || from >= state.tabs.length || to >= state.tabs.length) {
          return state;
        }
        const tabs = [...state.tabs];
        const [moved] = tabs.splice(from, 1);
        if (!moved) {
          return state;
        }
        tabs.splice(to, 0, moved);
        return { tabs };
      });
    },

    setActive: (id) => set({ activeId: id }),

    updateSql: (id, sql) => {
      set((state) => ({
        tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, sql } : tab)),
      }));
    },

    patchTab: (id, patch) => {
      set((state) => ({
        tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab)),
      }));
    },

    markSaved: (id, name, sql) => {
      get().patchTab(id, { title: name, sql, savedSql: sql });
    },

    setExecution: (id, execution) => {
      get().patchTab(id, { execution });
    },

    applyColumns: (queryId, statementIndex, columns) => {
      mutateExecution(queryId, (execution) => ({
        ...execution,
        activeIndex: statementIndex,
        statements: execution.statements.map((statement) =>
          statement.index === statementIndex
            ? { ...statement, columns, status: "running" }
            : statement,
        ),
      }));
    },

    appendRows: (queryId, statementIndex, rows) => {
      mutateExecution(queryId, (execution) => ({
        ...execution,
        statements: execution.statements.map((statement) =>
          statement.index === statementIndex
            ? { ...statement, rows: [...statement.rows, ...rows] }
            : statement,
        ),
      }));
    },

    finishStatement: (queryId, statementIndex, result) => {
      mutateExecution(queryId, (execution) => ({
        ...execution,
        statements: execution.statements.map((statement) =>
          statement.index === statementIndex
            ? {
                ...statement,
                status: result.status,
                rowsAffected: result.rowsAffected,
                truncated: result.truncated,
                durationMs: result.durationMs,
                error: result.error,
              }
            : statement,
        ),
      }));
    },

    finishExecution: (queryId, status, error, durationMs) => {
      mutateExecution(queryId, (execution) => ({
        ...execution,
        status,
        error,
        durationMs,
      }));
    },

    restore: (records) => {
      const tabs: EditorTab[] = records.map((record) => ({
        id: record.id,
        connectionId: record.connectionId,
        database: null,
        title: record.title ?? "查询",
        sql: record.sql ?? "",
        savedSql: null,
        scrollTop: record.scrollTop ?? 0,
        cursorFrom: record.cursorFrom ?? 0,
        cursorTo: record.cursorTo ?? 0,
        execution: null,
      }));
      set({
        tabs,
        activeId: tabs[tabs.length - 1]?.id ?? null,
        restored: true,
      });
    },
  };
});

/** 挂载一次性持久化订阅：标签变化防抖 300ms 全量快照写入 app.db */
let persistTimer: ReturnType<typeof setTimeout> | undefined;
export function attachTabsPersistence(): () => void {
  const unsubscribe = useTabsStore.subscribe((state) => {
    if (!state.restored) {
      return;
    }
    if (persistTimer !== undefined) {
      clearTimeout(persistTimer);
    }
    persistTimer = setTimeout(() => {
      const records: TabRecord[] = useTabsStore
        .getState()
        .tabs.map((tab) => ({
          id: tab.id,
          connectionId: tab.connectionId,
          title: tab.title,
          sql: tab.sql,
          scrollTop: Math.round(tab.scrollTop),
          cursorFrom: Math.round(tab.cursorFrom),
          cursorTo: Math.round(tab.cursorTo),
          updatedAt: Date.now(),
        }));
      // 后台持久化：失败静默（重试由下一次变更触发），避免噪声
      api.saveTabsSession(records).catch(() => {});
    }, 300);
  });
  return () => {
    if (persistTimer !== undefined) {
      clearTimeout(persistTimer);
    }
    unsubscribe();
  };
}

/** 活动标签选择器（组件常用） */
export function selectActiveTab(state: TabsState): EditorTab | null {
  return state.tabs.find((tab) => tab.id === state.activeId) ?? null;
}

/** 一键执行钩子：WorkbenchView 注册，树菜单等外部入口经 requestRun 触发 */
type RunHandler = (sql: string) => void;
let runHandler: RunHandler | null = null;

export function registerRunHandler(handler: RunHandler | null): void {
  runHandler = handler;
}

/** 请求执行（假定目标标签已激活） */
export function requestRun(sql: string): void {
  runHandler?.(sql);
}
