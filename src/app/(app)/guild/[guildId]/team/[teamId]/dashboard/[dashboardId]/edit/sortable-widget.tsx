"use client";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import { Button } from "@/components/ui/button";
import {
  WIDGET_META,
  type WidgetInstance,
} from "@/lib/widgets/types";
import { WidgetRender } from "@/components/widgets";

export function SortableWidget({
  widget,
  raidTeamId,
  index,
  onRemove,
}: {
  widget: WidgetInstance;
  raidTeamId: string;
  index: number;
  onRemove: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: widget.id });

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
        <Button
          size="xs"
          variant="destructive"
          onClick={() => onRemove(widget.id)}
          // Prevent drag listeners on the button from interfering with click.
          onPointerDown={(e) => e.stopPropagation()}
        >
          Remove
        </Button>
      </div>
      <WidgetRender instance={widget} raidTeamId={raidTeamId} />
    </li>
  );
}
