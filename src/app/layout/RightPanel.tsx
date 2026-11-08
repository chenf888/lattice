import type { ReactElement } from "react";

import { useUiStore } from "@/stores/ui";
import { HistoryPanel } from "@/features/history/HistoryPanel";

const PANEL_TITLE: Record<string, string> = {
  history: "执行历史",
  details: "对象详情",
};

/** 右侧可选面板（300px）；rightPanel === null 时不渲染 */
export function RightPanel(): ReactElement | null {
  const panel = useUiStore((state) => state.rightPanel);
  if (panel === null) {
    return null;
  }

  return (
    <aside className="h-full w-[300px] shrink-0 overflow-hidden border-l border-line bg-elevated">
      <div className="flex h-full flex-col">
        <div className="flex h-9 shrink-0 items-center border-b border-line px-3 text-[13px] font-medium">
          {PANEL_TITLE[panel] ?? panel}
        </div>
        <div className="min-h-0 flex-1">
          {panel === "history" ? <HistoryPanel /> : null}
        </div>
      </div>
    </aside>
  );
}
