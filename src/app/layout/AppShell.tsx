import { useEffect, useMemo, type ReactElement } from "react";

import { RouteView } from "../router";
import { useGlobalHotkeys } from "@/lib/hotkeys";
import { useUiStore } from "@/stores/ui";
import { useHotkeyCombo } from "@/stores/hotkeys";
import { attachTaskEvents } from "@/stores/tasks";
import { CommandPalette } from "@/features/palette/CommandPalette";
import { ImportDialog } from "@/features/transfer/ImportDialog";
import { TaskTray } from "@/features/tasks/TaskTray";

import { RightPanel } from "./RightPanel";
import { Sidebar } from "./Sidebar";
import { TitleBar } from "./TitleBar";

export function AppShell(): ReactElement {
  const toggleSidebar = useUiStore((state) => state.toggleSidebar);
  const transferDialog = useUiStore((state) => state.transferDialog);
  const closeTransfer = useUiStore((state) => state.closeTransfer);
  const navigate = useUiStore((state) => state.navigate);
  const setTheme = useUiStore((state) => state.setTheme);
  const theme = useUiStore((state) => state.theme);
  const toggleSidebarCombo = useHotkeyCombo("toggleSidebar");
  const openSettingsCombo = useHotkeyCombo("openSettings");
  const toggleThemeCombo = useHotkeyCombo("toggleTheme");

  useEffect(() => attachTaskEvents(), []);

  const hotkeys = useMemo(
    () => ({
      [toggleSidebarCombo]: () => toggleSidebar(),
      [openSettingsCombo]: () => navigate({ view: "settings" }),
      [toggleThemeCombo]: () => setTheme(theme === "dark" ? "light" : theme === "light" ? "system" : "dark"),
    }),
    [toggleSidebarCombo, openSettingsCombo, toggleThemeCombo, toggleSidebar, navigate, setTheme, theme],
  );
  useGlobalHotkeys(hotkeys);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-base text-fg">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="min-w-0 flex-1 p-4">
          <RouteView />
        </main>
        <RightPanel />
      </div>
      <TaskTray />
      <CommandPalette />
      <ImportDialog open={transferDialog === "import"} onOpenChange={(open) => !open && closeTransfer()} />
    </div>
  );
}
