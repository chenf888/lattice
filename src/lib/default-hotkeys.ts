/** 快捷键动作注册表：默认组合与规格一致；设置页可改绑（stores/hotkeys.ts 持久化） */

export const HOTKEY_DEFS = {
  toggleSidebar: { combo: "mod+b", label: "折叠 / 展开侧边栏" },
  newTab: { combo: "mod+t", label: "新建查询标签" },
  closeTab: { combo: "mod+w", label: "关闭当前标签" },
  saveQuery: { combo: "mod+s", label: "保存查询" },
  runAll: { combo: "mod+enter", label: "执行全部 SQL" },
  runSelected: { combo: "mod+shift+enter", label: "执行选中 SQL" },
  palette: { combo: "mod+k", label: "命令面板" },
  quickOpen: { combo: "mod+p", label: "快速打开" },
  openSettings: { combo: "mod+,", label: "打开设置" },
  refreshTree: { combo: "f5", label: "刷新当前对象" },
  toggleTheme: { combo: "mod+j", label: "切换主题" },
} as const;

export type HotkeyId = keyof typeof HOTKEY_DEFS;

export const HOTKEY_IDS = Object.keys(HOTKEY_DEFS) as HotkeyId[];

export function defaultCombo(id: HotkeyId): string {
  return HOTKEY_DEFS[id].combo;
}

/** 组合串 → 展示文本（Ctrl/⌘ + …） */
export function formatCombo(combo: string): string {
  const isMac =
    typeof navigator !== "undefined" && /mac/i.test(navigator.platform || navigator.userAgent);
  const parts = combo.split("+").map((part) => {
    switch (part) {
      case "mod":
        return isMac ? "⌘" : "Ctrl";
      case "shift":
        return isMac ? "⇧" : "Shift";
      case "alt":
        return isMac ? "⌥" : "Alt";
      case "enter":
        return "Enter";
      case ",":
        return ",";
      default:
        return part.length === 1 ? part.toUpperCase() : part;
    }
  });
  return parts.join(isMac ? "" : "+");
}

/** 从 KeyboardEvent 捕获组合串（设置页改绑用）；单独按键/修饰键返回 null */
export function comboFromEvent(event: KeyboardEvent): string | null {
  const key = event.key.toLowerCase();
  if (["control", "meta", "shift", "alt"].includes(key)) {
    return null;
  }
  if (event.ctrlKey || event.metaKey) {
    return `mod+${key}`;
  }
  if (event.shiftKey && key !== "shift") {
    return `shift+${key}`;
  }
  if (event.altKey) {
    return `alt+${key}`;
  }
  return key;
}
