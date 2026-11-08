import { Pencil, Star, Trash2 } from "lucide-react";
import { useEffect, useState, type ReactElement } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ConnectionSummary } from "@/lib/types";
import {
  useConnectConnection,
  useDeleteConnection,
  useDisconnectConnection,
  useSetConnectionFavorite,
} from "./use-connections";

interface ConnectionCardProps {
  connection: ConnectionSummary;
  onEdit: (connection: ConnectionSummary) => void;
}

export function ConnectionCard({ connection, onEdit }: ConnectionCardProps): ReactElement {
  const connectMutation = useConnectConnection();
  const disconnectMutation = useDisconnectConnection();
  const deleteMutation = useDeleteConnection();
  const favoriteMutation = useSetConnectionFavorite();
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  useEffect(() => {
    if (!confirmingDelete) return;
    const timer = window.setTimeout(() => setConfirmingDelete(false), 3000);
    return () => window.clearTimeout(timer);
  }, [confirmingDelete]);

  const busy =
    connectMutation.isPending || disconnectMutation.isPending || deleteMutation.isPending;

  const handleDelete = (): void => {
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    deleteMutation.mutate(connection.id);
  };

  return (
    <div className="relative flex flex-col gap-2 rounded-token border border-line bg-elevated p-3 pl-4 transition-colors hover:bg-hover">
      <span
        className="absolute left-0 top-0 h-full w-1 rounded-l-token"
        style={{ background: connection.color ?? "var(--accent)" }}
        aria-hidden
      />
      <div className="flex min-w-0 items-center gap-2">
        <span
          className={cn(
            "h-2 w-2 shrink-0 rounded-full",
            connection.connected ? "bg-success" : "bg-muted/60",
          )}
          title={connection.connected ? "已连接" : "未连接"}
        />
        <span className="truncate text-[13px] font-medium" title={connection.name}>
          {connection.name}
        </span>
        {connection.readOnly && (
          <span className="shrink-0 rounded-token border border-warning/50 px-1 text-[10px] text-warning">
            只读
          </span>
        )}
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          aria-label={connection.favorite ? "取消收藏" : "收藏"}
          onClick={() =>
            favoriteMutation.mutate({ id: connection.id, favorite: !connection.favorite })
          }
        >
          <Star className={cn("h-3.5 w-3.5", connection.favorite && "fill-warning text-warning")} />
        </Button>
        <Button variant="ghost" size="icon" className="h-6 w-6" aria-label="编辑" onClick={() => onEdit(connection)}>
          <Pencil className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={cn("h-6 w-6", confirmingDelete && "text-danger")}
          aria-label={confirmingDelete ? "确认删除" : "删除"}
          onClick={handleDelete}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="truncate font-mono text-xs text-muted" title={`${connection.host ?? "—"}:${connection.port ?? "—"}/${connection.database ?? "—"}`}>
        {connection.host ?? "—"}:{connection.port ?? "—"} / {connection.database ?? "—"}
      </div>
      <div className="flex items-center gap-2">
        <span className="rounded-token bg-hover px-1.5 py-0.5 text-[10px] text-muted">
          {connection.driver}
        </span>
        {connection.groupName && (
          <span className="truncate text-[10px] text-muted">{connection.groupName}</span>
        )}
        <div className="flex-1" />
        <Button
          size="sm"
          variant={connection.connected ? "outline" : "default"}
          disabled={busy}
          onClick={() =>
            connection.connected
              ? disconnectMutation.mutate(connection.id)
              : connectMutation.mutate(connection.id)
          }
        >
          {connection.connected ? "断开" : busy ? "…" : "连接"}
        </Button>
      </div>
    </div>
  );
}
