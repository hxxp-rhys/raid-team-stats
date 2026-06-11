import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the DB + lifecycle/claim/ownership collaborators so applyVerification
// can run without a database. We only care about WHETHER the absence sweep
// fires — i.e. whether recordGuildAbsence is called — under the
// skipAbsenceSweep flag. The real normalize* helpers (from @/lib/realm) are
// left intact because the key comparison depends on them.

// vi.hoisted so the vi.mock factories (which are hoisted above imports) can
// reference these spies directly — no forwarding wrappers needed. The vi.fn
// callbacks take no params but still record every call with its arguments.
const { recordGuildPresence, recordGuildAbsence, claimByGm, claimPendingAssetsForUser } =
  vi.hoisted(() => ({
    recordGuildPresence: vi.fn(() => Promise.resolve()),
    recordGuildAbsence: vi.fn(() => Promise.resolve()),
    claimByGm: vi.fn(() => Promise.resolve({ claimed: false })),
    claimPendingAssetsForUser: vi.fn(() =>
      Promise.resolve({ teamsClaimed: 0, dashboardsClaimed: 0 }),
    ),
  }));

// A single ACTIVE link to a guild the user will NOT observe in the batch —
// the classic "did they leave?" case the sweep is meant to catch.
const unobservedLink = {
  characterId: "char-other",
  guildId: "guild-other",
  guild: {
    region: "US",
    realmSlug: "area-52",
    guildSlug: "other-guild",
    faction: "ALLIANCE",
  },
  character: { blizzardCharacterId: BigInt(999) },
};

vi.mock("@/lib/db", () => ({
  db: {
    character: {
      upsert: vi.fn(async () => ({ id: "char-1" })),
    },
    guild: {
      upsert: vi.fn(async () => ({ id: "guild-1", claimStatus: "UNCLAIMED" })),
    },
    guildCharacterLink: {
      findMany: vi.fn(async () => [unobservedLink]),
    },
  },
}));

vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));

vi.mock("@/server/guild-auth/lifecycle", () => ({
  recordGuildPresence,
  recordGuildAbsence,
}));

vi.mock("@/server/guild-auth/claim", () => ({ claimByGm }));

vi.mock("@/server/guild-auth/ownership", () => ({ claimPendingAssetsForUser }));

import { applyVerification } from "./verify";

// One observed character in a DIFFERENT guild than the unobserved link, so
// the sweep (when it runs) has a genuine absence to record.
const observation = {
  blizzardCharacterId: BigInt(1),
  region: "US" as const,
  realmSlug: "area-52",
  characterName: "Tickedchar",
  faction: "ALLIANCE" as const,
  level: 80,
  classId: 1,
  race: undefined,
  guild: {
    name: "Ticked Guild",
    realmSlug: "area-52",
    faction: "ALLIANCE" as const,
    rosterRank: 5,
  },
};

beforeEach(() => {
  recordGuildAbsence.mockClear();
  recordGuildPresence.mockClear();
});

describe("applyVerification — skipAbsenceSweep", () => {
  it("does NOT mark absences when skipAbsenceSweep is true (selective add)", async () => {
    await applyVerification({
      userId: "user-1",
      observedAt: new Date(0),
      characters: [observation],
      verifiedOwnership: true,
      skipAbsenceSweep: true,
    });
    // The user has an ACTIVE link to a guild absent from this batch, but the
    // add path must NOT touch it — that's the roster-corruption guard.
    expect(recordGuildAbsence).not.toHaveBeenCalled();
    // Presence is still recorded for the ticked guild.
    expect(recordGuildPresence).toHaveBeenCalledTimes(1);
  });

  it("DOES mark absences on the normal full-roster path (flag absent)", async () => {
    await applyVerification({
      userId: "user-1",
      observedAt: new Date(0),
      characters: [observation],
      verifiedOwnership: true,
      // skipAbsenceSweep omitted → defaults to false
    });
    // The unobserved ACTIVE link gets an absence increment, as before.
    expect(recordGuildAbsence).toHaveBeenCalledTimes(1);
  });
});
