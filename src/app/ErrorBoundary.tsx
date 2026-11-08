/** 全局错误边界：异常时展示错误页，提供「重启应用 / 打开日志目录 / 返回主页」 */

import { Component, type ErrorInfo, type ReactNode } from "react";

import { api } from "@/lib/ipc";
import { useI18nStore } from "@/lib/i18n";

const COPY: Record<"zh" | "en", { title: string; hint: string; restart: string; logs: string; home: string; module: string }> = {
  zh: {
    title: "界面发生未捕获异常",
    hint: "应用状态可能已不一致。可重启应用，或打开日志目录定位问题。",
    restart: "重启应用",
    logs: "打开日志目录",
    home: "返回主页",
    module: "出错模块",
  },
  en: {
    title: "An unexpected error occurred",
    hint: "App state may be inconsistent. Restart the app or open the log directory to investigate.",
    restart: "Restart app",
    logs: "Open log directory",
    home: "Go home",
    module: "Failed module",
  },
};

interface ErrorBoundaryState {
  error: Error | null;
  module: string | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, module: null };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ error, module: info.componentStack?.split("\n")[1]?.trim() ?? null });
  }

  private goHome = (): void => {
    this.setState({ error: null, module: null });
  };

  render(): ReactNode {
    const { error, module } = this.state;
    if (!error) {
      return this.props.children;
    }
    const copy = COPY[useI18nStore.getState().lang === "en" ? "en" : "zh"];
    return (
      <div className="grid h-screen w-screen place-items-center bg-base p-8 text-fg">
        <div className="w-full max-w-xl rounded-token border border-line bg-elevated p-6">
          <p className="text-[15px] font-semibold text-danger">{copy.title}</p>
          <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-token border border-line bg-base p-3 font-mono text-xs">
            {error.message}
          </pre>
          {module && (
            <p className="mt-2 text-xs text-muted">
              {copy.module}：{module}
            </p>
          )}
          <p className="mt-2 text-xs text-muted">{copy.hint}</p>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              className="rounded-token border border-line px-3 py-1.5 text-xs hover:bg-hover"
              onClick={() => {
                api.openLogDir().catch(() => {});
              }}
            >
              {copy.logs}
            </button>
            <button
              type="button"
              className="rounded-token border border-line px-3 py-1.5 text-xs hover:bg-hover"
              onClick={this.goHome}
            >
              {copy.home}
            </button>
            <button
              type="button"
              className="rounded-token bg-accent px-3 py-1.5 text-xs text-accent-fg hover:bg-accent-hover"
              onClick={() => {
                api.restartApp().catch(() => {
                  // 重启命令失败（罕见）：退化为整页重载
                  window.location.reload();
                });
              }}
            >
              {copy.restart}
            </button>
          </div>
        </div>
      </div>
    );
  }
}
