import type { WidgetInstance } from "@/lib/widgets/types";

/**
 * Axis-aligned bounding-box used for collision testing. A widget without an
 * explicit `x`/`y` is auto-flow-placed by CSS Grid (with `gridAutoFlow:
 * "dense"`) and has no fixed cell coordinates, so it can't collide in the
 * strict-layout sense — we ignore it.
 */
type PlacedBox = { id: string; x: number; y: number; cols: number; rows: number };

const toBox = (
  w: WidgetInstance,
  defaults: { cols: number; rows: number },
): PlacedBox | null => {
  if (typeof w.x !== "number" || typeof w.y !== "number") return null;
  return {
    id: w.id,
    x: w.x,
    y: w.y,
    cols: w.cols ?? defaults.cols,
    rows: w.rows ?? defaults.rows,
  };
};

/**
 * Standard AABB rectangle intersection. Two boxes overlap iff each axis
 * overlaps. Touching edges (a.right === b.left) does NOT count as overlap —
 * widgets sitting flush against each other are valid.
 */
const intersects = (a: PlacedBox, b: PlacedBox): boolean =>
  !(
    a.x + a.cols <= b.x ||
    b.x + b.cols <= a.x ||
    a.y + a.rows <= b.y ||
    b.y + b.rows <= a.y
  );

/**
 * Would the `candidate` widget — with its proposed (x, y, cols, rows) —
 * overlap any other PLACED widget in `widgets`? The widget with the same
 * id as the candidate is excluded (a widget can't collide with itself
 * mid-move/resize). Returns the id of the first collider, or `null` for
 * no collision.
 *
 * Why expose the colliding id: callers can highlight the blocking widget
 * in the UI ("can't place — blocked by Vault progress"). Even when only
 * the boolean is needed, returning a string is cheaper than separately
 * recomputing it.
 */
export function findCollider(
  widgets: ReadonlyArray<WidgetInstance>,
  candidate: PlacedBox,
  defaults: { cols: number; rows: number },
): string | null {
  for (const w of widgets) {
    if (w.id === candidate.id) continue;
    const other = toBox(w, defaults);
    if (!other) continue;
    if (intersects(candidate, other)) return other.id;
  }
  return null;
}

export type { PlacedBox };
