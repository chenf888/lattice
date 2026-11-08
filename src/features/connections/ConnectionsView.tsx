import { Database, Plus, RotateCw, Search } from "lucide-react";
import { useMemo, useState, type ReactElement } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ConnectionSummary } from "@/lib/types";
import { ConnectionCard } from "./ConnectionCard";
import { ConnectionForm } from "./ConnectionForm";
import { useConnections } from "./use-connections";

function matchesSearch(connection: ConnectionSummary, query: string): boolean {
  if (!query) return true;
  const haystacks = [connection.name, connection.host ?? "", connection.database ?? "", connection.groupName ?? ""];
  return haystacks.some((value) => value.toLowerCase().includes(query));
}

export function ConnectionsView(): ReactElement {
  const { data: connections, isPending, isError, refetch } = useConnections();
  const [search, setSearch] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ConnectionSummary | null>(null);

  const groups = useMemo(() => {
    const query = search.trim().toLowerCase();
    const matched = (connections ?? []).filter((connection) =>
      matchesSearch(connection, query),
    );
    const map = new Map<string, ConnectionSummary[]>();
    for (const connection of matched) {
      const key = connection.groupName ?? "";
      const list = map.get(key) ?? [];
      list.push(connection);
      map.set(key, list);
    }
    for (const list of map.values()) {
      list.sort(
        (a, b) =>
          Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name),
      );
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [connections, search]);

  const openCreate = (): void => {
    setEditing(null);
    setFormOpen(true);
  };
  const openEdit = (connection: ConnectionSummary): void => {
    setEditing(connection);
    setFormOpen(true);
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl p-2">
        <div className="mb-4 flex items-center gap-3">
          <h1 className="text-[15px] font-semibold">连接</h1>
          <span className="text-xs text-muted">{connections?.length ?? 0} 个数据源</span>
          <div className="flex-1" />
          <div className="relative w-56">
            <Search
              className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted"
              aria-hidden
            />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索连接…"
              className="pl-7"
              aria-label="搜索连接"
            />
          </div>
          <Button onClick={openCreate}>
            <Plus className="h-3.5 w-3.5" />
            新建连接
          </Button>
        </div>

        {isPending ? (
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(300px,1fr))]">
            {[0, 1, 2].map((index) => (
              <div key={index} className="h-[104px] animate-pulse rounded-token border border-line bg-elevated" />
            ))}
          </div>
        ) : isError ? (
          <div className="flex flex-col items-center justify-center gap-3 py-16">
            <p className="text-[13px] text-danger">连接列表加载失败</p>
            <Button variant="outline" onClick={() => void refetch()}>
              <RotateCw className="h-3.5 w-3.5" />
              重试
            </Button>
          </div>
        ) : (connections?.length ?? 0) === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-xl border border-line bg-elevated">
              <Database className="h-7 w-7 text-accent" aria-hidden />
            </div>
            <p className="text-[15px] font-medium">暂无连接</p>
            <p className="mt-1 max-w-sm text-xs text-muted">
              创建一个 PostgreSQL 连接开始探索：左侧边栏将展示库、Schema 与对象树，后续阶段支持在编辑器中执行 SQL。
            </p>
            <Button className="mt-5" onClick={openCreate}>
              <Plus className="h-3.5 w-3.5" />
              新建连接
            </Button>
          </div>
        ) : (
          groups.map(([group, list]) => (
            <section key={group || "_default"} className="mb-6">
              {group && <h2 className="mb-2 text-xs font-medium text-muted">{group}</h2>}
              <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(300px,1fr))]">
                {list.map((connection) => (
                  <ConnectionCard
                    key={connection.id}
                    connection={connection}
                    onEdit={openEdit}
                  />
                ))}
              </div>
            </section>
          ))
        )}
      </div>

      <ConnectionForm open={formOpen} onOpenChange={setFormOpen} editing={editing} />
    </div>
  );
}
