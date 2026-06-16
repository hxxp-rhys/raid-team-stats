import type { WidgetInstance } from "@/lib/widgets/types";

/**
 * Dashboard layout engine — pure geometry for the desktop grid.
 *
 * The grid is N columns × unbounded rows (cells). Every widget that takes part
 * in collision/packing needs an explicit (x, y). This module:
 *   - auto-places widgets that lack a position (first-fit, top→bottom),
 *   - moves a widget and PUSHES whatever it lands on out of the way, then
 *     vertically compacts the result so nothing floats in mid-air.
 *
 * This mirrors how Grafana (via react-grid-layout) behaves: drag a panel over
 * another and the other shifts down to accommodate it; gaps then close upward.
 * The dragged/resized widget is PINNED at the user's chosen spot — it never
 * floats away from the cursor; everything else rearranges around it.
 *
 * Kept import-light (only the WidgetInstance type) so vitest can pin it without
 * pulling in React/tRPC.
 */

export type Defaults = { cols: number; rows: number };
type Box = { id: string; x: number; y: number; cols: number; rows: number };

/**
 * AABB overlap. Touching edges (a.right === b.left) is NOT an overlap — flush
 * widgets are valid. Identical to the standalone `collision.ts` test so the two
 * never disagree about what "overlap" means.
 */
const overlaps = (a: Box, b: Box): boolean =>
  !(
    a.x + a.cols <= b.x ||
    b.x + b.cols <= a.x ||
    a.y + a.rows <= b.y ||
    b.y + b.rows <= a.y
  );

const widthOf = (w: WidgetInstance, d: Defaults, gridCols: number): number =>
  Math.max(1, Math.min(w.cols ?? d.cols, gridCols));
const heightOf = (w: WidgetInstance, d: Defaults): number =>
  Math.max(1, w.rows ?? d.rows);

const isPlaced = (
  w: WidgetInstance,
): w is WidgetInstance & { x: number; y: number } =>
  typeof w.x === "number" && typeof w.y === "number";

/**
 * Lowest (scanning y top→bottom, then x left→right) origin where a `cols×rows`
 * box fits without overlapping any box in `placed`. Always terminates: row y
 * eventually clears every placed box.
 */
const firstFit = (
  placed: ReadonlyArray<Box>,
  cols: number,
  rows: number,
  gridCols: number,
): { x: number; y: number } => {
  const maxX = Math.max(0, gridCols - cols);
  for (let y = 0; ; y++) {
    for (let x = 0; x <= maxX; x++) {
      const cand: Box = { id: "", x, y, cols, rows };
      if (!placed.some((p) => overlaps(cand, p))) return { x, y };
    }
  }
};

/**
 * Give every widget an explicit (x, y). Widgets that already have one keep it
 * exactly; unplaced ones are first-fit packed in array order AFTER the placed
 * set. Returns the SAME array reference when nothing needed placing, so callers
 * can use referential equality to skip writes/renders.
 */
export function autoPlaceWidgets(
  widgets: ReadonlyArray<WidgetInstance>,
  gridCols: number,
  defaults: Defaults,
): WidgetInstance[] {
  const placed: Box[] = [];
  for (const w of widgets) {
    if (isPlaced(w)) {
      placed.push({
        id: w.id,
        x: w.x,
        y: w.y,
        cols: widthOf(w, defaults, gridCols),
        rows: heightOf(w, defaults),
      });
    }
  }
  const assigned = new Map<string, { x: number; y: number }>();
  for (const w of widgets) {
    if (isPlaced(w)) continue;
    const cols = widthOf(w, defaults, gridCols);
    const rows = heightOf(w, defaults);
    const pos = firstFit(placed, cols, rows, gridCols);
    placed.push({ id: w.id, x: pos.x, y: pos.y, cols, rows });
    assigned.set(w.id, pos);
  }
  if (assigned.size === 0) return widgets as WidgetInstance[];
  return widgets.map((w) =>
    assigned.has(w.id) ? { ...w, ...assigned.get(w.id)! } : w,
  );
}

/** Build the box list, clamping the pinned widget to the grid. */
const toBoxes = (
  widgets: ReadonlyArray<WidgetInstance>,
  gridCols: number,
  defaults: Defaults,
): Box[] =>
  widgets.map((w) => ({
    id: w.id,
    x: w.x ?? 0,
    y: w.y ?? 0,
    cols: widthOf(w, defaults, gridCols),
    rows: heightOf(w, defaults),
  }));

/**
 * Push every box that overlaps `mover` straight down to just below it, then
 * recurse so the displaced boxes shove anything THEY now overlap. `moved`
 * guards against a box being pushed twice (and against cycles).
 */
const pushDown = (boxes: Box[], mover: Box, moved: Set<string>): void => {
  const hit = boxes
    .filter((b) => !moved.has(b.id) && b.id !== mover.id && overlaps(b, mover))
    .sort((a, b) => a.y - b.y || a.x - b.x);
  for (const c of hit) {
    if (moved.has(c.id)) continue;
    moved.add(c.id);
    c.y = mover.y + mover.rows;
    pushDown(boxes, c, moved);
  }
};

/**
 * Vertically compact: float every box up to the lowest free row, processed in
 * (y, x) order — EXCEPT `pinnedId`, which is locked at its current spot so the
 * thing the user is dragging/resizing never drifts. Everything else packs
 * upward around the pinned box, closing gaps.
 */
const compactVertical = (boxes: ReadonlyArray<Box>, pinnedId: string): Box[] => {
  const out: Box[] = [];
  const pinned = boxes.find((b) => b.id === pinnedId);
  if (pinned) out.push({ ...pinned });
  const rest = boxes
    .filter((b) => b.id !== pinnedId)
    .sort((a, b) => a.y - b.y || a.x - b.x);
  for (const b of rest) {
    const cand: Box = { ...b, y: 0 };
    while (out.some((p) => overlaps(cand, p))) cand.y++;
    out.push(cand);
  }
  return out;
};

/** Write box coordinates back onto the widget list, preserving order + props. */
const applyBoxes = (
  widgets: ReadonlyArray<WidgetInstance>,
  boxes: ReadonlyArray<Box>,
): WidgetInstance[] => {
  const byId = new Map(boxes.map((b) => [b.id, b]));
  return widgets.map((w) => {
    const b = byId.get(w.id);
    if (!b) return w;
    if (w.x === b.x && w.y === b.y && (w.cols ?? null) === b.cols && (w.rows ?? null) === b.rows) {
      return w;
    }
    return { ...w, x: b.x, y: b.y, cols: b.cols, rows: b.rows };
  });
};

/**
 * Move `id` to (x, y), pushing whatever it overlaps out of the way and
 * compacting — the Grafana "shift to accommodate" behavior. Unplaced widgets
 * are auto-placed first so the push has a complete board to work with. The
 * moved widget is pinned at the (clamped) target.
 */
export function moveWidgetWithPush(
  widgets: ReadonlyArray<WidgetInstance>,
  id: string,
  x: number,
  y: number,
  gridCols: number,
  defaults: Defaults,
): WidgetInstance[] {
  const base = autoPlaceWidgets(widgets, gridCols, defaults);
  const boxes = toBoxes(base, gridCols, defaults);
  const target = boxes.find((b) => b.id === id);
  if (!target) return widgets as WidgetInstance[];
  target.x = Math.max(0, Math.min(gridCols - target.cols, x));
  target.y = Math.max(0, y);
  pushDown(boxes, target, new Set([id]));
  return applyBoxes(base, compactVertical(boxes, id));
}

/**
 * Resize `id` to `cols×rows`, pushing displaced widgets down and compacting.
 * Same engine as the move; the resized widget is pinned at its origin.
 */
export function resizeWidgetWithPush(
  widgets: ReadonlyArray<WidgetInstance>,
  id: string,
  cols: number,
  rows: number,
  gridCols: number,
  defaults: Defaults,
): WidgetInstance[] {
  const base = autoPlaceWidgets(widgets, gridCols, defaults);
  const boxes = toBoxes(base, gridCols, defaults);
  const target = boxes.find((b) => b.id === id);
  if (!target) return widgets as WidgetInstance[];
  target.cols = Math.max(1, Math.min(cols, gridCols));
  target.rows = Math.max(1, rows);
  target.x = Math.min(target.x, gridCols - target.cols);
  pushDown(boxes, target, new Set([id]));
  return applyBoxes(base, compactVertical(boxes, id));
}
