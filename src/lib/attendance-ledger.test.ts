import { describe, expect, it } from "vitest";

import {
  computeAttendance,
  memberNightState,
  mergeObservers,
  type ObservedNight,
} from "./attendance-ledger";

// A night runs 19:00–22:00 (epoch seconds, arbitrary base).
const START = 1_000_000;
const END = START + 3 * 3600;
const night = (present: ObservedNight["present"]): ObservedNight => ({
  key: "n1",
  startedAt: START,
  endedAt: END,
  present,
});

describe("memberNightState", () => {
  it("present = seen from near the start to near the end", () => {
    const n = night(new Map([["A", { firstSeen: START + 60, lastSeen: END - 60 }]]));
    expect(memberNightState(n, "A")).toBe("present");
  });
  it("late = first seen > lateMin after start", () => {
    const n = night(new Map([["A", { firstSeen: START + 20 * 60, lastSeen: END }]]));
    expect(memberNightState(n, "A")).toBe("late");
  });
  it("left_early = last seen > earlyMin before end", () => {
    const n = night(new Map([["A", { firstSeen: START, lastSeen: END - 40 * 60 }]]));
    expect(memberNightState(n, "A")).toBe("left_early");
  });
  it("late takes precedence over left_early", () => {
    const n = night(new Map([["A", { firstSeen: START + 30 * 60, lastSeen: START + 31 * 60 }]]));
    expect(memberNightState(n, "A")).toBe("late");
  });
  it("absent = not in the presence map (the night WAS observed)", () => {
    expect(memberNightState(night(new Map()), "A")).toBe("absent");
  });
  it("honours custom thresholds", () => {
    const n = night(new Map([["A", { firstSeen: START + 5 * 60, lastSeen: END }]]));
    expect(memberNightState(n, "A", { lateMin: 2 })).toBe("late");
    expect(memberNightState(n, "A", { lateMin: 10 })).toBe("present");
  });
});

describe("mergeObservers", () => {
  it("unions presence across observers (earliest firstSeen, latest lastSeen)", () => {
    const merged = mergeObservers([
      {
        key: "n1",
        startedAt: START,
        endedAt: START + 3600,
        present: [{ characterId: "A", firstSeen: START + 600, lastSeen: START + 3000 }],
      },
      {
        key: "n1",
        startedAt: START - 120,
        endedAt: END,
        present: [
          { characterId: "A", firstSeen: START + 60, lastSeen: START + 3600 },
          { characterId: "B", firstSeen: START, lastSeen: END },
        ],
      },
    ]);
    expect(merged).toHaveLength(1);
    const n = merged[0]!;
    expect(n.startedAt).toBe(START - 120); // widest window
    expect(n.endedAt).toBe(END);
    expect(n.present.get("A")).toEqual({ firstSeen: START + 60, lastSeen: START + 3600 });
    expect(n.present.has("B")).toBe(true);
  });
  it("keeps distinct nights separate and chronological", () => {
    const merged = mergeObservers([
      { key: "n2", startedAt: START + 86400, endedAt: END + 86400, present: [] },
      { key: "n1", startedAt: START, endedAt: END, present: [] },
    ]);
    expect(merged.map((m) => m.key)).toEqual(["n1", "n2"]);
  });
});

describe("computeAttendance", () => {
  // 4 nights; A present all, B late once + absent once, C absent all.
  const nights: ObservedNight[] = [0, 1, 2, 3].map((i) => ({
    key: `n${i}`,
    startedAt: START + i * 86400,
    endedAt: START + i * 86400 + 3 * 3600,
    present: new Map(
      i === 3
        ? [["A", { firstSeen: START + i * 86400, lastSeen: START + i * 86400 + 3 * 3600 }]]
        : [
            ["A", { firstSeen: START + i * 86400, lastSeen: START + i * 86400 + 3 * 3600 }],
            [
              "B",
              i === 1
                ? { firstSeen: START + i * 86400 + 30 * 60, lastSeen: START + i * 86400 + 3 * 3600 } // late
                : { firstSeen: START + i * 86400, lastSeen: START + i * 86400 + 3 * 3600 },
            ],
          ],
    ),
  }));

  it("scores MoD-weighted attendance per member over observed nights", () => {
    const [a, b, c] = computeAttendance(nights, ["A", "B", "C"]);
    expect(a!.observedNights).toBe(4);
    expect(a!.present).toBe(4);
    expect(a!.attendancePct).toBe(100);
    // B: present×2 (nights 0,2) + late×1 (night1) + absent×1 (night3) = 2.5/4
    expect(b!.present).toBe(2);
    expect(b!.late).toBe(1);
    expect(b!.absent).toBe(1);
    expect(b!.score).toBeCloseTo(2.5);
    expect(b!.attendancePct).toBeCloseTo((2.5 / 4) * 100);
    // C absent all 4
    expect(c!.absent).toBe(4);
    expect(c!.attendancePct).toBe(0);
  });

  it("returns null pct below the minimum observed-nights floor", () => {
    const [a] = computeAttendance(nights.slice(0, 2), ["A"], { minNights: 3 });
    expect(a!.observedNights).toBe(2);
    expect(a!.attendancePct).toBeNull();
  });

  it("aligns the per-night states array to the nights order", () => {
    const [b] = computeAttendance(nights, ["B"]);
    expect(b!.states).toEqual(["present", "late", "present", "absent"]);
  });
});
