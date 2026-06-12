import { describe, expect, it } from "vitest";

import { parseWclGuildSource } from "./wcl-source";

describe("parseWclGuildSource", () => {
  it("accepts the full guild URL in its common shapes", () => {
    expect(
      parseWclGuildSource("https://www.warcraftlogs.com/guild/id/821324"),
    ).toBe(821324);
    expect(
      parseWclGuildSource("https://www.warcraftlogs.com/guild/id/821324/"),
    ).toBe(821324);
    expect(
      parseWclGuildSource("warcraftlogs.com/guild/id/821324?boss=-2#tab"),
    ).toBe(821324);
    expect(
      parseWclGuildSource(" https://www.warcraftlogs.com/guild/id/7 "),
    ).toBe(7);
  });

  it("accepts a raw numeric id", () => {
    expect(parseWclGuildSource("821324")).toBe(821324);
    expect(parseWclGuildSource("  311018  ")).toBe(311018);
  });

  it("rejects everything else", () => {
    expect(parseWclGuildSource("")).toBeNull();
    expect(parseWclGuildSource("0")).toBeNull();
    expect(parseWclGuildSource("-5")).toBeNull();
    // name-form URL has no id to extract
    expect(
      parseWclGuildSource(
        "https://www.warcraftlogs.com/guild/us/stormrage/with%20the%20sun",
      ),
    ).toBeNull();
    expect(parseWclGuildSource("https://example.com/guild/id/123")).toBeNull();
    expect(parseWclGuildSource("guild id 123")).toBeNull();
    // digits glued to more digits-path (no separator) must not half-match
    expect(
      parseWclGuildSource("warcraftlogs.com/guild/id/12a3"),
    ).toBeNull();
  });
});
