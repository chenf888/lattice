/** 标签条：HTML5 拖拽排序、中键关闭、未保存圆点、关闭按钮 */

import { X } from "lucide-react";
import { useState, type DragEvent, type ReactElement } from "react";

import { cn } from "@/lib/utils";
import { isTabDirty, type EditorTab } from "@/stores/tabs";

export interface EditorTabsBarProps {
  tabs: EditorTab[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onReorder: (from: number, to: number) => void;
}

export function EditorTabsBar({
  tabs,
  activeId,
  onSelect,
  onClose,
  onReorder,
}: EditorTabsBarProps): ReactElement {
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  const onDrop = (event: DragEvent<HTMLButtonElement>, to: number): void => {
    event.preventDefault();
    if (dragFrom !== null && dragFrom !== to) {
      onReorder(dragFrom, to);
    }
    setDragFrom(null);
    setDragOver(null);
  };

  return (
    <div
      className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-line bg-elevated"
      role="tablist"
      aria-label="查询标签"
    >
      {tabs.map((tab, index) => {
        const active = tab.id === activeId;
        const dirty = isTabDirty(tab);
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            draggable
            onDragStart={() => setDragFrom(index)}
            onDragOver={(event) => {
              event.preventDefault();
              setDragOver(index);
            }}
            onDragLeave={() => setDragOver((current) => (current === index ? null : current))}
            onDrop={(event) => onDrop(event, index)}
            onDragEnd={() => {
              setDragFrom(null);
              setDragOver(null);
            }}
            className={cn(
              "group relative flex max-w-[220px] shrink-0 items-center gap-1.5 border-r border-line px-3 text-[12.5px]",
              "transition-colors duration-150 ease-out",
              active ? "bg-base text-fg" : "text-muted hover:bg-hover hover:text-fg",
              dragOver === index && dragFrom !== null && dragFrom !== index && "border-l-2 border-l-accent",
            )}
            onClick={() => onSelect(tab.id)}
            onAuxClick={(event) => {
              // 中键关闭
              if (event.button === 1) {
                event.preventDefault();
                onClose(tab.id);
              }
            }}
            title={tab.title}
          >
            <span className="min-w-0 truncate">{tab.title}</span>
            {dirty && (
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                aria-label="未保存"
                aria-hidden
              />
            )}
            <span
              role="button"
              tabIndex={-1}
              aria-label={`关闭 ${tab.title}`}
              className="ml-0.5 rounded p-0.5 opacity-0 hover:bg-active group-hover:opacity-100"
              onClick={(event) => {
                event.stopPropagation();
                onClose(tab.id);
              }}
            >
              <X className="h-3 w-3" aria-hidden />
            </span>
            {active && <span className="absolute inset-x-0 top-0 h-0.5 bg-accent" aria-hidden />}
          </button>
        );
      })}
    </div>
  );
}
