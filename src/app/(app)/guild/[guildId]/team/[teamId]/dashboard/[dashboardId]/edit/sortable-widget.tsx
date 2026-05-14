"use client";

import { useState } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import { Button } from "@/components/ui/button";
import {
  WIDGET_META,
  isConfigurable,
  type WidgetInstance,
} from "@/lib/widgets/types";
import { WidgetRender } from "@/components/widgets";
import { WidgetConfigEditor } from "./widget-config";

export function SortableWidget({
  widget,
  raidTeamId,
  index,
  onRemove,
  onConfigChange,
}: {
  widget: WidgetInstance;
  raidTeamId: string;
  index: number;
  onRemove: (id: string) => void;
  onConfigChange: (id: string, config: Record<string, unknown>) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: widget.id });
  const [editing, setEditing] = useState(false);

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };

  return (
    <li ref={setNodeRef} style={style} className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-2 text-xs"
          {...attributes}
          {...listeners}
          aria-label="Drag to reorder"
        >
          <span aria-hidden="true">⋮⋮</span>
          {index + 1}. {WIDGET_META[widget.type].title}
        </button>
        <div className="flex gap-1">
          {isConfigurable(widget.type) && (
            <Button
              size="xs"
              variant="outline"
              onClick={() => setEditing((v) => !v)}
              onPointerDown={(e) => e.stopPropagation()}
            >
              {editing ? "Close" : "Configure"}
            </Button>
          )}
          <Button
            size="xs"
            variant="destructive"
            onClick={() => onRemove(widget.id)}
            onPointerDown={(e) => e.stopPropagation()}
          >
            Remove
          </Button>
        </div>
      </div>
      {editing && (
        <WidgetConfigEditor
          raidTeamId={raidTeamId}
          widget={widget}
          onChange={(config) => onConfigChange(widget.id, config)}
          onClose={() => setEditing(false)}
        />
      )}
      <WidgetRender instance={widget} raidTeamId={raidTeamId} />
    </li>
  );
}
