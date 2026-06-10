import { describe, expect, it } from "vitest";

import { findCollider } from "./collision";
import type { WidgetInstance } from "./types";

// Minimal WidgetInstance factory — collision.ts only reads (id, x, y, cols,
// rows), so we cast the rest. The widget type doesn't matter for AABB math.
const w = (
  id: string,
  x: number | undefined,
  y: number | undefined,
  cols?: number,
  rows?: number,
): WidgetInstance =>
  ({
    id,
    type: "tier-set-tracker",
    x,
    y,
    cols,
    rows,
  }) as unknown as WidgetInstance;

const DEFAULTS = { cols: 4, rows: 2 };

describe("findCollider", () => {
  it("returns null when the candidate sits next to a flush neighbour", () => {
    // A at (0,0) 4×2; B at (4,0) 4×2 — right edge of A === left edge of B.
    // Touching is NOT overlap.
    const widgets = [w("A", 0, 0, 4, 2)];
    expect(
      findCollider(widgets, { id: "B", x: 4, y: 0, cols: 4, rows: 2 }, DEFAULTS),
    ).toBeNull();
  });

  it("reports the colliding widget id on partial column overlap", () => {
    const widgets = [w("A", 0, 0, 4, 2)];
    // B overlaps A by 1 column.
    expect(
      findCollider(widgets, { id: "B", x: 3, y: 0, cols: 4, rows: 2 }, DEFAULTS),
    ).toBe("A");
  });

  it("returns null when columns are flush even if rows overlap", () => {
    const widgets = [w("A", 0, 0, 4, 4)];
    expect(
      findCollider(widgets, { id: "B", x: 4, y: 1, cols: 4, rows: 4 }, DEFAULTS),
    ).toBeNull();
  });

  it("returns null when rows are flush even if columns overlap", () => {
    const widgets = [w("A", 0, 0, 4, 2)];
    expect(
      findCollider(widgets, { id: "B", x: 0, y: 2, cols: 4, rows: 2 }, DEFAULTS),
    ).toBeNull();
  });

  it("excludes self-collision by id", () => {
    // Moving A to its own current cell is not a collision with itself.
    const widgets = [w("A", 0, 0, 4, 2)];
    expect(
      findCollider(widgets, { id: "A", x: 0, y: 0, cols: 4, rows: 2 }, DEFAULTS),
    ).toBeNull();
  });

  it("skips widgets that have no explicit position", () => {
    // Auto-flow widgets (no x/y) cannot collide in strict-layout terms.
    const widgets = [w("A", undefined, undefined, 4, 2)];
    expect(
      findCollider(widgets, { id: "B", x: 0, y: 0, cols: 4, rows: 2 }, DEFAULTS),
    ).toBeNull();
  });

  it("falls back to defaults for widgets missing cols/rows", () => {
    // A is placed at (0,0) but with no explicit cols/rows → defaults apply
    // (4×2). B at (2,0) 4×2 overlaps the implicit A.
    const widgets = [w("A", 0, 0)];
    expect(
      findCollider(widgets, { id: "B", x: 2, y: 0, cols: 4, rows: 2 }, DEFAULTS),
    ).toBe("A");
  });

  it("finds the first collider in iteration order when multiple overlap", () => {
    const widgets = [w("A", 0, 0, 4, 2), w("B", 4, 0, 4, 2)];
    // Candidate 6×2 at (0,0) overlaps both A and B; returns A (first hit).
    expect(
      findCollider(widgets, { id: "C", x: 0, y: 0, cols: 6, rows: 2 }, DEFAULTS),
    ).toBe("A");
  });

  it("returns null for an empty widget list", () => {
    expect(
      findCollider([], { id: "X", x: 0, y: 0, cols: 4, rows: 2 }, DEFAULTS),
    ).toBeNull();
  });

  it("detects fully contained candidates", () => {
    // Big A (8×4 at origin) entirely surrounds tiny B (2×1 at (2,1)).
    const widgets = [w("A", 0, 0, 8, 4)];
    expect(
      findCollider(widgets, { id: "B", x: 2, y: 1, cols: 2, rows: 1 }, DEFAULTS),
    ).toBe("A");
  });
});
