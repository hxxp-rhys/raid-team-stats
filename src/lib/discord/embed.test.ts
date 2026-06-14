import { describe, expect, it } from "vitest";

import { buildRoster, type RosterMember } from "@/lib/calendar/roster";
import { buildEventMessage, eventIdFromFooter, embedMarkerFor, type EmbedEvent } from "./embed";
import { decodeRoute } from "./custom-id";

const member = (over: Partial<RosterMember>): RosterMember => ({
  userId: "u",
  characterId: "c",
  name: "Thrall",
  classId: 7,
  role: "HEAL",
  state: "CONFIRM",
  etaMinutes: null,
  reason: null,
  selection: null,
  source: null,
  updatedAt: null,
  ...over,
});

const ev = (over: Partial<EmbedEvent> = {}): EmbedEvent => ({
  id: "cmEVENT1",
  title: "Mythic Prog",
  difficulty: "Mythic",
  raidSize: 20,
  startsAt: new Date("2026-06-16T23:00:00Z"),
  status: "PLANNED",
  notes: null,
  ...over,
});

describe("buildEventMessage", () => {
  const roster = buildRoster([
    member({ characterId: "c1", name: "Thrall", role: "TANK", state: "CONFIRM" }),
    member({ characterId: "c2", name: "Jaina", role: "HEAL", state: "LATE", etaMinutes: 20 }),
    member({ characterId: "c3", name: "Rexxar", role: "DPS", state: "NO_RESPONSE" }),
  ]);

  it("renders 4 state buttons that decode back to attendance routes", () => {
    const msg = buildEventMessage(ev(), roster, { eventUrl: "https://x/y" });
    const row1 = (msg.components[0] as { components: { custom_id?: string }[] }).components;
    expect(row1).toHaveLength(4);
    const states = row1.map((b) => decodeRoute(b.custom_id!)).map((r) => (r?.kind === "att" ? r.state : null));
    expect(states).toEqual(["CONFIRM", "TENTATIVE", "LATE", "ABSENT"]);
  });

  it("stamps the eventId in the footer for create-or-adopt recovery", () => {
    const msg = buildEventMessage(ev(), roster, { eventUrl: "https://x/y" });
    const footer = (msg.embeds[0] as { footer: { text: string } }).footer.text;
    expect(footer).toBe(embedMarkerFor("cmEVENT1"));
    expect(eventIdFromFooter(footer)).toBe("cmEVENT1");
  });

  it("shows the readiness line and a LATE eta", () => {
    const msg = buildEventMessage(ev(), roster, { eventUrl: "https://x/y" });
    const embed = msg.embeds[0] as { description: string; fields: { name: string; value: string }[] };
    expect(embed.description).toContain("**Tanks** 1/2");
    expect(embed.description).toContain("**Healers** 1/5"); // Jaina LATE counts present
    expect(JSON.stringify(embed.fields)).toContain("~20m");
  });

  it("drops the state buttons when cancelled (keeps the web link)", () => {
    const msg = buildEventMessage(ev({ status: "CANCELLED" }), roster, { eventUrl: "https://x/y" });
    // Only the utility row remains, and it has just the link button.
    expect(msg.components).toHaveLength(1);
    const links = (msg.components[0] as { components: { style: number }[] }).components;
    expect(links).toHaveLength(1);
    expect(links[0]!.style).toBe(5); // LINK
    expect((msg.embeds[0] as { description: string }).description).toContain("CANCELLED");
  });
});
