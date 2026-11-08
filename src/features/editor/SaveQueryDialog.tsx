/** 保存查询弹窗（Ctrl/⌘+S / 工具栏按钮） */

import { useMutation } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { useState } from "react";

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, type IpcFailure } from "@/lib/ipc";
import { toast } from "@/stores/toast";
import { useI18n } from "@/lib/i18n";
import { useTabsStore, type EditorTab } from "@/stores/tabs";

export interface SaveQueryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tab: EditorTab | null;
}

export function SaveQueryDialog({ open, onOpenChange, tab }: SaveQueryDialogProps): ReactElement {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  const markSaved = useTabsStore((state) => state.markSaved);

  const saveMutation = useMutation({
    mutationFn: (vars: { tab: EditorTab; name: string; folder: string }) =>
      api.saveSavedQuery({
        id: null,
        connectionId: vars.tab.connectionId,
        name: vars.name,
        sql: vars.tab.sql,
        folder: vars.folder === "" ? null : vars.folder,
      }),
    onSuccess: (saved, vars) => {
      markSaved(vars.tab.id, saved.name, vars.tab.sql);
      toast.success(`${t("已保存「")}${saved.name}${t("」")}`);
      setName("");
      setFolder("");
      onOpenChange(false);
    },
  });

  const submit = (): void => {
    if (!tab) {
      toast.warning(t("没有活动标签"));
      return;
    }
    if (name.trim() === "") {
      toast.warning(t("请填写查询名称"));
      return;
    }
    if (tab.sql.trim() === "") {
      toast.warning(t("当前标签没有可保存的 SQL"));
      return;
    }
    saveMutation.mutate({ tab, name: name.trim(), folder: folder.trim() });
  };

  const error = saveMutation.error as IpcFailure | null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <DialogContent className="w-[420px]">
          <DialogTitle>{t("保存查询")}</DialogTitle>
          <DialogDescription>{t("保存到 saved_queries，可在快速打开（Ctrl/⌘+P）中检索")}</DialogDescription>
          <div className="mt-4 space-y-3">
            <div>
              <label className="mb-1 block text-xs text-muted" htmlFor="save-query-name">
                {t("名称")}
              </label>
              <Input
                id="save-query-name"
                autoFocus
                value={name}
                placeholder="如：月度订单统计"
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    submit();
                  }
                }}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted" htmlFor="save-query-folder">
                {t("分组（可选）")}
              </label>
              <Input
                id="save-query-folder"
                value={folder}
                placeholder="如：报表"
                onChange={(event) => setFolder(event.target.value)}
              />
            </div>
            {error && <p className="text-xs text-danger">{error.message}</p>}
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              className="rounded-token border border-line px-3 py-1.5 text-xs hover:bg-hover"
              onClick={() => onOpenChange(false)}
            >
              取消
            </button>
            <button
              type="button"
              className="rounded-token bg-accent px-3 py-1.5 text-xs text-accent-fg hover:bg-accent-hover disabled:opacity-50"
              disabled={saveMutation.isPending}
              onClick={submit}
            >
              保存
            </button>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
