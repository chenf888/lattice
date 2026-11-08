import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState, type ReactElement, type ReactNode } from "react";

import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { api } from "@/lib/ipc";
import { applyEditorFontSize, applyUiFontSize } from "@/lib/appearance";
import { hydrateI18n } from "@/lib/i18n";
import { useUiStore } from "@/stores/ui";
import { toastError } from "@/stores/toast";
import { attachTabsPersistence, useTabsStore } from "@/stores/tabs";
import { useHotkeysStore } from "@/stores/hotkeys";

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // IPC 失败多为确定性错误，盲目重试无意义；由调用方决定重试
        retry: false,
        refetchOnWindowFocus: false,
        staleTime: 30_000,
      },
      mutations: {
        // 统一兜底：mutation 未显式处理错误时经 toast 呈现
        onError: (error) => toastError(error),
      },
    },
  });
}

/** 启动水合：读取 settings → 恢复标签会话 → 决定初始路由 */
function Boot(): ReactElement | null {
  const hydrate = useUiStore((state) => state.hydrate);
  const navigate = useUiStore((state) => state.navigate);

  useEffect(() => {
    const restore = async (): Promise<void> => {
      await hydrate();
      await Promise.all([hydrateI18n(), useHotkeysStore.getState().hydrate()]);
      try {
        const [uiFont, editorFont] = await Promise.all([
          api.getSetting("ui.font_size"),
          api.getSetting("editor.font_size"),
        ]);
        if (uiFont !== null) applyUiFontSize(Number(uiFont));
        if (editorFont !== null) applyEditorFontSize(Number(editorFont));
      } catch {
        // 字号设置读取失败按默认渲染
      }
      try {
        const records = await api.loadTabsSession();
        useTabsStore.getState().restore(records);
        // 有历史标签 → 直接进入工作台；否则到连接主页
        navigate({ view: records.length > 0 ? "workbench" : "connections" });
      } catch (error) {
        toastError(error, "恢复标签会话失败");
        navigate({ view: "connections" });
      }
    };
    void restore();
    // 标签持久化订阅在恢复完成后才允许写入
    const detach = attachTabsPersistence();
    return detach;
  }, [hydrate, navigate]);

  return null;
}

export function Providers({ children }: { children: ReactNode }): ReactElement {
  const [queryClient] = useState(makeQueryClient);
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={400}>
        <Boot />
        {children}
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
