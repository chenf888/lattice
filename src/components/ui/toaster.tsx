import * as ToastPrimitive from "@radix-ui/react-toast";
import { X } from "lucide-react";
import type { ReactElement } from "react";

import { cn } from "@/lib/utils";
import { useToastStore, type ToastItem, type ToastKind } from "@/stores/toast";

const DOT_CLASS: Record<ToastKind, string> = {
  success: "bg-success",
  error: "bg-danger",
  warning: "bg-warning",
  info: "bg-accent",
};

const EDGE_CLASS: Record<ToastKind, string> = {
  success: "border-l-success",
  error: "border-l-danger",
  warning: "border-l-warning",
  info: "border-l-accent",
};

function ToastCard({ item }: { item: ToastItem }): ReactElement {
  const dismiss = useToastStore((state) => state.dismiss);
  return (
    <ToastPrimitive.Root
      duration={item.kind === "error" ? 8000 : 4000}
      onOpenChange={(open) => {
        if (!open) {
          dismiss(item.id);
        }
      }}
      className={cn(
        "flex items-center gap-2.5 rounded-token border border-line border-l-2 bg-elevated px-3 py-2 text-[13px] text-fg shadow-pop",
        EDGE_CLASS[item.kind],
      )}
    >
      <span className={cn("h-2 w-2 shrink-0 rounded-full", DOT_CLASS[item.kind])} aria-hidden />
      <ToastPrimitive.Description className="min-w-0 flex-1 break-words">
        {item.message}
      </ToastPrimitive.Description>
      {item.action && (
        <ToastPrimitive.Action
          altText={item.action.label}
          onClick={item.action.onClick}
          className="shrink-0 rounded-token px-1.5 py-0.5 text-xs text-accent hover:bg-hover"
        >
          {item.action.label}
        </ToastPrimitive.Action>
      )}
      <ToastPrimitive.Close
        className="shrink-0 rounded-token p-0.5 text-muted hover:bg-hover hover:text-fg"
        aria-label="关闭"
      >
        <X className="h-3.5 w-3.5" />
      </ToastPrimitive.Close>
    </ToastPrimitive.Root>
  );
}

export function Toaster(): ReactElement {
  const toasts = useToastStore((state) => state.toasts);
  return (
    <ToastPrimitive.Provider swipeDirection="right" label="通知">
      {toasts.map((item) => (
        <ToastCard key={item.id} item={item} />
      ))}
      <ToastPrimitive.Viewport className="fixed right-4 bottom-4 z-[100] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2 outline-none" />
    </ToastPrimitive.Provider>
  );
}
