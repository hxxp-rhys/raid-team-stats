"use client";

import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import {
  WIDGET_ADDON_DEPENDENCE,
  WIDGET_CATEGORIES,
  WIDGET_CATEGORY,
  WIDGET_INFO,
  WIDGET_META,
  WIDGET_TYPES,
  type AddonDependence,
  type WidgetType,
} from "@/lib/widgets/types";

/**
 * Add Widget picker. Widgets are grouped into category COLUMNS that auto-fit
 * the window (CSS grid auto-fit). Each widget has a checkbox; tick several and
 * the footer "Add" button inserts them all in one go. Clicking a widget's name
 * opens an info lightbox explaining what it tracks, how it's shown, how to read
 * it, and any cautions.
 */
export function AddWidgetModal({
  open,
  onClose,
  onAdd,
}: {
  open: boolean;
  onClose: () => void;
  onAdd: (types: WidgetType[]) => void;
}) {
  const [selected, setSelected] = useState<Set<WidgetType>>(new Set());
  const [infoType, setInfoType] = useState<WidgetType | null>(null);

  // Reset on close so the picker opens fresh next time (avoids a
  // set-state-in-effect; every close path routes through here).
  const closePicker = () => {
    setSelected(new Set());
    setInfoType(null);
    onClose();
  };

  const byCategory = useMemo(
    () =>
      WIDGET_CATEGORIES.map((c) => ({
        ...c,
        types: WIDGET_TYPES.filter((t) => WIDGET_CATEGORY[t] === c.id),
      })),
    [],
  );

  const toggle = (t: WidgetType) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });

  const count = selected.size;
  const add = () => {
    if (count === 0) return;
    onAdd([...selected]);
    closePicker();
  };

  return (
    <>
      <Modal
        open={open}
        // While the info lightbox is open, Escape/backdrop closes IT first.
        onClose={() => {
          if (infoType != null) setInfoType(null);
          else closePicker();
        }}
        title="Add widgets"
        description="Browse by category, tick the ones you want, then add them all at once. Click a widget's name to learn what it does."
        className="max-w-6xl"
        hideDefaultFooter
        showCloseIcon
      >
        <div
          className="grid gap-x-5 gap-y-4"
          style={{ gridTemplateColumns: "repeat(auto-fit, minmax(13rem, 1fr))" }}
        >
          {byCategory.map((cat) => (
            <section key={cat.id} className="space-y-1.5">
              <h3 className="text-muted-foreground border-border border-b pb-1 text-[11px] font-semibold uppercase tracking-wide">
                {cat.label}
              </h3>
              <ul className="space-y-1">
                {cat.types.map((type) => {
                  const checked = selected.has(type);
                  return (
                    <li
                      key={type}
                      className={`flex items-center gap-2 rounded-md border p-1.5 transition-colors ${
                        checked
                          ? "border-primary bg-primary/5"
                          : "border-border hover:bg-muted/30"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggle(type)}
                        aria-label={`Select ${WIDGET_META[type].title}`}
                        className="accent-primary size-3.5 shrink-0 cursor-pointer"
                      />
                      <button
                        type="button"
                        onClick={() => setInfoType(type)}
                        className="min-w-0 flex-1 text-left"
                        title="What does this track?"
                      >
                        <span className="flex items-center gap-1 text-xs font-medium">
                          <span className="truncate">
                            {WIDGET_META[type].title}
                          </span>
                          <AddonGlyph dependence={WIDGET_ADDON_DEPENDENCE[type]} />
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>

        {/* Sticky multi-add footer (stays visible while the grid scrolls). */}
        <div className="bg-card sticky bottom-0 -mx-5 mt-3 flex items-center justify-between gap-3 border-t px-5 pb-1 pt-3">
          <span className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
            <span>{count} selected · click a name for details</span>
            <span className="text-[10px]">
              <span aria-hidden>🧩</span> needs the addon ·{" "}
              <span aria-hidden className="opacity-50">
                🧩
              </span>{" "}
              partly needs the addon
            </span>
          </span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={closePicker}>
              Cancel
            </Button>
            <Button size="sm" onClick={add} disabled={count === 0}>
              {count > 0 ? `Add ${count}` : "Add"}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Per-widget info lightbox. */}
      <Modal
        open={infoType != null}
        onClose={() => setInfoType(null)}
        title={infoType ? WIDGET_META[infoType].title : ""}
        className="max-w-lg"
        hideDefaultFooter
        showCloseIcon
      >
        {infoType && (
          <div className="space-y-3">
            <InfoBlock label="What it tracks" text={WIDGET_INFO[infoType].tracks} />
            <InfoBlock label="How it's shown" text={WIDGET_INFO[infoType].displayed} />
            <InfoBlock label="How to read it" text={WIDGET_INFO[infoType].interpret} />
            <InfoBlock label="Cautions" text={WIDGET_INFO[infoType].cautions} caution />
            <div className="border-border flex justify-end gap-2 border-t pt-3">
              <Button variant="outline" size="sm" onClick={() => setInfoType(null)}>
                Close
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  const t = infoType;
                  toggle(t);
                  setInfoType(null);
                }}
              >
                {selected.has(infoType) ? "Deselect" : "Select"}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}

/**
 * Small addon-dependence glyph shown next to a widget title. A solid puzzle
 * piece means every field comes from the Raid Team Stats addon + companion;
 * a faded one means only some data needs the addon (the rest is Blizzard/WCL).
 * Widgets fully served without the addon render nothing.
 */
function AddonGlyph({ dependence }: { dependence: AddonDependence }) {
  if (dependence === "none") return null;
  const isAll = dependence === "all";
  return (
    <span
      aria-label={
        isAll
          ? "All of this widget's data comes from the Raid Team Stats addon + companion uploader."
          : "Some of this widget's data needs the Raid Team Stats addon; the rest is from Blizzard/WCL."
      }
      title={
        isAll
          ? "All of this widget's data comes from the Raid Team Stats addon + companion uploader."
          : "Some of this widget's data needs the Raid Team Stats addon; the rest is from Blizzard/WCL."
      }
      className={`shrink-0 text-[10px] leading-none ${isAll ? "" : "opacity-50"}`}
    >
      🧩
    </span>
  );
}

function InfoBlock({
  label,
  text,
  caution,
}: {
  label: string;
  text: string;
  caution?: boolean;
}) {
  return (
    <div>
      <p
        className={`text-[11px] font-semibold uppercase ${
          caution ? "text-amber-500" : "text-muted-foreground"
        }`}
      >
        {label}
      </p>
      <p className="text-sm leading-snug">{text}</p>
    </div>
  );
}
