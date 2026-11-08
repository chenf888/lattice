import { create } from "zustand";

import { IpcFailure } from "@/lib/ipc";

export type ToastKind = "success" | "error" | "warning" | "info";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
  action?: ToastAction;
}

interface ToastState {
  toasts: ToastItem[];
  push: (kind: ToastKind, message: string, action?: ToastAction) => void;
  dismiss: (id: number) => void;
}

let nextId = 1;

export const useToastStore = create<ToastState>()((set) => ({
  toasts: [],
  push: (kind, message, action) =>
    set((state) => ({
      toasts: [...state.toasts, { id: nextId++, kind, message, action }],
    })),
  dismiss: (id) =>
    set((state) => ({ toasts: state.toasts.filter((item) => item.id !== id) })),
}));

function push(kind: ToastKind, message: string, action?: ToastAction): void {
  useToastStore.getState().push(kind, message, action);
}

export const toast = {
  success: (message: string, action?: ToastAction): void => push("success", message, action),
  error: (message: string, action?: ToastAction): void => push("error", message, action),
  warning: (message: string, action?: ToastAction): void => push("warning", message, action),
  info: (message: string, action?: ToastAction): void => push("info", message, action),
};

/** 统一错误出口：任何被捕获的失败都经此呈现，保证无静默吞错 */
export function toastError(err: unknown, context?: string): void {
  const message = err instanceof IpcFailure || err instanceof Error ? err.message : String(err);
  push("error", context ? `${context}：${message}` : message);
}
