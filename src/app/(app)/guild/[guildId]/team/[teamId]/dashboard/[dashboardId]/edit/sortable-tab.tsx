"use client";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import type { DashboardLayout } from "@/lib/widgets/types";

type DashboardTab = DashboardLayout["tabs"][number];

/**
 * A draggable dashboard tab chip. The ⋮⋮ grip is the only drag handle (it holds
 * the dnd-kit listeners), so the select button / rename input / ✕ stay fully
 * clickable. Mirrors the SortableWidget pattern.
 */
export function SortableTab({
  tab,
  isActive,
  onSelect,
  onRename,
  onDelete,
}: {
  tab: DashboardTab;
  isActive: boolean;
  onSelect: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: tab.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-center gap-1 rounded-md border px-2 py-1 text-sm transition-colors ${
        isActive ? "border-primary bg-muted" : "border-border bg-background"
      }`}
    >
      <span
        {...attributes}
        {...listeners}
        aria-label={`Drag to reorder tab ${tab.name}`}
        className="text-muted-foreground hover:text-foreground -ml-0.5 cursor-grab touch-none leading-none select-none active:cursor-grabbing"
      >
        ⋮⋮
      </span>
      <button type="button" onClick={onSelect} className="font-medium">
        {tab.name}{" "}
        <span className="text-muted-foreground text-xs">
          ({tab.widgets.length})
        </span>
      </button>
      {isActive && (
        <>
          <input
            aria-label="Rename tab"
            value={tab.name}
            onChange={(e) => onRename(e.target.value)}
            className="bg-background border-border h-6 w-24 rounded border px-1 text-xs"
          />
          <button
            type="button"
            onClick={onDelete}
            className="text-muted-foreground hover:text-destructive ml-1 text-xs"
            aria-label={`Delete tab ${tab.name}`}
          >
            ✕
          </button>
        </>
      )}
    </div>
  );
}
