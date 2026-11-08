/** 快捷键 store：ui.hotkeys JSON 持久化（id → 组合覆盖）；冲突检测 */

import { create } from "zustand";

import { api } from "@/lib/ipc";
import { defaultCombo, HOTKEY_IDS, type HotkeyId } from "@/lib/default-hotkeys";
import { SETTING_KEYS } from "@/lib/types";

interface HotkeysState {
  overrides: Partial<Record<HotkeyId, string>>;
  hydrate: () => Promise<void>;
  /** 返回被冲突的 id（同组合已占用）则拒绝改绑并返回冲突方，成功返回 null */
  setHotkey: (id: HotkeyId, combo: string) => HotkeyId | null;
  resetHotkey: (id: HotkeyId) => void;
}

function parseOverrides(raw: string | null): Partial<Record<HotkeyId, string>> {
  if (raw === null) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return {};
    }
    const entries = Object.entries(parsed as Record<string, unknown>).filter(
      (entry): entry is [HotkeyId, string] =>
        HOTKEY_IDS.includes(entry[0] as HotkeyId) && typeof entry[1] === "string" && entry[1] !== "",
    );
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

export const useHotkeysStore = create<HotkeysState>()((set, get) => ({
  overrides: {},

  hydrate: async () => {
    try {
      const raw = await api.getSetting(SETTING_KEYS.hotkeys);
      set({ overrides: parseOverrides(raw) });
    } catch {
      // 快捷键读取失败保持默认（设置页可重新保存）
      set({ overrides: {} });
    }
  },

  setHotkey: (id, combo) => {
    const occupied = HOTKEY_IDS.find(
      (candidate) =>
        candidate !== id &&
        get().overrides[candidate] === combo &&
        combo !== defaultCombo(candidate),
    );
    const defaultOccupied = HOTKEY_IDS.find(
      (candidate) => candidate !== id && defaultCombo(candidate) === combo && get().overrides[candidate] === undefined,
    );
    const conflict = occupied ?? defaultOccupied ?? null;
    if (conflict !== null) {
      return conflict;
    }
    const next = { ...get().overrides };
    if (combo === defaultCombo(id)) {
      delete next[id];
    } else {
      next[id] = combo;
    }
    set({ overrides: next });
    api.setSetting(SETTING_KEYS.hotkeys, JSON.stringify(next)).catch(() => {});
    return null;
  },

  resetHotkey: (id) => {
    const next = { ...get().overrides };
    delete next[id];
    set({ overrides: next });
    api.setSetting(SETTING_KEYS.hotkeys, JSON.stringify(next)).catch(() => {});
  },
}));

/** 读取动作当前组合（默认或覆盖） */
export function comboOf(id: HotkeyId): string {
  return useHotkeysStore.getState().overrides[id] ?? defaultCombo(id);
}

/** 订阅动作当前组合（默认或覆盖） */
export function useHotkeyCombo(id: HotkeyId): string {
  return useHotkeysStore((state) => state.overrides[id]) ?? defaultCombo(id);
}
