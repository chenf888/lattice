import type { Density, ThemeMode } from "./types";

type ThemeListener = (dark: boolean) => void;

const media = window.matchMedia("(prefers-color-scheme: dark)");
const listeners = new Set<ThemeListener>();
let currentMode: ThemeMode = "dark";

// 系统主题变化：仅在“跟随系统”模式下改写 DOM，同时通知订阅者
media.addEventListener("change", (event) => {
  if (currentMode === "system") {
    document.documentElement.dataset.theme = event.matches ? "dark" : "light";
  }
  for (const listener of listeners) {
    listener(event.matches);
  }
});

export function systemPrefersDark(): boolean {
  return media.matches;
}

/** 将主题写入 <html data-theme>，驱动 CSS token 切换；system 经 prefers-color-scheme 解析 */
export function applyTheme(mode: ThemeMode): void {
  currentMode = mode;
  const resolved = mode === "system" ? (systemPrefersDark() ? "dark" : "light") : mode;
  document.documentElement.dataset.theme = resolved;
}

/** 将密度写入 <html data-density>，驱动行高 / 控件高度 / 字号 token */
export function applyDensity(density: Density): void {
  document.documentElement.dataset.density = density;
}

/** 订阅系统主题变化；返回取消函数 */
export function onSystemThemeChange(listener: ThemeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 界面字号（CSS 变量驱动密度字号基准） */
export function applyUiFontSize(px: number): void {
  const clamped = Math.min(18, Math.max(12, Math.round(px)));
  document.documentElement.style.setProperty("--font-size-base", `${clamped}px`);
}

/** 编辑器字号（CodeMirror 主题引用该变量） */
export function applyEditorFontSize(px: number): void {
  const clamped = Math.min(22, Math.max(11, Math.round(px)));
  document.documentElement.style.setProperty("--editor-font-size", `${clamped}px`);
}
