"use client";

import { Modal } from "@/components/ui/modal";
import {
  WIDGET_META,
  WIDGET_TYPES,
  type WidgetType,
} from "@/lib/widgets/types";

/**
 * Add Widget modal. Renders the full widget catalogue as cards; clicking
 * one inserts the widget into the active tab (delegated to the parent via
 * `onPick`) and closes the modal.
 */
export function AddWidgetModal({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (type: WidgetType) => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add a widget"
      description="Pick any widget — you can resize, move, or remove it after."
    >
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {WIDGET_TYPES.map((type) => (
          <li key={type}>
            <button
              type="button"
              onClick={() => {
                onPick(type);
                onClose();
              }}
              className="border-border hover:border-primary hover:bg-muted/30 block w-full rounded-md border p-3 text-left transition-colors"
            >
              <p className="text-sm font-medium">{WIDGET_META[type].title}</p>
              <p className="text-muted-foreground text-xs">
                {WIDGET_META[type].description}
              </p>
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
