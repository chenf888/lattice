import { useEffect } from "react";

export type HotkeyHandler = (event: KeyboardEvent) => void;
/** 组合键记法："mod" = Cmd/Ctrl，如 "mod+b"、"mod+shift+enter"、"mod+," */
export type HotkeyMap = Record<string, HotkeyHandler>;

interface ParsedCombo {
  key: string;
  mod: boolean;
  shift: boolean;
  alt: boolean;
}

function parse(combo: string): ParsedCombo {
  const parts = combo.toLowerCase().split("+");
  const key = parts[parts.length - 1] ?? "";
  return {
    key,
    mod: parts.includes("mod"),
    shift: parts.includes("shift"),
    alt: parts.includes("alt"),
  };
}

function matches(event: KeyboardEvent, combo: ParsedCombo): boolean {
  if (event.key.toLowerCase() !== combo.key) return false;
  const mod = event.metaKey || event.ctrlKey;
  return combo.mod === mod && combo.shift === event.shiftKey && combo.alt === event.altKey;
}

/** 全局热键注册表：defs 需引用稳定（如经 useMemo），变化时重新注册 */
export function useGlobalHotkeys(defs: HotkeyMap): void {
  useEffect(() => {
    const entries = Object.entries(defs).map(([combo, handler]) => ({
      parsed: parse(combo),
      handler,
    }));
    const onKeyDown = (event: KeyboardEvent): void => {
      for (const { parsed, handler } of entries) {
        if (matches(event, parsed)) {
          event.preventDefault();
          handler(event);
          return;
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [defs]);
}
