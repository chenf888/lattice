import { RotateCw, X } from "lucide-react";
import { useEffect, useState, type ReactElement } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input, Select } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { api } from "@/lib/ipc";
import { TEST_ERROR_LABEL, type ConnectionSummary, type SslMode } from "@/lib/types";
import { toast, toastError } from "@/stores/toast";
import { useCreateConnection, useUpdateConnection } from "./use-connections";

interface ConnectionFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: ConnectionSummary | null;
}

const SSL_MODES: ReadonlyArray<{ value: SslMode; label: string }> = [
  { value: "prefer", label: "prefer（优先 TLS，失败回退明文）" },
  { value: "disable", label: "disable（明文）" },
  { value: "require", label: "require（强制 TLS）" },
  { value: "verify-ca", label: "verify-ca（校验证书链）" },
  { value: "verify-full", label: "verify-full（校验证书与主机名）" },
];

const DEFAULT_COLOR = "#4F8CFF";
const COLORS: readonly string[] = ["#4F8CFF", "#3FB950", "#D29922", "#F85149", "#A371F7", "#8B93A1"];

interface FormState {
  name: string;
  host: string;
  port: string;
  database: string;
  username: string;
  password: string;
  sslMode: SslMode;
  color: string;
  groupName: string;
  readOnly: boolean;
}

function toFormState(editing: ConnectionSummary | null): FormState {
  if (!editing) {
    return {
      name: "",
      host: "127.0.0.1",
      port: "5432",
      database: "postgres",
      username: "postgres",
      password: "",
      sslMode: "prefer",
      color: DEFAULT_COLOR,
      groupName: "",
      readOnly: false,
    };
  }
  return {
    name: editing.name,
    host: editing.host ?? "127.0.0.1",
    port: String(editing.port ?? 5432),
    database: editing.database ?? "",
    username: editing.username ?? "",
    password: "",
    sslMode: (editing.sslMode as SslMode) ?? "prefer",
    color: editing.color ?? DEFAULT_COLOR,
    groupName: editing.groupName ?? "",
    readOnly: editing.readOnly,
  };
}

const FIELD_LABEL = "text-xs text-muted";

export function ConnectionForm({ open, onOpenChange, editing }: ConnectionFormProps): ReactElement {
  const createMutation = useCreateConnection();
  const updateMutation = useUpdateConnection();
  const [form, setForm] = useState<FormState>(() => toFormState(editing));
  const [testing, setTesting] = useState(false);

  // 打开/切换编辑对象时重置表单
  useEffect(() => {
    if (open) {
      setForm(toFormState(editing));
    }
  }, [open, editing]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]): void => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const buildInput = () => ({
    name: form.name.trim(),
    driver: "postgres" as const,
    host: form.host.trim() || "127.0.0.1",
    port: Number(form.port) || 5432,
    database: form.database.trim(),
    username: form.username.trim(),
    // 密码留空 = 编辑时保留原凭据
    password: form.password ? form.password : null,
    sslMode: form.sslMode,
    color: form.color || null,
    groupName: form.groupName.trim() || null,
    readOnly: form.readOnly,
  });

  const close = (): void => onOpenChange(false);

  const handleSave = (): void => {
    const input = buildInput();
    if (editing) {
      updateMutation.mutate(
        { id: editing.id, input },
        {
          onSuccess: () => {
            toast.success("连接已更新");
            close();
          },
        },
      );
    } else {
      createMutation.mutate(input, {
        onSuccess: () => {
          toast.success("连接已创建");
          close();
        },
      });
    }
  };

  const handleTest = (): void => {
    setTesting(true);
    api
      .testConnection(buildInput(), editing?.id ?? null)
      .then((result) => {
        if (result.ok) {
          toast.success(`连接成功（${result.latencyMs}ms）`);
        } else if (result.error) {
          toast.error(`${TEST_ERROR_LABEL[result.error.kind]}：${result.error.message}`);
        }
      })
      .catch(toastError)
      .finally(() => setTesting(false));
  };

  const saving = createMutation.isPending || updateMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined}>
        <div className="flex items-start justify-between">
          <div>
            <DialogTitle>{editing ? "编辑连接" : "新建连接"}</DialogTitle>
            <DialogDescription>密码仅存于系统钥匙串，不会写入应用数据库</DialogDescription>
          </div>
          <Button variant="ghost" size="icon" className="h-6 w-6" aria-label="关闭" onClick={close}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <form
          className="mt-4 grid grid-cols-2 gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            handleSave();
          }}
        >
          <label className="grid gap-1">
            <span className={FIELD_LABEL}>名称 *</span>
            <Input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="本地开发库" autoFocus />
          </label>
          <label className="grid gap-1">
            <span className={FIELD_LABEL}>驱动</span>
            <Select value="postgres" disabled>
              <option value="postgres">PostgreSQL</option>
            </Select>
          </label>
          <label className="grid gap-1">
            <span className={FIELD_LABEL}>主机</span>
            <Input value={form.host} onChange={(e) => set("host", e.target.value)} placeholder="127.0.0.1" />
          </label>
          <label className="grid gap-1">
            <span className={FIELD_LABEL}>端口</span>
            <Input
              value={form.port}
              onChange={(e) => set("port", e.target.value)}
              inputMode="numeric"
              placeholder="5432"
            />
          </label>
          <label className="grid gap-1">
            <span className={FIELD_LABEL}>数据库 *</span>
            <Input value={form.database} onChange={(e) => set("database", e.target.value)} placeholder="postgres" />
          </label>
          <label className="grid gap-1">
            <span className={FIELD_LABEL}>用户名</span>
            <Input value={form.username} onChange={(e) => set("username", e.target.value)} placeholder="postgres" />
          </label>
          <label className="grid gap-1">
            <span className={FIELD_LABEL}>
              密码{editing && <span className="text-muted/70">（留空保留原密码）</span>}
            </span>
            <Input
              type="password"
              autoComplete="new-password"
              value={form.password}
              onChange={(e) => set("password", e.target.value)}
              placeholder="••••••••"
            />
          </label>
          <label className="grid gap-1">
            <span className={FIELD_LABEL}>SSL 模式</span>
            <Select value={form.sslMode} onChange={(e) => set("sslMode", e.target.value as SslMode)}>
              {SSL_MODES.map((mode) => (
                <option key={mode.value} value={mode.value}>
                  {mode.label}
                </option>
              ))}
            </Select>
          </label>
          <label className="grid gap-1">
            <span className={FIELD_LABEL}>分组</span>
            <Input value={form.groupName} onChange={(e) => set("groupName", e.target.value)} placeholder="开发 / 生产…" />
          </label>
          <div className="grid gap-1">
            <span className={FIELD_LABEL}>颜色标签</span>
            <div className="flex h-[var(--ctl-h)] items-center gap-1.5">
              {COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  aria-label={`颜色 ${color}`}
                  aria-pressed={form.color === color}
                  onClick={() => set("color", color)}
                  className={cn(
                    "h-5 w-5 rounded-full border-2 transition-transform",
                    form.color === color ? "scale-110 border-fg" : "border-transparent hover:scale-105",
                  )}
                  style={{ background: color }}
                />
              ))}
            </div>
          </div>
          <label className="col-span-2 flex items-center gap-2 text-[13px]">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-[var(--accent)]"
              checked={form.readOnly}
              onChange={(e) => set("readOnly", e.target.checked)}
            />
            只读模式（拦截所有写操作，阶段三执行 SQL 时强制生效）
          </label>

          <div className="col-span-2 mt-1 flex items-center gap-2">
            <Button type="button" variant="outline" disabled={testing} onClick={handleTest}>
              <RotateCw className={cn("h-3.5 w-3.5", testing && "animate-spin")} />
              {testing ? "测试中…" : "测试连接"}
            </Button>
            <div className="flex-1" />
            <Button type="button" variant="ghost" onClick={close}>
              取消
            </Button>
            <Button type="submit" disabled={saving || !form.name.trim() || !form.database.trim()}>
              {saving ? "保存中…" : "保存"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
