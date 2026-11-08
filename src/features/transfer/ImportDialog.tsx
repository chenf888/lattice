/** 导入对话框：CSV 预览 → 列映射 + 类型推断展示 + 冲突策略 → 后台导入任务 */

import { useQuery } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { useMemo, useState } from "react";

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { api } from "@/lib/ipc";
import type { ColumnMeta } from "@/lib/types";
import { useConnections } from "@/features/connections/use-connections";
import { useI18n } from "@/lib/i18n";
import { toast, toastError } from "@/stores/toast";

export interface ImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** 文本/数值类型推断（展示用；入库类型由目标列约束决定） */
function inferColumnType(values: string[]): "numeric" | "text" {
  const nonEmpty = values.filter((value) => value !== "");
  if (nonEmpty.length === 0) {
    return "text";
  }
  return nonEmpty.every((value) => /^-?\d+(\.\d+)?$/.test(value)) ? "numeric" : "text";
}

function mappingFileKey(file: string, hasHeader: boolean, delimiter: string): string {
  return `${file}|${String(hasHeader)}|${delimiter}`;
}

export function ImportDialog({ open, onOpenChange }: ImportDialogProps): ReactElement {
  const { t } = useI18n();
  const { data: connections } = useConnections();
  const [connectionId, setConnectionId] = useState("");
  const [table, setTable] = useState("");
  const [filePath, setFilePath] = useState("");
  const [delimiter, setDelimiter] = useState(",");
  const [hasHeader, setHasHeader] = useState(true);
  const [conflict, setConflict] = useState<"error" | "skip" | "overwrite">("skip");
  const [mapping, setMapping] = useState<Array<{ source: string; target: string | null }>>([]);

  const connection = connections?.find((item) => item.id === connectionId) ?? null;
  const isSqlite = connection?.driver === "sqlite";

  const previewQuery = useQuery({
    queryKey: ["csv-preview", filePath, delimiter, hasHeader],
    queryFn: () => api.previewCsv(filePath, delimiter, hasHeader),
    enabled: open && filePath !== "",
    staleTime: Infinity,
  });

  const tableColumnsQuery = useQuery({
    queryKey: ["import-table-columns", connectionId, table],
    queryFn: () => api.describeTable(connectionId, null, isSqlite ? "main" : "public", table),
    enabled: open && connectionId !== "" && table.trim() !== "",
  });

  const tableColumns: ColumnMeta[] = useMemo(() => tableColumnsQuery.data ?? [], [tableColumnsQuery.data]);

  // 预览到达 → 初始化映射（全部默认跳过，待用户选择目标列）
  const preview = previewQuery.data;
  const mappingKey = mappingFileKey(filePath, hasHeader, delimiter);
  const [lastKey, setLastKey] = useState("");
  if (preview && mappingKey !== lastKey) {
    setLastKey(mappingKey);
    setMapping(preview.headers.map((_header, index) => ({ source: String(index), target: null })));
  }

  const start = async (): Promise<void> => {
    if (!connection) {
      toast.warning(t("请选择连接"));
      return;
    }
    if (table.trim() === "") {
      toast.warning(t("请填写目标表名"));
      return;
    }
    if (mapping.every((entry) => entry.target === null)) {
      toast.warning(t("至少映射一列"));
      return;
    }
    try {
      await api.importCsv(connectionId, null, table.trim(), {
        filePath,
        delimiter,
        hasHeader,
        columnMapping: mapping,
        conflict,
        batchSize: 500,
      });
      toast.info(t("导入任务已开始，可在右下角任务托盘查看进度与错误行"));
      onOpenChange(false);
    } catch (error) {
      toastError(error, t("发起导入失败"));
    }
  };

  const numericTargets = new Set(
    tableColumns
      .filter((column) => /int|float|double|decimal|numeric|real|number/i.test(column.typeName))
      .map((column) => column.name),
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <DialogContent className="flex max-h-[86vh] w-[720px] flex-col overflow-y-auto">
          <DialogTitle>{t("导入 CSV")}</DialogTitle>
          <DialogDescription>
            {t("列映射 → 类型按内容推断（展示提示）→ 后台任务执行；失败行可在任务托盘查看。")}
          </DialogDescription>

          <div className="mt-4 grid grid-cols-2 gap-2">
            <label>
              <span className="mb-1 block text-xs text-muted">{t("连接")}</span>
              <Select
                value={connectionId}
                onChange={(event) => setConnectionId(event.target.value)}
              >
                <option value="">选择连接…</option>
                {(connections ?? []).map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </Select>
            </label>
            <label>
              <span className="mb-1 block text-xs text-muted">{t("目标表名")}</span>
              <Input value={table} onChange={(event) => setTable(event.target.value)} placeholder="如 users" />
            </label>
            <label className="col-span-2">
              <span className="mb-1 block text-xs text-muted">{t("CSV 文件路径")}</span>
              <div className="flex gap-1.5">
                <Input
                  value={filePath}
                  onChange={(event) => setFilePath(event.target.value)}
                  placeholder="如 E:\data\users.csv"
                />
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-[var(--ctl-h)] px-2 text-xs"
                  onClick={() => {
                    void api
                      .pickOpenPath()
                      .then((path) => {
                        if (path) {
                          setFilePath(path);
                        }
                      })
                      .catch((error: unknown) => toastError(error));
                  }}
                >
                  {t("浏览…")}
                </Button>
              </div>
            </label>
            <label>
              <span className="mb-1 block text-xs text-muted">{t("分隔符")}</span>
              <Select value={delimiter} onChange={(event) => setDelimiter(event.target.value)}>
                <option value=",">逗号（,）</option>
                <option value={";"}>分号（;）</option>
                <option value={"\t"}>Tab</option>
                <option value="|">竖线（|）</option>
              </Select>
            </label>
            <label>
              <span className="mb-1 block text-xs text-muted">{t("冲突策略")}</span>
              <Select value={conflict} onChange={(event) => setConflict(event.target.value as "error" | "skip" | "overwrite")}>
                <option value="error">{t("报错（首错中止）")}</option>
                <option value="skip">{t("跳过失败行")}</option>
                <option value="overwrite">{t("覆盖（替换同主键）")}</option>
              </Select>
            </label>
            <label className="col-span-2 flex items-center gap-2">
              <input
                type="checkbox"
                checked={hasHeader}
                onChange={(event) => setHasHeader(event.target.checked)}
                className="h-3.5 w-3.5 accent-[var(--accent)]"
              />
              <span className="text-xs text-muted">{t("首行为表头")}</span>
            </label>
          </div>

          {/* 列映射 */}
          {preview && (
            <div className="mt-3">
              <span className="mb-1 block text-xs text-muted">
                {t("列映射（共")} {preview.totalRows.toLocaleString()} {t("行；类型为按内容推断）")}
              </span>
              <div className="max-h-40 overflow-y-auto rounded-token border border-line">
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 bg-elevated text-muted">
                    <tr>
                      <th className="px-2 py-1 font-medium">{t("源列")}</th>
                      <th className="px-2 py-1 font-medium">{t("样例")}</th>
                      <th className="px-2 py-1 font-medium">{t("推断")}</th>
                      <th className="px-2 py-1 font-medium">{t("目标列")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.headers.map((header, index) => {
                      const samples = preview.rows
                        .slice(0, 5)
                        .map((row) => row[index] ?? "")
                        .join(" | ");
                      const kind = inferColumnType(preview.rows.slice(0, 50).map((row) => row[index] ?? ""));
                      const current = mapping.find((entry) => entry.source === String(index));
                      return (
                        <tr key={index} className="border-t border-line/60">
                          <td className="px-2 py-1 font-mono text-fg">{hasHeader ? header : `列${index}`}</td>
                          <td className="max-w-40 truncate px-2 py-1 text-muted" title={samples}>
                            {samples || "—"}
                          </td>
                          <td className="px-2 py-1 text-muted">
                            {kind === "numeric" ? t("数值") : t("文本")}
                            {kind === "text" && numericTargets.size > 0 ? "" : ""}
                          </td>
                          <td className="px-2 py-1">
                            <Select
                              aria-label={`映射 ${header}`}
                              className="w-44"
                              value={current?.target ?? ""}
                              onChange={(event) => {
                                const target = event.target.value === "" ? null : event.target.value;
                                setMapping((previous) => {
                                  const next = previous.filter((entry) => entry.source !== String(index));
                                  next.push({ source: String(index), target });
                                  return next;
                                });
                              }}
                            >
                              <option value="">{t("（跳过）")}</option>
                              {tableColumns.map((column) => (
                                <option key={column.name} value={column.name}>
                                  {column.name}
                                  {numericTargets.has(column.name) ? `（${column.typeName}）` : ""}
                                </option>
                              ))}
                            </Select>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {tableColumnsQuery.isError && (
                <p className="mt-1 text-xs text-danger">
                  {t("目标表列读取失败（表不存在？），映射暂不可用")}
                </p>
              )}
            </div>
          )}
          {previewQuery.isError && (
            <p className="mt-2 text-xs text-danger">{t("文件读取失败：请检查路径与分隔符")}</p>
          )}

          <div className="mt-4 flex justify-end gap-2 pb-1">
            <Button variant="ghost" size="sm" className="h-7 px-3 text-xs" onClick={() => onOpenChange(false)}>
              {t("取消")}
            </Button>
            <Button
              size="sm"
              className="h-7 px-3 text-xs"
              disabled={!preview || mapping.every((entry) => entry.target === null)}
              onClick={() => void start()}
            >
              {t("开始导入")}
            </Button>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
