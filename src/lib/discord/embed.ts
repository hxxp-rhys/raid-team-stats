import { countsAsPresent, type RosterMember, type RosterView } from "@/lib/calendar/roster";
import {
  ButtonStyle,
  ComponentType,
  DIFFICULTY_COLOR,
  STATE_GLYPH,
} from "./constants";
import { encodeRoute } from "./custom-id";

/**
 * Render a raid event into a Discord message (embed + components) from current
 * DB state. PURE — no env/fetch — so it's unit-testable and the fan-out worker
 * can call it for both POST (new) and PATCH (edit-in-place). The footer carries
 * an `event:<id>` marker so the re-post path can adopt an existing embed (M3).
 */

const MARKER = "event:";
export const embedMarkerFor = (eventId: string) => `${MARKER}${eventId}`;
export function eventIdFromFooter(text: string | undefined | null): string | null {
  if (!text) return null;
  const i = text.indexOf(MARKER);
  return i >= 0 ? text.slice(i + MARKER.length).trim() || null : null;
}

export type EmbedEvent = {
  id: string;
  title: string;
  difficulty: string;
  raidSize: number | null;
  startsAt: Date;
  status: string; // PLANNED | LOCKED | CANCELLED
  notes: string | null;
};

function roleField(label: string, members: RosterMember[]) {
  if (members.length === 0) return null;
  const present = members.filter((m) => countsAsPresent(m.state)).length;
  const lines = members.map((m) => {
    const glyph = STATE_GLYPH[m.state] ?? "◽";
    const eta = m.state === "LATE" && m.etaMinutes != null ? ` ~${m.etaMinutes}m` : "";
    return `${glyph} ${m.name}${eta}`;
  });
  let value = lines.join("\n");
  if (value.length > 1000) value = value.slice(0, 990) + "\n…"; // Discord field cap 1024
  return { name: `${label} (${present}/${members.length})`, value, inline: true };
}

export function buildEventMessage(
  event: EmbedEvent,
  roster: RosterView,
  opts: { eventUrl: string },
): { embeds: unknown[]; components: unknown[] } {
  const cancelled = event.status === "CANCELLED";
  const locked = event.status === "LOCKED";
  const unix = Math.floor(event.startsAt.getTime() / 1000);
  const r = roster.readiness;

  const readiness =
    `**Tanks** ${r.byRole.TANK}/${r.target.tanks} · ` +
    `**Healers** ${r.byRole.HEAL}/${r.target.healers} · ` +
    `**DPS** ${r.byRole.DPS}/${r.target.dps} · ` +
    `${r.present}/${r.total} in`;

  const desc: string[] = [];
  if (cancelled) desc.push("**❌ CANCELLED**");
  desc.push(`🗓️ <t:${unix}:F> · <t:${unix}:R>`);
  desc.push(`⚔️ ${event.difficulty}${event.raidSize ? ` · ${event.raidSize}-man` : ""}`);
  desc.push(readiness);
  if (event.notes) desc.push(`\n${event.notes.slice(0, 500)}`);

  const fields: unknown[] = [];
  for (const g of roster.groups) {
    const label = g.role === "TANK" ? "Tanks" : g.role === "HEAL" ? "Healers" : "DPS";
    const f = roleField(label, g.members);
    if (f) fields.push(f);
  }
  if (roster.unknownRole.length > 0) {
    const f = roleField("Role unknown", roster.unknownRole);
    if (f) fields.push(f);
  }

  const embed = {
    title: `${locked ? "🔒 " : ""}${event.title}`,
    color: cancelled ? 0x71717a : DIFFICULTY_COLOR[event.difficulty] ?? 0x5865f2,
    description: desc.join("\n"),
    fields,
    footer: { text: embedMarkerFor(event.id) },
    timestamp: event.startsAt.toISOString(),
  };

  const stateBtn = (
    style: number,
    label: string,
    emoji: string,
    state: "CONFIRM" | "TENTATIVE" | "LATE" | "ABSENT",
  ) => ({
    type: ComponentType.BUTTON,
    style,
    label,
    emoji: { name: emoji },
    custom_id: encodeRoute({ kind: "att", eventId: event.id, state }),
  });

  const components: unknown[] = [];
  if (!cancelled) {
    components.push({
      type: ComponentType.ACTION_ROW,
      components: [
        stateBtn(ButtonStyle.SUCCESS, "Confirm", "✅", "CONFIRM"),
        stateBtn(ButtonStyle.SECONDARY, "Tentative", "🟡", "TENTATIVE"),
        stateBtn(ButtonStyle.PRIMARY, "Late", "🕒", "LATE"),
        stateBtn(ButtonStyle.DANGER, "Absent", "❌", "ABSENT"),
      ],
    });
  }
  components.push({
    type: ComponentType.ACTION_ROW,
    components: [
      ...(cancelled
        ? []
        : [
            {
              type: ComponentType.BUTTON,
              style: ButtonStyle.SECONDARY,
              label: "Refresh",
              emoji: { name: "🔄" },
              custom_id: encodeRoute({ kind: "refresh", eventId: event.id }),
            },
          ]),
      {
        type: ComponentType.BUTTON,
        style: ButtonStyle.LINK,
        label: "Open on website",
        url: opts.eventUrl,
      },
    ],
  });

  return { embeds: [embed], components };
}
