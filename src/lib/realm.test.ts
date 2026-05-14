import { describe, expect, it } from "vitest";
import {
  normalizeRealmSlug,
  normalizeRaidTeamSlug,
  buildCharacterPath,
} from "./realm";

describe("normalizeRealmSlug", () => {
  it("lowercases a single-word realm", () => {
    expect(normalizeRealmSlug("Stormrage")).toBe("stormrage");
  });

  it("hyphenates multi-word realms", () => {
    expect(normalizeRealmSlug("Wyrmrest Accord")).toBe("wyrmrest-accord");
  });

  it("strips ASCII apostrophes (Cho'gall)", () => {
    expect(normalizeRealmSlug("Cho'gall")).toBe("chogall");
  });

  it("strips curly apostrophes (Cho’gall)", () => {
    expect(normalizeRealmSlug("Cho’gall")).toBe("chogall");
  });

  it("keeps numbers (Area 52)", () => {
    expect(normalizeRealmSlug("Area 52")).toBe("area-52");
  });

  it("collapses adjacent dashes", () => {
    expect(normalizeRealmSlug("Foo  Bar")).toBe("foo-bar");
  });

  it("trims leading/trailing dashes", () => {
    expect(normalizeRealmSlug(" - Stormrage - ")).toBe("stormrage");
  });

  it("strips diacritics", () => {
    // The realm "Drak'thul" with a diacritic on the 'u', for example.
    expect(normalizeRealmSlug("Draḱthul")).toBe("drakthul");
  });

  it("returns empty string for empty input", () => {
    expect(normalizeRealmSlug("")).toBe("");
  });

  it("returns empty string for whitespace-only input", () => {
    expect(normalizeRealmSlug("   ")).toBe("");
  });
});

describe("normalizeRaidTeamSlug", () => {
  it("aliases normalizeRealmSlug behavior", () => {
    expect(normalizeRaidTeamSlug("Eclipse Midnight")).toBe("eclipse-midnight");
  });
});

describe("buildCharacterPath", () => {
  it("composes a slug/name path", () => {
    expect(buildCharacterPath("Stormrage", "Faelmir")).toBe("stormrage/faelmir");
  });

  it("URL-encodes special characters in the name", () => {
    // Most characters with special chars are illegal in WoW, but defend anyway.
    expect(buildCharacterPath("Stormrage", "Fælmir")).toBe("stormrage/f%C3%A6lmir");
  });

  it("lowercases the character name", () => {
    expect(buildCharacterPath("Stormrage", "FAELMIR")).toBe("stormrage/faelmir");
  });

  it("rejects empty realm slugs", () => {
    expect(() => buildCharacterPath("", "Faelmir")).toThrow(/realm slug/);
  });

  it("rejects empty character names", () => {
    expect(() => buildCharacterPath("Stormrage", "")).toThrow(/character name/);
  });

  it("rejects realm slugs that normalize to empty", () => {
    expect(() => buildCharacterPath("   ", "Faelmir")).toThrow(/realm slug/);
  });
});
