/** 后台任务 store：task:progress / task:done 事件归约 + 完成系统通知 */

import { create } from "zustand";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

import { listen, type Event, type UnlistenFn } from "@tauri-apps/api/event";

import type { TaskDonePayload, TaskItem, TaskProgressPayload } from "@/lib/types";

interface TasksState {
  items: TaskItem[];
  trayOpen: boolean;
  toggleTray: (open?: boolean) => void;
  applyProgress: (payload: TaskProgressPayload, title: string) => void;
  applyDone: (payload: TaskDonePayload) => void;
  clearFinished: () => void;
}

function notifyDesktop(title: string, body: string): void {
  void (async () => {
    try {
      let granted = await isPermissionGranted();
      if (!granted) {
        granted = (await requestPermission()) === "granted";
      }
      if (granted) {
        sendNotification({ title, body });
      }
    } catch {
      // 通知失败不影响任务流（托盘内仍可见）
    }
  })();
}

function upsert(items: TaskItem[], next: TaskItem): TaskItem[] {
  const index = items.findIndex((item) => item.id === next.id);
  if (index < 0) {
    return [...items, next];
  }
  return items.map((item, position) => (position === index ? next : item));
}

export const useTasksStore = create<TasksState>()((set) => ({
  items: [],
  trayOpen: false,

  toggleTray: (open) => set((state) => ({ trayOpen: open ?? !state.trayOpen })),

  applyProgress: (payload, title) => {
    set((state) => {
      const existing = state.items.find((item) => item.id === payload.taskId);
      const logs = existing
        ? [...existing.logs, `${payload.done.toLocaleString()} 行`].slice(-200)
        : [`${payload.done.toLocaleString()} 行`];
      const item: TaskItem = existing ?? {
        id: payload.taskId,
        kind: payload.kind,
        title,
        status: "running",
        done: 0,
        total: payload.total,
        error: null,
        result: null,
        startedAt: Date.now(),
        logs: [],
      };
      return {
        items: upsert(state.items, {
          ...item,
          done: payload.done,
          total: payload.total ?? item.total,
          status: "running",
          logs,
        }),
      };
    });
  },

  applyDone: (payload) => {
    set((state) => {
      const existing = state.items.find((item) => item.id === payload.taskId);
      const item: TaskItem = {
        id: payload.taskId,
        kind: existing?.kind ?? "export",
        title: existing?.title ?? (existing?.kind === "import" ? "导入" : "导出"),
        status: payload.status,
        done: payload.result?.rows ?? existing?.done ?? 0,
        total: existing?.total ?? null,
        error: payload.error,
        result: payload.result,
        startedAt: existing?.startedAt ?? Date.now(),
        logs: payload.error
          ? [...(existing?.logs ?? []), `错误：${payload.error}`].slice(-200)
          : (existing?.logs ?? []),
      };
      return { items: upsert(state.items, item) };
    });
    const finished = useTasksStore
      .getState()
      .items.find((item) => item.id === payload.taskId);
    if (finished) {
      const label =
        payload.status === "completed"
          ? `${finished.title}完成`
          : payload.status === "cancelled"
            ? `${finished.title}已取消`
            : `${finished.title}失败`;
      notifyDesktop(
        label,
        `${finished.result?.rows.toLocaleString() ?? 0} 行${payload.error ? `：${payload.error}` : ""}`,
      );
    }
  },

  clearFinished: () =>
    set((state) => ({
      items: state.items.filter((item) => item.status === "running"),
    })),
}));

/** AppShell 挂载一次性订阅；返回解绑函数 */
export function attachTaskEvents(): () => void {
  const unlisteners: UnlistenFn[] = [];
  let disposed = false;
  const track = (promise: Promise<UnlistenFn>): void => {
    void promise.then((fn) => {
      if (disposed) {
        fn();
        return;
      }
      unlisteners.push(fn);
    });
  };
  track(
    listen<TaskProgressPayload>("task:progress", (event: Event<TaskProgressPayload>) => {
      const payload = event.payload;
      const title: string = payload.kind === "import" ? "导入" : "导出";
      useTasksStore.getState().applyProgress(payload, title);
    }),
  );
  track(
    listen<TaskDonePayload>("task:done", (event: Event<TaskDonePayload>) => {
      useTasksStore.getState().applyDone(event.payload);
    }),
  );
  return () => {
    disposed = true;
    for (const unlisten of unlisteners) {
      unlisten();
    }
  };
}
