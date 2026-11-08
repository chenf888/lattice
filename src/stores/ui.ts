import { create } from "zustand";

import { applyDensity, applyTheme } from "@/lib/appearance";
import { api } from "@/lib/ipc";
import {
  SETTING_KEYS,
  type Density,
  type RightPanelKind,
  type Route,
  type ThemeMode,
} from "@/lib/types";

/** 最近打开的表（快速打开 Ctrl/⌘+P 用） */
export interface RecentTable {
  connectionId: string;
  database: string;
  schema: string;
  table: string;
}

const RECENT_TABLE_LIMIT = 20;
import { toastError } from "@/stores/toast";

const THEME_VALUES: readonly string[] = ["dark", "light", "system"];
const DENSITY_VALUES: readonly string[] = ["compact", "comfortable"];

function parseTheme(raw: string | null): ThemeMode {
  return raw !== null && THEME_VALUES.includes(raw) ? (raw as ThemeMode) : "dark";
}

function parseDensity(raw: string | null): Density {
  return raw !== null && DENSITY_VALUES.includes(raw) ? (raw as Density) : "comfortable";
}

function parseCollapsed(raw: string | null): boolean {
  return raw === "true";
}

async function readSetting(key: string): Promise<string | null> {
  try {
    return await api.getSetting(key);
  } catch (err) {
    toastError(err);
    return null;
  }
}

/** 即时持久化：settings 写入为本地 SQLite 短事务，无需防抖 */
function persist(key: string, value: string): void {
  api.setSetting(key, value).catch(toastError);
}

interface UiState {
  booted: boolean;
  route: Route;
  sidebarCollapsed: boolean;
  theme: ThemeMode;
  density: Density;
  rightPanel: RightPanelKind | null;
  /** 导入/导出对话框（"export" 由工作台渲染，"import" 全局渲染） */
  transferDialog: "export" | "import" | null;
  chartOpen: boolean;
  /** ER 图 → 对象树定位请求 */
  focus: { connectionId: string; nodeId: string } | null;
  recentTables: RecentTable[];
  /** 编辑器设置（设置页写入即生效） */
  editorCompletions: boolean;
  editorTabSize: number;
  editorAutoFormat: boolean;

  /** 启动时读取 settings 并应用外观；失败兜底默认值 */
  hydrate: () => Promise<void>;
  navigate: (route: Route) => void;
  toggleSidebar: () => void;
  setTheme: (theme: ThemeMode) => void;
  setDensity: (density: Density) => void;
  openRightPanel: (kind: RightPanelKind) => void;
  closeRightPanel: () => void;
  openTransfer: (kind: "export" | "import") => void;
  closeTransfer: () => void;
  setChartOpen: (open: boolean) => void;
  focusTree: (connectionId: string, nodeId: string) => void;
  clearFocus: () => void;
  pushRecentTable: (entry: RecentTable) => void;
  setEditorSettings: (patch: { completions?: boolean; tabSize?: number; autoFormat?: boolean }) => void;
}

export const useUiStore = create<UiState>()((set, get) => ({
  booted: false,
  route: { view: "workbench" },
  sidebarCollapsed: false,
  theme: "dark",
  density: "comfortable",
  rightPanel: null,
  transferDialog: null,
  chartOpen: false,
  focus: null,
  recentTables: [],
  editorCompletions: true,
  editorTabSize: 2,
  editorAutoFormat: false,

  hydrate: async () => {
    if (get().booted) return;
    const [themeRaw, densityRaw, collapsedRaw, recentRaw, tabSizeRaw, completionsRaw, autoFormatRaw] =
      await Promise.all([
        readSetting(SETTING_KEYS.theme),
        readSetting(SETTING_KEYS.density),
        readSetting(SETTING_KEYS.sidebarCollapsed),
        readSetting(SETTING_KEYS.recentTables),
        readSetting(SETTING_KEYS.editorTabSize),
        readSetting(SETTING_KEYS.editorCompletions),
        readSetting(SETTING_KEYS.editorAutoFormat),
      ]);
    const theme = parseTheme(themeRaw);
    const density = parseDensity(densityRaw);
    const sidebarCollapsed = parseCollapsed(collapsedRaw);
    let recentTables: RecentTable[] = [];
    if (recentRaw !== null) {
      try {
        const parsed: unknown = JSON.parse(recentRaw);
        if (Array.isArray(parsed)) {
          recentTables = parsed.filter(
            (entry): entry is RecentTable =>
              typeof entry === "object" &&
              entry !== null &&
              typeof (entry as RecentTable).connectionId === "string" &&
              typeof (entry as RecentTable).table === "string",
          );
        }
      } catch {
        recentTables = [];
      }
    }
    applyTheme(theme);
    applyDensity(density);
    set({
      theme,
      density,
      sidebarCollapsed,
      recentTables,
      editorTabSize: tabSizeRaw !== null ? Number(tabSizeRaw) || 2 : 2,
      editorCompletions: completionsRaw !== "false",
      editorAutoFormat: autoFormatRaw === "true",
      booted: true,
    });
  },

  navigate: (route) => set({ route }),

  toggleSidebar: () => {
    const next = !get().sidebarCollapsed;
    set({ sidebarCollapsed: next });
    persist(SETTING_KEYS.sidebarCollapsed, String(next));
  },

  setTheme: (theme) => {
    applyTheme(theme);
    set({ theme });
    persist(SETTING_KEYS.theme, theme);
  },

  setDensity: (density) => {
    applyDensity(density);
    set({ density });
    persist(SETTING_KEYS.density, density);
  },

  openRightPanel: (kind) => set({ rightPanel: kind }),
  closeRightPanel: () => set({ rightPanel: null }),

  openTransfer: (kind) => set({ transferDialog: kind }),
  closeTransfer: () => set({ transferDialog: null }),
  setChartOpen: (open) => set({ chartOpen: open }),
  focusTree: (connectionId, nodeId) => set({ focus: { connectionId, nodeId } }),
  clearFocus: () => set({ focus: null }),
  pushRecentTable: (entry) => {
    const previous = get().recentTables.filter(
      (item) =>
        !(
          item.connectionId === entry.connectionId &&
          item.database === entry.database &&
          item.schema === entry.schema &&
          item.table === entry.table
        ),
    );
    const next = [entry, ...previous].slice(0, RECENT_TABLE_LIMIT);
    set({ recentTables: next });
    persist(SETTING_KEYS.recentTables, JSON.stringify(next));
  },

  setEditorSettings: (patch) => {
    const state = get();
    if (patch.completions !== undefined) {
      state.editorCompletions = patch.completions;
      persist(SETTING_KEYS.editorCompletions, String(patch.completions));
    }
    if (patch.tabSize !== undefined) {
      state.editorTabSize = patch.tabSize;
      persist(SETTING_KEYS.editorTabSize, String(patch.tabSize));
    }
    if (patch.autoFormat !== undefined) {
      state.editorAutoFormat = patch.autoFormat;
      persist(SETTING_KEYS.editorAutoFormat, String(patch.autoFormat));
    }
    set({
      editorCompletions: state.editorCompletions,
      editorTabSize: state.editorTabSize,
      editorAutoFormat: state.editorAutoFormat,
    });
  },
}));
