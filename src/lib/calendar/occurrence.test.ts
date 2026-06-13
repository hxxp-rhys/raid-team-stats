import { describe, expect, it } from "vitest";

import { enumerateOccurrences, isValidByday, type SeriesSpec } from "./occurrence";

const spec = (over: Partial<SeriesSpec> = {}): SeriesSpec => ({
  byday: ["TU", "TH"],
  startLocal: "19:00",
  timezone: "Europe/London",
  startsOn: null,
  endsOn: null,
  ...over,
});

describe("isValidByday", () => {
  it("accepts canonical tokens (case-insensitive), rejects junk", () => {
    expect(isValidByday("MO")).toBe(true);
    expect(isValidByday("su")).toBe(true);
    expect(isValidByday("XX")).toBe(false);
    expect(isValidByday("")).toBe(false);
  });
});

describe("enumerateOccurrences", () => {
  it("lists the matching weekdays in window, sorted, at the right wall-clock", () => {
    // Tue/Thu in a fixed June week (no DST in window).
    const from = new Date("2026-06-15T00:00:00Z"); // Mon
    const to = new Date("2026-06-22T00:00:00Z"); // next Mon (exclusive)
    const occ = enumerateOccurrences(spec(), from, to);
    expect(occ.map((o) => o.occurrenceDate)).toEqual(["2026-06-16", "2026-06-18"]);
    // London is BST (UTC+1) in June → 19:00 local = 18:00Z.
    expect(occ[0]!.startsAt.toISOString()).toBe("2026-06-16T18:00:00.000Z");
    expect(occ[1]!.startsAt.toISOString()).toBe("2026-06-18T18:00:00.000Z");
  });

  it("keeps 19:00 LOCAL across the autumn DST fall-back (BST→GMT)", () => {
    // UK clocks go back on Sun 2026-10-25. A Tue before and a Tue after must
    // both be 19:00 local — but different UTC instants (18:00Z then 19:00Z).
    const from = new Date("2026-10-19T00:00:00Z");
    const to = new Date("2026-11-02T00:00:00Z");
    const occ = enumerateOccurrences(spec({ byday: ["TU"] }), from, to);
    expect(occ.map((o) => o.occurrenceDate)).toEqual([
      "2026-10-20",
      "2026-10-27",
    ]);
    expect(occ[0]!.startsAt.toISOString()).toBe("2026-10-20T18:00:00.000Z"); // BST
    expect(occ[1]!.startsAt.toISOString()).toBe("2026-10-27T19:00:00.000Z"); // GMT
  });

  it("respects startsOn (inclusive) and endsOn (inclusive) bounds", () => {
    const from = new Date("2026-06-01T00:00:00Z");
    const to = new Date("2026-07-01T00:00:00Z");
    const occ = enumerateOccurrences(
      spec({
        byday: ["TU"],
        startsOn: new Date("2026-06-16T18:00:00Z"), // exactly the 16th's instant
        endsOn: new Date("2026-06-23T18:00:00Z"), // exactly the 23rd's instant
      }),
      from,
      to,
    );
    // 16th and 23rd included (bounds inclusive); 9th excluded, 30th excluded.
    expect(occ.map((o) => o.occurrenceDate)).toEqual(["2026-06-16", "2026-06-23"]);
  });

  it("treats `to` as exclusive and `from` as inclusive", () => {
    // Window starts exactly on a Tue 18:00Z occurrence and ends exactly on the
    // next Tue 18:00Z. Lower included, upper excluded.
    const from = new Date("2026-06-16T18:00:00Z");
    const to = new Date("2026-06-23T18:00:00Z");
    const occ = enumerateOccurrences(spec({ byday: ["TU"] }), from, to);
    expect(occ.map((o) => o.occurrenceDate)).toEqual(["2026-06-16"]);
  });

  it("returns nothing for empty byday, inverted window, or zero-width range", () => {
    const from = new Date("2026-06-15T00:00:00Z");
    const to = new Date("2026-06-22T00:00:00Z");
    expect(enumerateOccurrences(spec({ byday: [] }), from, to)).toEqual([]);
    expect(enumerateOccurrences(spec(), to, from)).toEqual([]);
    expect(enumerateOccurrences(spec(), from, from)).toEqual([]);
  });

  it("handles a US spring-forward week, keeping 20:00 local", () => {
    // US DST starts Sun 2026-03-08. A Wed raid before/after stays 20:00 local.
    const from = new Date("2026-03-01T00:00:00Z");
    const to = new Date("2026-03-20T00:00:00Z");
    const occ = enumerateOccurrences(
      spec({ byday: ["WE"], startLocal: "20:00", timezone: "America/New_York" }),
      from,
      to,
    );
    expect(occ.map((o) => o.occurrenceDate)).toEqual(["2026-03-04", "2026-03-11", "2026-03-18"]);
    expect(occ[0]!.startsAt.toISOString()).toBe("2026-03-05T01:00:00.000Z"); // EST UTC-5
    expect(occ[1]!.startsAt.toISOString()).toBe("2026-03-12T00:00:00.000Z"); // EDT UTC-4
  });

  it("enumerates multiple days per week in instant order", () => {
    const from = new Date("2026-06-15T00:00:00Z");
    const to = new Date("2026-06-29T00:00:00Z");
    const occ = enumerateOccurrences(
      spec({ byday: ["MO", "WE", "FR"], timezone: "UTC", startLocal: "20:00" }),
      from,
      to,
    );
    expect(occ.map((o) => o.occurrenceDate)).toEqual([
      "2026-06-15",
      "2026-06-17",
      "2026-06-19",
      "2026-06-22",
      "2026-06-24",
      "2026-06-26",
    ]);
  });
});
