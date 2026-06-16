import { describe, expect, it } from "vitest";

import {
  autoPlaceWidgets,
  moveWidgetWithPush,
  resizeWidgetWithPush,
} from "./layout-engine";
import type { WidgetInstance } from "./types";

// Small 4-col grid, 1×1 defaults, to make positions easy to reason about.
const COLS = 4;
const D = { cols: 1, rows: 1 };

const w = (
  id: string,
  x: number | undefined,
  y: number | undefined,
  cols: number,
  rows: number,
): WidgetInstance => ({ id, type: "ilvl_roster", x, y, cols, rows });

const pos = (list: WidgetInstance[], id: string) => {
  const f = list.find((it) => it.id === id)!;
  return { x: f.x, y: f.y, cols: f.cols, rows: f.rows };
};

describe("autoPlaceWidgets", () => {
  it("packs unplaced widgets into the first free cell after placed ones", () => {
    const list = [w("A", 0, 0, 2, 1), w("B", undefined, undefined, 2, 1)];
    const out = autoPlaceWidgets(list, COLS, D);
    expect(pos(out, "A")).toMatchObject({ x: 0, y: 0 }); // unchanged
    expect(pos(out, "B")).toMatchObject({ x: 2, y: 0 }); // flush to A's right
  });

  it("stacks a too-wide-to-fit-beside widget onto the next row", () => {
    const list = [w("A", 0, 0, 3, 1), w("B", undefined, undefined, 3, 1)];
    const out = autoPlaceWidgets(list, COLS, D);
    expect(pos(out, "B")).toMatchObject({ x: 0, y: 1 });
  });

  it("returns the SAME array reference when every widget is already placed", () => {
    const list = [w("A", 0, 0, 1, 1), w("B", 1, 0, 1, 1)];
    expect(autoPlaceWidgets(list, COLS, D)).toBe(list);
  });

  it("does not mutate the input widgets", () => {
    const list = [w("A", 0, 0, 1, 1), w("B", undefined, undefined, 1, 1)];
    autoPlaceWidgets(list, COLS, D);
    expect(list[1]!.x).toBeUndefined();
  });
});

describe("moveWidgetWithPush", () => {
  it("pushes the widget it lands on down and compacts (swap)", () => {
    const list = [w("A", 0, 0, 2, 2), w("B", 0, 2, 2, 2)];
    const out = moveWidgetWithPush(list, "B", 0, 0, COLS, D);
    expect(pos(out, "B")).toMatchObject({ x: 0, y: 0 }); // pinned where dropped
    expect(pos(out, "A")).toMatchObject({ x: 0, y: 2 }); // shifted to accommodate
  });

  it("cascades the push through a stack", () => {
    const list = [w("A", 0, 0, 2, 1), w("B", 0, 1, 2, 1), w("C", 0, 2, 2, 1)];
    const out = moveWidgetWithPush(list, "C", 0, 0, COLS, D);
    expect(pos(out, "C")).toMatchObject({ x: 0, y: 0 });
    expect(pos(out, "A")).toMatchObject({ x: 0, y: 1 });
    expect(pos(out, "B")).toMatchObject({ x: 0, y: 2 });
  });

  it("does not disturb a widget that isn't in the way", () => {
    const list = [w("A", 0, 0, 1, 1), w("B", 3, 0, 1, 4)];
    const out = moveWidgetWithPush(list, "A", 0, 1, COLS, D);
    // A pinned at its drop; B untouched (different column, no overlap)
    expect(pos(out, "A")).toMatchObject({ x: 0, y: 1 });
    expect(pos(out, "B")).toMatchObject({ x: 3, y: 0 });
  });

  it("auto-places an unplaced widget before pushing so it can collide", () => {
    const list = [w("A", 0, 0, 2, 1), w("B", undefined, undefined, 2, 1)];
    // B auto-places to (2,0); moving A onto (2,0) must push B, not no-op.
    const out = moveWidgetWithPush(list, "A", 2, 0, COLS, D);
    expect(pos(out, "A")).toMatchObject({ x: 2, y: 0 });
    expect(typeof pos(out, "B").y).toBe("number");
    expect(pos(out, "B").y).toBeGreaterThanOrEqual(1);
  });

  it("clamps the target inside the grid", () => {
    const list = [w("A", 0, 0, 2, 1)];
    const out = moveWidgetWithPush(list, "A", 99, 0, COLS, D);
    expect(pos(out, "A").x).toBe(COLS - 2); // clamped to rightmost fit
  });
});

describe("resizeWidgetWithPush", () => {
  it("pushes a neighbor down when a widget grows into it", () => {
    const list = [w("A", 0, 0, 1, 1), w("B", 0, 1, 1, 1)];
    const out = resizeWidgetWithPush(list, "A", 1, 3, COLS, D);
    expect(pos(out, "A")).toMatchObject({ x: 0, y: 0, cols: 1, rows: 3 });
    expect(pos(out, "B")).toMatchObject({ x: 0, y: 3 });
  });
});
