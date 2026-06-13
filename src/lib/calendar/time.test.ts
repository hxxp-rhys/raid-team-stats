import { describe, expect, it } from "vitest";

import {
  endInstant,
  isValidTimeZone,
  localDateInTz,
  zonedWallClockToUtc,
} from "./time";

describe("isValidTimeZone", () => {
  it("accepts real IANA zones, rejects junk", () => {
    expect(isValidTimeZone("Europe/London")).toBe(true);
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Mars/Phobos")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });
});

describe("zonedWallClockToUtc", () => {
  it("resolves a UTC wall-clock to the same instant", () => {
    expect(zonedWallClockToUtc("2026-06-16", "19:00", "UTC").toISOString()).toBe(
      "2026-06-16T19:00:00.000Z",
    );
  });

  it("applies a fixed offset zone", () => {
    // America/New_York is UTC-4 in June (EDT): 19:00 local = 23:00 UTC.
    expect(
      zonedWallClockToUtc("2026-06-16", "19:00", "America/New_York").toISOString(),
    ).toBe("2026-06-16T23:00:00.000Z");
  });

  it("keeps the SAME wall-clock across a DST transition (the whole point)", () => {
    // London: BST (UTC+1) in summer, GMT (UTC+0) in winter. A 19:00 raid is
    // 18:00Z in July but 19:00Z in January — same LOCAL time, different instant.
    const summer = zonedWallClockToUtc("2026-07-14", "19:00", "Europe/London");
    const winter = zonedWallClockToUtc("2026-01-13", "19:00", "Europe/London");
    expect(summer.toISOString()).toBe("2026-07-14T18:00:00.000Z");
    expect(winter.toISOString()).toBe("2026-01-13T19:00:00.000Z");
  });

  it("handles a US spring-forward week correctly", () => {
    // 2026 US DST starts Sun Mar 8. Sat Mar 7 19:00 = EST (UTC-5) = 00:00Z next
    // day; Mon Mar 9 19:00 = EDT (UTC-4) = 23:00Z.
    expect(
      zonedWallClockToUtc("2026-03-07", "19:00", "America/New_York").toISOString(),
    ).toBe("2026-03-08T00:00:00.000Z");
    expect(
      zonedWallClockToUtc("2026-03-09", "19:00", "America/New_York").toISOString(),
    ).toBe("2026-03-09T23:00:00.000Z");
  });

  it("rejects malformed inputs", () => {
    expect(() => zonedWallClockToUtc("2026/06/16", "19:00", "UTC")).toThrow();
    expect(() => zonedWallClockToUtc("2026-06-16", "7pm", "UTC")).toThrow();
    expect(() => zonedWallClockToUtc("2026-06-16", "25:00", "UTC")).toThrow();
    expect(() => zonedWallClockToUtc("2026-06-16", "19:00", "Nope")).toThrow();
  });
});

describe("localDateInTz", () => {
  it("returns the local calendar date, which can differ from the UTC date", () => {
    // 23:30Z is still the same UTC day, but already next day in Sydney (+10/+11).
    const inst = new Date("2026-06-16T23:30:00.000Z");
    expect(localDateInTz(inst, "UTC")).toBe("2026-06-16");
    expect(localDateInTz(inst, "Australia/Sydney")).toBe("2026-06-17");
    // And earlier in the US.
    expect(localDateInTz(inst, "America/New_York")).toBe("2026-06-16");
  });
});

describe("endInstant", () => {
  it("adds duration minutes", () => {
    expect(
      endInstant(new Date("2026-06-16T19:00:00.000Z"), 180).toISOString(),
    ).toBe("2026-06-16T22:00:00.000Z");
  });
});
