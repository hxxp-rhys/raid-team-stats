"use client";

import { memo, useEffect, useRef, useState } from "react";

import { WidgetRender } from "@/components/widgets";
import {
  DESKTOP_GRID_COLS,
  MOBILE_GRID_COLS,
  DEFAULT_WIDGET_COLS,
  DEFAULT_WIDGET_ROWS,
  MAX_WIDGET_ROWS,
  ROW_HEIGHT_PX,
  type WidgetInstance,
} from "@/lib/widgets/types";
import { cn } from "@/lib/utils";

/**
 * One widget in the grid.
 *
 * Edit mode adds three affordances:
 *  - W/H steppers (top-left) — discrete size control, one grid cell per click.
 *  - Drag handle (bottom-right) — pointer-drag to resize. Hold Shift for
 *    uniform (aspect-preserving) scaling.
 *  - Move handle (✥, top, after the steppers) — pointer-drag the whole
 *    widget to any grid cell. On drop the widget gets explicit x/y.
 *
 * The grid is 48 cols (desktop) / 16 (mobile) with 24px row bands, so every
 * action snaps to a quarter-of-old-cell increment.
 */
export const WidgetCell = memo(function WidgetCell({
  widget,
  raidTeamId,
  editing,
  isMobile,
  stacked = false,
  onRemove,
  onResize,
  onMove,
  onMovePreview,
  onResizePreview,
  onReorder,
  reorderDisabled,
}: {
  widget: WidgetInstance;
  raidTeamId: string;
  editing: boolean;
  isMobile: boolean;
  /**
   * Mobile-stack mode: render as a full-width block in a vertical flow
   * (modern phone layout) instead of a free 2D grid cell. Editing swaps
   * the move/resize affordances for ↑/↓ reorder + height steppers.
   */
  stacked?: boolean;
  onRemove?: (id: string) => void;
  onResize?: (id: string, cols: number, rows: number) => void;
  onMove?: (id: string, x: number, y: number) => void;
  /**
   * Live-preview reporters — fired on every drag/resize step (not just on
   * commit) so the parent can run the push engine and shift the other widgets
   * in real time.
   */
  onMovePreview?: (id: string, x: number, y: number) => void;
  onResizePreview?: (id: string, cols: number, rows: number) => void;
  onReorder?: (id: string, dir: -1 | 1) => void;
  reorderDisabled?: { up: boolean; down: boolean };
}) {
  const gridCols = isMobile ? MOBILE_GRID_COLS : DESKTOP_GRID_COLS;
  const requestedCols = widget.cols ?? DEFAULT_WIDGET_COLS;
  const cols = Math.min(Math.max(1, requestedCols), gridCols);
  const rows = widget.rows ?? DEFAULT_WIDGET_ROWS;

  const ref = useRef<HTMLDivElement>(null);

  // Latest callbacks in refs so the drag/resize listener effects never need to
  // re-subscribe when the parent re-renders (it recreates these each render —
  // especially during a live-preview drag, which re-renders the parent on every
  // pointer step).
  const onMoveRef = useRef(onMove);
  const onMovePreviewRef = useRef(onMovePreview);
  const onResizePreviewRef = useRef(onResizePreview);
  useEffect(() => {
    onMoveRef.current = onMove;
    onMovePreviewRef.current = onMovePreview;
    onResizePreviewRef.current = onResizePreview;
  }, [onMove, onMovePreview, onResizePreview]);

  // ── Resize drag ──────────────────────────────────────────────────────────
  const resizeState = useRef<{
    startX: number;
    startY: number;
    startScrollX: number;
    startScrollY: number;
    startCols: number;
    startRows: number;
    uniform: boolean;
    cellWidth: number;
  } | null>(null);
  const [resizeDrag, setResizeDrag] = useState<{
    cols: number;
    rows: number;
  } | null>(null);

  useEffect(() => {
    if (!resizeDrag) return;
    const onMoveEv = (e: PointerEvent) => {
      const s = resizeState.current;
      if (!s) return;
      // Add the page-scroll delta so a resize tracks the cursor even if the
      // page scrolls mid-drag (clientX/Y are viewport-relative).
      const dx = e.clientX - s.startX + (window.scrollX - s.startScrollX);
      const dy = e.clientY - s.startY + (window.scrollY - s.startScrollY);
      const deltaCols = Math.round(dx / s.cellWidth);
      const deltaRows = Math.round(dy / ROW_HEIGHT_PX);
      let nextCols = Math.min(gridCols, Math.max(1, s.startCols + deltaCols));
      let nextRows = Math.min(
        MAX_WIDGET_ROWS,
        Math.max(1, s.startRows + deltaRows),
      );
      if (s.uniform) {
        const factor = Math.max(
          (s.startCols + deltaCols) / s.startCols,
          (s.startRows + deltaRows) / s.startRows,
        );
        nextCols = Math.min(
          gridCols,
          Math.max(1, Math.round(s.startCols * factor)),
        );
        nextRows = Math.min(
          MAX_WIDGET_ROWS,
          Math.max(1, Math.round(s.startRows * factor)),
        );
      }
      setResizeDrag({ cols: nextCols, rows: nextRows });
      // Live-preview the push as the widget grows/shrinks (Grafana).
      onResizePreviewRef.current?.(widget.id, nextCols, nextRows);
    };
    const onUp = () => {
      if (resizeDrag && onResize)
        onResize(widget.id, resizeDrag.cols, resizeDrag.rows);
      setResizeDrag(null);
      resizeState.current = null;
      window.removeEventListener("pointermove", onMoveEv);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMoveEv);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMoveEv);
      window.removeEventListener("pointerup", onUp);
    };
  }, [resizeDrag, gridCols, widget.id, onResize]);

  const startResize = (e: React.PointerEvent) => {
    if (!editing) return;
    e.preventDefault();
    e.stopPropagation();
    const el = ref.current;
    if (!el) return;
    const parent = el.parentElement;
    const containerWidth =
      parent?.clientWidth ?? el.offsetWidth * (gridCols / cols);
    resizeState.current = {
      startX: e.clientX,
      startY: e.clientY,
      startScrollX: window.scrollX,
      startScrollY: window.scrollY,
      startCols: cols,
      startRows: rows,
      uniform: e.shiftKey,
      cellWidth: containerWidth / gridCols,
    };
    setResizeDrag({ cols, rows });
  };

  // ── Move drag ────────────────────────────────────────────────────────────
  const moveState = useRef<{
    startClientX: number;
    startClientY: number;
    startScrollX: number;
    startScrollY: number;
    startCol: number;
    startRow: number;
    cellWidth: number;
    cols: number;
    lastClientX: number;
    lastClientY: number;
    curX: number;
    curY: number;
  } | null>(null);
  const [moveDrag, setMoveDrag] = useState<{ x: number; y: number } | null>(
    null,
  );
  // Boolean gate for the listener effect — it must subscribe ONCE per drag, not
  // re-subscribe on every position change (which would restart the rAF loop).
  const [moving, setMoving] = useState(false);

  useEffect(() => {
    if (!moving) return;
    let raf = 0;
    const apply = (clientX: number, clientY: number) => {
      const s = moveState.current;
      if (!s) return;
      // Document-space delta: add the page-scroll change so the widget tracks
      // the cursor even when the page scrolls mid-drag (clientX/Y are
      // viewport-relative — without this the widget drifts as you scroll).
      const dx = clientX - s.startClientX + (window.scrollX - s.startScrollX);
      const dy = clientY - s.startClientY + (window.scrollY - s.startScrollY);
      const nextX = Math.min(
        gridCols - s.cols,
        Math.max(0, s.startCol + Math.round(dx / s.cellWidth)),
      );
      const nextY = Math.max(0, s.startRow + Math.round(dy / ROW_HEIGHT_PX));
      if (nextX !== s.curX || nextY !== s.curY) {
        s.curX = nextX;
        s.curY = nextY;
        setMoveDrag({ x: nextX, y: nextY });
        // Tell the parent so it can push the other widgets live (Grafana).
        onMovePreviewRef.current?.(widget.id, nextX, nextY);
      }
    };
    const onMoveEv = (e: PointerEvent) => {
      const s = moveState.current;
      if (!s) return;
      s.lastClientX = e.clientX;
      s.lastClientY = e.clientY;
      apply(e.clientX, e.clientY);
    };
    // Auto-scroll when the pointer nears the top/bottom viewport edge, so a
    // widget can be dragged beyond what's on screen (e.g. one at the very
    // bottom). rAF keeps scrolling while the pointer is held at the edge and
    // re-applies the position each scrolled frame.
    const EDGE = 60;
    const tick = () => {
      const s = moveState.current;
      if (s) {
        const vh = window.innerHeight;
        let sy = 0;
        if (s.lastClientY < EDGE) {
          sy = -Math.ceil((EDGE - s.lastClientY) / 5) - 2;
        } else if (s.lastClientY > vh - EDGE) {
          sy = Math.ceil((s.lastClientY - (vh - EDGE)) / 5) + 2;
        }
        if (sy !== 0) {
          const before = window.scrollY;
          window.scrollBy(0, sy);
          if (window.scrollY !== before) apply(s.lastClientX, s.lastClientY);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const onUp = () => {
      const s = moveState.current;
      if (s && onMoveRef.current) onMoveRef.current(widget.id, s.curX, s.curY);
      cancelAnimationFrame(raf);
      moveState.current = null;
      setMoving(false);
      setMoveDrag(null);
      window.removeEventListener("pointermove", onMoveEv);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMoveEv);
    window.addEventListener("pointerup", onUp);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onMoveEv);
      window.removeEventListener("pointerup", onUp);
    };
  }, [moving, gridCols, widget.id]);

  const startMove = (e: React.PointerEvent) => {
    if (!editing) return;
    e.preventDefault();
    e.stopPropagation();
    const el = ref.current;
    if (!el) return;
    const parent = el.parentElement;
    const containerWidth = parent?.clientWidth ?? el.offsetWidth;
    const startCol = widget.x ?? 0;
    const startRow = widget.y ?? 0;
    moveState.current = {
      startClientX: e.clientX,
      startClientY: e.clientY,
      startScrollX: window.scrollX,
      startScrollY: window.scrollY,
      startCol,
      startRow,
      cellWidth: containerWidth / gridCols,
      cols,
      lastClientX: e.clientX,
      lastClientY: e.clientY,
      curX: startCol,
      curY: startRow,
    };
    setMoveDrag({ x: startCol, y: startRow });
    setMoving(true);
  };

  // ── Rendered geometry ────────────────────────────────────────────────────
  const renderedCols = resizeDrag?.cols ?? cols;
  const renderedRows = resizeDrag?.rows ?? rows;
  const renderedX = moveDrag?.x ?? widget.x;
  const renderedY = moveDrag?.y ?? widget.y;
  const placed = typeof renderedX === "number" && typeof renderedY === "number";

  const style: React.CSSProperties = stacked
    ? // Stack flow: width comes from the container; rows only set height.
      { minHeight: `${ROW_HEIGHT_PX * renderedRows}px` }
    : placed
      ? {
          gridColumn: `${renderedX! + 1} / span ${renderedCols}`,
          gridRow: `${renderedY! + 1} / span ${renderedRows}`,
          minHeight: `${ROW_HEIGHT_PX * renderedRows}px`,
        }
      : {
          gridColumn: `span ${renderedCols} / span ${renderedCols}`,
          gridRow: `span ${renderedRows} / span ${renderedRows}`,
          minHeight: `${ROW_HEIGHT_PX * renderedRows}px`,
        };

  return (
    <div
      ref={ref}
      className={cn(
        "group/widget relative flex flex-col overflow-hidden rounded-lg",
        editing && "ring-border ring-1",
        (resizeDrag || moveDrag) && "ring-primary z-20 ring-2",
      )}
      style={style}
    >
      {/* Edit toolbar — an in-flow strip ABOVE the widget so the widget's
          own title can never sit under it (works at any width; the strip
          wraps and the content simply starts below it). */}
      {editing && stacked && (
        <div className="border-border bg-muted/60 flex flex-wrap items-center gap-1 border-b px-1.5 py-1 text-[10px]">
          <button
            type="button"
            aria-label="Move widget up"
            title="Move up in the stack"
            disabled={reorderDisabled?.up}
            onClick={() => onReorder?.(widget.id, -1)}
            className="hover:text-primary disabled:opacity-30 inline-flex size-6 items-center justify-center rounded border border-border text-sm"
          >
            ↑
          </button>
          <button
            type="button"
            aria-label="Move widget down"
            title="Move down in the stack"
            disabled={reorderDisabled?.down}
            onClick={() => onReorder?.(widget.id, 1)}
            className="hover:text-primary disabled:opacity-30 inline-flex size-6 items-center justify-center rounded border border-border text-sm"
          >
            ↓
          </button>
          <span className="text-muted-foreground">·</span>
          <Stepper
            label="H"
            value={rows}
            min={1}
            max={MAX_WIDGET_ROWS}
            onChange={(v) => onResize?.(widget.id, cols, v)}
          />
          <button
            type="button"
            onClick={() => onRemove?.(widget.id)}
            title="Remove widget"
            aria-label="Remove widget"
            className="text-foreground/60 hover:text-destructive ml-auto inline-flex size-5 items-center justify-center rounded-full border border-border"
          >
            ×
          </button>
        </div>
      )}

      {editing && !stacked && (
        <div className="border-border bg-muted/60 flex flex-wrap items-center gap-1 border-b px-1.5 py-1 text-[10px]">
          <button
            type="button"
            aria-label="Move widget"
            title="Drag to move this widget anywhere on the grid"
            onPointerDown={startMove}
            className="text-primary hover:bg-primary/10 inline-flex cursor-grab touch-none items-center gap-1 rounded px-1 py-0.5 active:cursor-grabbing"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden>
              <path
                d="M8 1 L8 15 M1 8 L15 8 M8 1 L6 3 M8 1 L10 3 M8 15 L6 13 M8 15 L10 13 M1 8 L3 6 M1 8 L3 10 M15 8 L13 6 M15 8 L13 10"
                stroke="currentColor"
                strokeWidth="1.5"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span>Move</span>
          </button>
          <span className="text-muted-foreground">·</span>
          <Stepper
            label="W"
            value={cols}
            min={1}
            max={gridCols}
            onChange={(v) => onResize?.(widget.id, v, rows)}
          />
          <span className="text-muted-foreground">·</span>
          <Stepper
            label="H"
            value={rows}
            min={1}
            max={MAX_WIDGET_ROWS}
            onChange={(v) => onResize?.(widget.id, cols, v)}
          />
          <button
            type="button"
            onClick={() => onRemove?.(widget.id)}
            title="Remove widget"
            aria-label="Remove widget"
            className="text-foreground/60 hover:text-destructive ml-auto inline-flex size-5 items-center justify-center rounded-full border border-border"
          >
            ×
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 [&>*]:h-full">
        <WidgetRender instance={widget} raidTeamId={raidTeamId} />
      </div>

      {editing && !stacked && (
        <>
          <div
            role="slider"
            aria-label="Resize widget (hold Shift for uniform)"
            aria-valuenow={renderedCols}
            aria-valuemin={1}
            aria-valuemax={gridCols}
            tabIndex={0}
            onPointerDown={startResize}
            title="Drag to resize · hold Shift for uniform scaling"
            className="text-primary/60 hover:text-primary absolute bottom-0 right-0 z-10 flex size-6 cursor-se-resize touch-none items-end justify-end p-0.5"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
              <path
                d="M3 13 L13 3 M7 13 L13 7 M11 13 L13 11"
                stroke="currentColor"
                strokeWidth="1.75"
                fill="none"
                strokeLinecap="round"
              />
            </svg>
          </div>

          {(resizeDrag || moveDrag) && (
            <div className="bg-primary text-primary-foreground absolute bottom-1 left-1 z-10 rounded px-1.5 py-0.5 text-[10px] font-mono">
              {moveDrag
                ? `@ ${renderedX},${renderedY}`
                : `${renderedCols}×${renderedRows}`}
            </div>
          )}
        </>
      )}
    </div>
  );
});

function Stepper({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="text-muted-foreground">{label}</span>
      <button
        type="button"
        aria-label={`Decrease ${label}`}
        disabled={value <= min}
        onClick={() => onChange(Math.max(min, value - 1))}
        className="hover:text-primary disabled:opacity-30 px-1 leading-none"
      >
        −
      </button>
      <span className="w-4 text-center font-mono tabular-nums">{value}</span>
      <button
        type="button"
        aria-label={`Increase ${label}`}
        disabled={value >= max}
        onClick={() => onChange(Math.min(max, value + 1))}
        className="hover:text-primary disabled:opacity-30 px-1 leading-none"
      >
        +
      </button>
    </span>
  );
}
