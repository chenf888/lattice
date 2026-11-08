import { useQuery } from "@tanstack/react-query";
import { Monitor, Moon, PanelLeft, Settings, Sun } from "lucide-react";
import type { ReactElement } from "react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import type { ThemeMode } from "@/lib/types";
import { useUiStore } from "@/stores/ui";
import { useI18n } from "@/lib/i18n";

const NEXT_THEME: Record<ThemeMode, ThemeMode> = {
  dark: "light",
  light: "system",
  system: "dark",
};

const THEME_LABEL: Record<ThemeMode, string> = {
  dark: "深色",
  light: "浅色",
  system: "跟随系统",
};

const THEME_ICON: Record<ThemeMode, ReactElement> = {
  dark: <Moon className="h-4 w-4" />,
  light: <Sun className="h-4 w-4" />,
  system: <Monitor className="h-4 w-4" />,
};

export function TitleBar(): ReactElement {
  const { data: info } = useQuery({
    queryKey: ["app-info"],
    queryFn: api.getAppInfo,
    staleTime: Infinity,
  });
  const theme = useUiStore((state) => state.theme);
  const setTheme = useUiStore((state) => state.setTheme);
  const toggleSidebar = useUiStore((state) => state.toggleSidebar);
  const route = useUiStore((state) => state.route);
  const navigate = useUiStore((state) => state.navigate);
  const { t } = useI18n();

  // macOS 交通灯悬浮（titleBarStyle=Overlay），前端留出原生按钮区域
  const isMac = info?.platform === "macos";

  return (
    <header
      data-tauri-drag-region
      className={cn(
        "flex h-10 shrink-0 select-none items-center gap-1 pr-2 pl-1.5",
        isMac && "pl-[78px]",
      )}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" onClick={toggleSidebar} aria-label="折叠 / 展开侧边栏">
            <PanelLeft className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>折叠 / 展开侧边栏（Ctrl/⌘+B）</TooltipContent>
      </Tooltip>
      <span data-tauri-drag-region className="ml-1 text-[13px] font-semibold">
        Lattice
      </span>
      <nav className="ml-2 flex items-center gap-0.5" aria-label={t("主导航")}>
        {(
          [
            { view: "connections", label: t("连接") },
            { view: "workbench", label: t("工作台") },
          ] as const
        ).map((item) => (
          <Button
            key={item.view}
            variant="ghost"
            size="sm"
            className={cn("h-7 px-2.5 text-xs", route.view === item.view && "bg-active/70 text-fg")}
            aria-current={route.view === item.view ? "page" : undefined}
            onClick={() => navigate({ view: item.view })}
          >
            {item.label}
          </Button>
        ))}
      </nav>
      <div data-tauri-drag-region className="h-full flex-1" />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigate({ view: "settings" })}
            aria-label={t("设置")}
          >
            <Settings className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t("设置")}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setTheme(NEXT_THEME[theme])}
            aria-label={`切换主题（当前：${THEME_LABEL[theme]}）`}
          >
            {THEME_ICON[theme]}
          </Button>
        </TooltipTrigger>
        <TooltipContent>主题：{THEME_LABEL[theme]}</TooltipContent>
      </Tooltip>
    </header>
  );
}
