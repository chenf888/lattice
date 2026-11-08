import type { ReactElement } from "react";

import { useUiStore } from "@/stores/ui";
import { ConnectionsView } from "@/features/connections/ConnectionsView";
import { WorkbenchView } from "@/features/editor/WorkbenchView";
import { ErdView } from "@/features/erd/ErdView";
import { SettingsView } from "@/features/settings/SettingsView";

/** 轻量视图路由：ui.route → 视图组件；变体随阶段只增 */
export function RouteView(): ReactElement {
  const route = useUiStore((state) => state.route);
  switch (route.view) {
    case "workbench":
      return <WorkbenchView />;
    case "connections":
      return <ConnectionsView />;
    case "erd":
      return <ErdView />;
    case "settings":
      return <SettingsView />;
    default: {
      const unreachable: never = route.view;
      return unreachable;
    }
  }
}
