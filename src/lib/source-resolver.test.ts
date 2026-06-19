import { describe, expect, it } from "vitest";
import { isAddonFresh, resolveField } from "./source-resolver";

const NOW = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

describe("isAddonFresh", () => {
  const cases: Array<{
    name: string;
    collectedAt: Date | null;
    companionState: "none" | "ok" | "warning";
    maxAgeMs?: number;
    expected: boolean;
  }> = [
    {
      name: "ok + recent capture → fresh",
      collectedAt: new Date(NOW - 60 * 60 * 1000), // 1h ago
      companionState: "ok",
      expected: true,
    },
    {
      name: "ok + capture older than the window → stale",
      collectedAt: new Date(NOW - 2 * DAY_MS), // 2 days ago
      companionState: "ok",
      expected: false,
    },
    {
      name: "warning state → never fresh (even if recent)",
      collectedAt: new Date(NOW - 60 * 1000),
      companionState: "warning",
      expected: false,
    },
    {
      name: "none state → never fresh (even if recent)",
      collectedAt: new Date(NOW - 60 * 1000),
      companionState: "none",
      expected: false,
    },
    {
      name: "null collectedAt → never fresh",
      collectedAt: null,
      companionState: "ok",
      expected: false,
    },
    {
      name: "exactly at the maxAge boundary → still fresh (<=)",
      collectedAt: new Date(NOW - DAY_MS),
      companionState: "ok",
      expected: true,
    },
    {
      name: "one ms past the boundary → stale",
      collectedAt: new Date(NOW - DAY_MS - 1),
      companionState: "ok",
      expected: false,
    },
    {
      name: "respects a custom maxAgeMs",
      collectedAt: new Date(NOW - 2 * 60 * 60 * 1000), // 2h ago
      companionState: "ok",
      maxAgeMs: 60 * 60 * 1000, // 1h window
      expected: false,
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(
        isAddonFresh({
          collectedAt: c.collectedAt,
          companionState: c.companionState,
          now: NOW,
          maxAgeMs: c.maxAgeMs,
        }),
      ).toBe(c.expected);
    });
  }
});

describe("resolveField", () => {
  it("fresh addon with a present value → addon wins", () => {
    expect(
      resolveField({ addonValue: 489, apiValue: 480, addonFresh: true }),
    ).toEqual({ value: 489, source: "addon" });
  });

  it("fresh addon but null value → falls back to API", () => {
    expect(
      resolveField({ addonValue: null, apiValue: 480, addonFresh: true }),
    ).toEqual({ value: 480, source: "api" });
  });

  it("stale addon → API wins even with an addon value present", () => {
    expect(
      resolveField({ addonValue: 489, apiValue: 480, addonFresh: false }),
    ).toEqual({ value: 480, source: "api" });
  });

  it("both sides null → null + api", () => {
    expect(
      resolveField({ addonValue: null, apiValue: null, addonFresh: true }),
    ).toEqual({ value: null, source: "api" });
  });

  it("undefined addon value is treated as absent", () => {
    expect(
      resolveField({ addonValue: undefined, apiValue: 12, addonFresh: true }),
    ).toEqual({ value: 12, source: "api" });
  });
});
