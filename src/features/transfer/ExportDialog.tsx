/** 导出对话框：格式/列/编码/行分隔 → 保存路径 → 后台流式导出任务 */

import type { ReactElement } from "react";
import { useState } from "react";

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { api } from "@/lib/ipc";
import type { ColumnMeta, ExportEncodingKind, ExportFormatKind } from "@/lib/types";
import { toast, toastError } from "@/stores/toast";
import { useI18n } from "@/lib/i18n";

export interface ExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectionId: string | null;
  database: string | null;
  /** 导出数据源：本次执行的 SQL（不受网格截断限制） */
  sql: string | null;
  columns: ColumnMeta[];
  defaultTable: string | null;
}

export function ExportDialog({
  open,
  onOpenChange,
  connectionId,
  database,
  sql,
  columns,
  defaultTable,
}: ExportDialogProps): ReactElement {
  const { t } = useI18n();
  const [format, setFormat] = useState<ExportFormatKind>("csv");
  const [encoding, setEncoding] = useState<ExportEncodingKind>("utf8");
  const [separator, setSeparator] = useState<"\n" | "\r\n">("\n");
  const [table, setTable] = useState(defaultTable ?? "");
  const [maxRows, setMaxRows] = useState("");
  const [selectedColumns, setSelectedColumns] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const allColumnNames = columns.map((column) => column.name);

  const start = async (): Promise<void> => {
    if (!connectionId) {
      toast.warning("标签未绑定连接");
      return;
    }
    if (!sql) {
      toast.warning(t("没有可导出的执行"));
      return;
    }
    setBusy(true);
    try {
      const extension = format === "csv" ? "csv" : format === "json" ? "json" : "sql";
      const path = await api.pickSavePath(`export.${extension}`);
      if (!path) {
        return; // 用户取消选择
      }
      await api.exportQuery(connectionId, database, sql, {
        format,
        columns: selectedColumns.size > 0 ? allColumnNames.filter((name) => selectedColumns.has(name)) : null,
        encoding,
        lineSeparator: separator,
        filePath: path,
        table: format === "insert" ? table : null,
        maxRows: maxRows === "" ? null : Number(maxRows),
      });
      toast.info(t("导出任务已开始，可在右下角任务托盘查看进度"));
      onOpenChange(false);
    } catch (error) {
      toastError(error, t("发起导出失败"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <DialogContent className="w-[520px]">
          <DialogTitle>{t("导出结果")}</DialogTitle>
          <DialogDescription>
            {t("按本次执行的 SQL 重新流式导出（不受网格行上限限制）；总是后台任务，可在托盘查看进度。")}
          </DialogDescription>

          <div className="mt-4 space-y-3">
            <div className="flex gap-2">
              <label className="flex-1">
                <span className="mb-1 block text-xs text-muted">格式</span>
                <Select value={format} onChange={(event) => setFormat(event.target.value as ExportFormatKind)}>
                  <option value="csv">CSV</option>
                  <option value="json">JSON</option>
                  <option value="insert">SQL INSERT</option>
                </Select>
              </label>
              <label className="flex-1">
                <span className="mb-1 block text-xs text-muted">编码</span>
                <Select value={encoding} onChange={(event) => setEncoding(event.target.value as ExportEncodingKind)}>
                  <option value="utf8">UTF-8</option>
                  <option value="utf8-bom">UTF-8（BOM）</option>
                  <option value="gbk">GBK</option>
                </Select>
              </label>
              <label className="flex-1">
                <span className="mb-1 block text-xs text-muted">行分隔</span>
                <Select value={separator} onChange={(event) => setSeparator(event.target.value as "\n" | "\r\n")}>
                  <option value={"\n"}>LF（\n）</option>
                  <option value={"\r\n"}>CRLF（\r\n）</option>
                </Select>
              </label>
            </div>

            {format === "insert" && (
              <label className="block">
                <span className="mb-1 block text-xs text-muted">目标表名（INSERT 用）</span>
                <Input value={table} onChange={(event) => setTable(event.target.value)} placeholder="如 users" />
              </label>
            )}
            <label className="block">
              <span className="mb-1 block text-xs text-muted">行数上限（留空 = 不限）</span>
              <Input
                value={maxRows}
                inputMode="numeric"
                onChange={(event) => setMaxRows(event.target.value.replace(/\D/g, ""))}
                placeholder="如 100000"
              />
            </label>

            <div>
              <span className="mb-1 block text-xs text-muted">
                {t("列（全不选 = 全部；当前")} {allColumnNames.length} {t("列）")}
              </span>
              <div className="flex max-h-28 flex-wrap gap-1 overflow-y-auto rounded-token border border-line p-2">
                {allColumnNames.map((name) => (
                  <button
                    key={name}
                    type="button"
                    className={
                      selectedColumns.has(name)
                        ? "rounded-token border border-accent bg-accent/10 px-2 py-0.5 text-xs text-fg"
                        : "rounded-token border border-line px-2 py-0.5 text-xs text-muted hover:bg-hover"
                    }
                    onClick={() => {
                      setSelectedColumns((previous) => {
                        const next = new Set(previous);
                        if (next.has(name)) {
                          next.delete(name);
                        } else {
                          next.add(name);
                        }
                        return next;
                      });
                    }}
                  >
                    {name}
                  </button>
                ))}
                {allColumnNames.length === 0 && (
                  <span className="text-xs text-muted">{t("无列信息（将导出执行产生的列）")}</span>
                )}
              </div>
            </div>
          </div>

          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" size="sm" className="h-7 px-3 text-xs" onClick={() => onOpenChange(false)}>
              {t("取消")}
            </Button>
            <Button size="sm" className="h-7 px-3 text-xs" disabled={busy} onClick={() => void start()}>
              {busy ? t("发起中…") : t("选择位置并导出")}
            </Button>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
