import { Database } from "lucide-react";
import type { ReactElement } from "react";

import { cn } from "@/lib/utils";
import { useUiStore } from "@/stores/ui";
import { ExplorerTree } from "@/features/explorer/ExplorerTree";
import { useConnections } from "@/features/connections/use-connections";
import { useI18n } from "@/lib/i18n";

export function Sidebar(): ReactElement {
  const { t } = useI18n();
  const collapsed = useUiStore((state) => state.sidebarCollapsed);
  const { data: connections } = useConnections();
  const hasConnections = (connections?.length ?? 0) > 0;

  return (
    <aside
      aria-hidden={collapsed}
      inert={collapsed}
      className={cn(
        "h-full shrink-0 overflow-hidden transition-[width] duration-150 ease-out",
        !collapsed && "border-r border-line bg-elevated",
      )}
      style={{ width: collapsed ? 0 : 240 }}
    >
      <div className="flex h-full w-60 flex-col">
        <div className="flex h-9 shrink-0 items-center border-b border-line px-3 text-[13px] font-medium">
          {t("对象浏览器")}
        </div>
        {hasConnections ? (
          <ExplorerTree />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-4 text-center">
            <Database className="h-7 w-7 text-muted/70" aria-hidden />
            <p className="text-[13px]">{t("暂无连接")}</p>
            <p className="text-xs text-muted">{t("在主页新建连接后，可在此浏览数据库对象")}</p>
          </div>
        )}
      </div>
    </aside>
  );
}
