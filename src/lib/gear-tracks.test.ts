import { describe, expect, it } from "vitest";

import { trackForItemLevel } from "./gear-tracks";

describe("trackForItemLevel", () => {
  it("maps the verified Midnight anchors to the right track", () => {
    // research §1.1: Mythic raid items = ilvl 289, Voidforged = 298 (both Myth);
    // Myth track 272–289 — anything above the 276 Heroic cap is uniquely Myth.
    expect(trackForItemLevel(289)).toBe("myth");
    expect(trackForItemLevel(298)).toBe("myth");
    expect(trackForItemLevel(282)).toBe("myth"); // > 276 Hero cap ⇒ must be Myth
    expect(trackForItemLevel(272)).toBe("myth"); // Myth base (overlap → higher track)
    // Heroic-band pieces below the Myth base stay Hero, not Champion/Veteran.
    expect(trackForItemLevel(269)).toBe("hero");
    expect(trackForItemLevel(259)).toBe("hero");
  });

  it("honours the documented track-base boundaries", () => {
    expect(trackForItemLevel(272)).toBe("myth");
    expect(trackForItemLevel(271)).toBe("hero");
    expect(trackForItemLevel(259)).toBe("hero");
    expect(trackForItemLevel(258)).toBe("champion");
    expect(trackForItemLevel(246)).toBe("champion");
    expect(trackForItemLevel(245)).toBe("veteran");
    expect(trackForItemLevel(233)).toBe("veteran");
    expect(trackForItemLevel(232)).toBe("adventurer");
  });

  it("returns null for missing / non-positive item levels", () => {
    expect(trackForItemLevel(null)).toBeNull();
    expect(trackForItemLevel(undefined)).toBeNull();
    expect(trackForItemLevel(0)).toBeNull();
    expect(trackForItemLevel(-5)).toBeNull();
  });

  it("no longer mis-classifies 289 Mythic gear as Veteran (the bug)", () => {
    expect(trackForItemLevel(289)).not.toBe("veteran");
  });
});
