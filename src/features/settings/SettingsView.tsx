/** 设置页：外观 / 编辑器 / 数据 / 快捷键 / 关于（Ctrl/⌘+, 或 TitleBar 齿轮进入） */

import { useQuery } from "@tanstack/react-query";
import { useState, type KeyboardEvent, type ReactElement } from "react";

import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { api } from "@/lib/ipc";
import { formatCombo, comboFromEvent, HOTKEY_DEFS, HOTKEY_IDS, type HotkeyId } from "@/lib/default-hotkeys";
import { useI18n, type Lang } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { applyEditorFontSize, applyUiFontSize } from "@/lib/appearance";
import { toast } from "@/stores/toast";
import { useHotkeysStore } from "@/stores/hotkeys";
import { useUiStore } from "@/stores/ui";

type SettingsTab = "appearance" | "editor" | "data" | "hotkeys" | "about";

function Section({ title, children }: { title: string; children: React.ReactNode }): ReactElement {
  return (
    <section className="rounded-token border border-line bg-elevated p-4">
      <h2 className="text-[13px] font-semibold text-fg">{title}</h2>
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }): ReactElement {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p className="text-[13px] text-fg">{label}</p>
        {hint && <p className="text-xs text-muted">{hint}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

export function SettingsView(): ReactElement {
  const { t, lang, setLang } = useI18n();
  const [tab, setTab] = useState<SettingsTab>("appearance");

  // ── 外观 ──
  const theme = useUiStore((state) => state.theme);
  const setTheme = useUiStore((state) => state.setTheme);
  const density = useUiStore((state) => state.density);
  const setDensity = useUiStore((state) => state.setDensity);
  const [uiFontSize, setUiFontSize] = useState(() =>
    Number(getComputedStyle(document.documentElement).getPropertyValue("--font-size-base")) || 13,
  );

  // ── 编辑器 ──
  const [editorFontSize, setEditorFontSize] = useState(() =>
    Number(getComputedStyle(document.documentElement).getPropertyValue("--editor-font-size")) || 13,
  );
  const editorCompletions = useUiStore((state) => state.editorCompletions);
  const editorTabSize = useUiStore((state) => state.editorTabSize);
  const editorAutoFormat = useUiStore((state) => state.editorAutoFormat);
  const setEditorSettings = useUiStore((state) => state.setEditorSettings);

  // 编辑器设置持久化助手
  const persistEditor = (key: string, value: string): void => {
    api.setSetting(key, value).catch(() => {});
  };

  // ── 数据 ──
  const [maxRows, setMaxRows] = useState("");
  const [timeoutSeconds, setTimeoutSeconds] = useState("");
  const [autocommit, setAutocommit] = useState(true);
  const loadOnce = useState(() => {
    void (async () => {
      const [maxRowsRaw, timeoutRaw, autocommitRaw] = await Promise.all([
        api.getSetting("query.max_rows").catch(() => null),
        api.getSetting("query.timeout_seconds").catch(() => null),
        api.getSetting("data.autocommit").catch(() => null),
      ]);
      if (maxRowsRaw !== null) setMaxRows(maxRowsRaw);
      if (timeoutRaw !== null) setTimeoutSeconds(timeoutRaw);
      setAutocommit(autocommitRaw !== "false");
    })();
    return true;
  })[0];
  void loadOnce;

  // ── 快捷键 ──
  const overrides = useHotkeysStore((state) => state.overrides);
  const setHotkey = useHotkeysStore((state) => state.setHotkey);
  const resetHotkey = useHotkeysStore((state) => state.resetHotkey);
  const [capturing, setCapturing] = useState<HotkeyId | null>(null);

  // ── 关于 ──
  const { data: info } = useQuery({
    queryKey: ["app-info"],
    queryFn: api.getAppInfo,
    staleTime: Infinity,
  });
  const [updateInfo, setUpdateInfo] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const comboText = (id: HotkeyId): string =>
    formatCombo(overrides[id] ?? HOTKEY_DEFS[id].combo);

  const onCaptureKey = (event: KeyboardEvent<HTMLInputElement>, id: HotkeyId): void => {
    event.preventDefault();
    if (event.key === "Escape") {
      setCapturing(null);
      return;
    }
    const combo = comboFromEvent(event.nativeEvent);
    if (combo === null) {
      return; // 忽略纯修饰键
    }
    const conflict = setHotkey(id, combo);
    if (conflict !== null) {
      toast.warning(`${t("与「")}${HOTKEY_DEFS[conflict].label}${t("」冲突")}`);
    } else {
      toast.success(`${HOTKEY_DEFS[id].label} → ${formatCombo(combo)}`);
    }
    setCapturing(null);
  };

  const tabs: Array<{ id: SettingsTab; label: string }> = [
    { id: "appearance", label: t("外观") },
    { id: "editor", label: t("编辑器") },
    { id: "data", label: t("数据") },
    { id: "hotkeys", label: t("快捷键") },
    { id: "about", label: t("关于") },
  ];

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="mx-auto max-w-2xl p-4">
        <h1 className="text-[16px] font-semibold">{t("设置")}</h1>
        <div className="mt-3 flex gap-1">
          {tabs.map((item) => (
            <Button
              key={item.id}
              variant={tab === item.id ? "default" : "ghost"}
              size="sm"
              className="h-7 px-2.5 text-xs"
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </Button>
          ))}
        </div>

        <div className="mt-3 space-y-3">
          {tab === "appearance" && (
            <>
              <Section title={t("外观")}>
                <Row label={t("主题")}>
                  {(["dark", "light", "system"] as const).map((mode) => (
                    <Button
                      key={mode}
                      variant={theme === mode ? "default" : "ghost"}
                      size="sm"
                      className="h-7 px-2.5 text-xs"
                      onClick={() => setTheme(mode)}
                    >
                      {mode === "dark" ? t("深色") : mode === "light" ? t("浅色") : t("跟随系统")}
                    </Button>
                  ))}
                </Row>
                <Row label={t("界面密度")}>
                  {(["comfortable", "compact"] as const).map((mode) => (
                    <Button
                      key={mode}
                      variant={density === mode ? "default" : "ghost"}
                      size="sm"
                      className="h-7 px-2.5 text-xs"
                      onClick={() => setDensity(mode)}
                    >
                      {mode === "comfortable" ? t("舒适") : t("紧凑")}
                    </Button>
                  ))}
                </Row>
                <Row label={t("界面字号")}>
                  <Input
                    type="number"
                    min={12}
                    max={18}
                    value={uiFontSize}
                    className="w-20"
                    onChange={(event) => {
                      const size = Number(event.target.value) || 13;
                      setUiFontSize(size);
                      applyUiFontSize(size);
                      api.setSetting("ui.font_size", String(size)).catch(() => {});
                    }}
                  />
                </Row>
                <Row label={t("语言")}>
                  <Select
                    className="w-36"
                    value={lang}
                    onChange={(event) => setLang(event.target.value as Lang)}
                  >
                    <option value="system">{t("跟随系统")}</option>
                    <option value="zh">{t("中文")}</option>
                    <option value="en">English</option>
                  </Select>
                </Row>
              </Section>
            </>
          )}

          {tab === "editor" && (
            <Section title={t("编辑器")}>
              <Row label={t("编辑器字号")}>
                <Input
                  type="number"
                  min={11}
                  max={22}
                  value={editorFontSize}
                  className="w-20"
                  onChange={(event) => {
                    const size = Number(event.target.value) || 13;
                    setEditorFontSize(size);
                    applyEditorFontSize(size);
                    api.setSetting("editor.font_size", String(size)).catch(() => {});
                  }}
                />
              </Row>
              <Row label={t("Tab 宽度")}>
                <Select
                  className="w-20"
                  value={String(editorTabSize)}
                  onChange={(event) => setEditorSettings({ tabSize: Number(event.target.value) })}
                >
                  <option value="2">2</option>
                  <option value="4">4</option>
                  <option value="8">8</option>
                </Select>
              </Row>
              <Row label={t("自动补全")}>
                <input
                  type="checkbox"
                  checked={editorCompletions}
                  className="h-4 w-4 accent-[var(--accent)]"
                  onChange={(event) => setEditorSettings({ completions: event.target.checked })}
                />
              </Row>
              <Row label={t("执行前自动格式化")} hint={t("开启后执行前先格式化 SQL")}>
                <input
                  type="checkbox"
                  checked={editorAutoFormat}
                  className="h-4 w-4 accent-[var(--accent)]"
                  onChange={(event) => setEditorSettings({ autoFormat: event.target.checked })}
                />
              </Row>
            </Section>
          )}

          {tab === "data" && (
            <Section title={t("数据")}>
              <Row label={t("单页行数上限")}>
                <Input
                  type="number"
                  min={100}
                  value={maxRows}
                  className="w-28"
                  onChange={(event) => {
                    setMaxRows(event.target.value.replace(/\D/g, ""));
                  }}
                  onBlur={() => {
                    const value = maxRows === "" ? "50000" : maxRows;
                    setMaxRows(value);
                    persistEditor("query.max_rows", value);
                  }}
                />
              </Row>
              <Row label={t("查询超时（秒，0 = 不限）")}>
                <Input
                  type="number"
                  min={0}
                  value={timeoutSeconds}
                  className="w-28"
                  onChange={(event) => {
                    setTimeoutSeconds(event.target.value.replace(/\D/g, ""));
                  }}
                  onBlur={() => {
                    const value = timeoutSeconds === "" ? "0" : timeoutSeconds;
                    setTimeoutSeconds(value);
                    persistEditor("query.timeout_seconds", value);
                  }}
                />
              </Row>
              <Row label={t("自动提交")} hint={t("关闭后所有语句包裹在事务中，成功提交、失败回滚")}>
                <input
                  type="checkbox"
                  checked={autocommit}
                  className="h-4 w-4 accent-[var(--accent)]"
                  onChange={(event) => {
                    setAutocommit(event.target.checked);
                    persistEditor("data.autocommit", String(event.target.checked));
                  }}
                />
              </Row>
            </Section>
          )}

          {tab === "hotkeys" && (
            <Section title={t("快捷键")}>
              <table className="w-full text-left text-[13px]">
                <thead>
                  <tr className="text-xs text-muted">
                    <th className="py-1 font-medium">{t("动作")}</th>
                    <th className="py-1 font-medium">{t("组合键")}</th>
                    <th className="py-1" />
                  </tr>
                </thead>
                <tbody>
                  {HOTKEY_IDS.map((id) => (
                    <tr key={id} className="border-t border-line/60">
                      <td className="py-1.5">{HOTKEY_DEFS[id].label}</td>
                      <td className="py-1.5 font-mono text-xs">
                        {capturing === id ? (
                          <input
                            autoFocus
                            readOnly
                            value={t("按下组合键…（Esc 取消）")}
                            className="w-56 rounded-token border border-accent bg-base px-2 py-0.5 text-xs outline-none"
                            onKeyDown={(event) => onCaptureKey(event, id)}
                            onBlur={() => setCapturing(null)}
                          />
                        ) : (
                          <kbd className="rounded border border-line bg-base px-1.5 py-0.5">{comboText(id)}</kbd>
                        )}
                      </td>
                      <td className="py-1.5 text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 px-2 text-xs"
                          onClick={() => setCapturing(id)}
                        >
                          {t("修改")}
                        </Button>
                        {overrides[id] !== undefined && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2 text-xs"
                            onClick={() => resetHotkey(id)}
                          >
                            {t("恢复默认")}
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
          )}

          {tab === "about" && (
            <Section title={t("关于")}>
              <Row label={t("版本")}>
                <span className="font-mono text-xs text-muted">v{info?.version ?? "…"}</span>
              </Row>
              <Row label={t("检查更新")} hint={updateInfo ?? undefined}>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2.5 text-xs"
                  disabled={checking}
                  onClick={() => {
                    setChecking(true);
                    api
                      .checkUpdate()
                      .then((result) => {
                        setUpdateInfo(
                          result.hasUpdate
                            ? `${result.current} → ${result.latest}`
                            : t("已是最新版本"),
                        );
                      })
                      .catch(() => setUpdateInfo(t("未知错误")))
                      .finally(() => setChecking(false));
                  }}
                >
                  {checking ? t("检查中…") : t("检查更新")}
                </Button>
              </Row>
              <Row label={t("数据目录")} hint={info?.dataDir}>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2.5 text-xs"
                  onClick={() => void api.openDataDir().catch(() => {})}
                >
                  {t("打开数据目录")}
                </Button>
              </Row>
              <Row label={t("打开日志目录")} hint={info?.logDir}>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2.5 text-xs"
                  onClick={() => void api.openLogDir().catch(() => {})}
                >
                  {t("打开日志目录")}
                </Button>
              </Row>
              <p className={cn("text-[11px] text-muted")}>
                Lattice · {info?.platform ?? ""}/{info?.arch ?? ""}
              </p>
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}
