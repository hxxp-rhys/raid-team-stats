/**
 * Nudge-email templating. Pure + isomorphic (no server-only deps) so the
 * calendar-settings PREVIEW (client) and the reminder sweep (server) render
 * identically.
 *
 * Placeholders use `{{ snake_case }}` (surrounding whitespace tolerated).
 * Unknown placeholders resolve to an EMPTY string, never the literal
 * "{{ ... }}", so a leader's typo can't leak broken tokens into a raider's
 * inbox. The supported set is exactly what the reminder sweep can resolve at
 * send time (see src/server/calendar/reminders.ts).
 */

export type NudgeVarKey =
  | "char_name"
  | "raid_title"
  | "team_name"
  | "local_time"
  | "timezone"
  | "event_url";

export type NudgePlaceholder = {
  key: NudgeVarKey;
  /** Short label for the insert button. */
  label: string;
  /** Example value used by the settings-modal preview. */
  sample: string;
};

/** The placeholders a leader can insert, in display order. */
export const NUDGE_PLACEHOLDERS: ReadonlyArray<NudgePlaceholder> = [
  { key: "char_name", label: "Character name", sample: "Anduin" },
  { key: "raid_title", label: "Raid title", sample: "Mythic Progression" },
  { key: "team_name", label: "Team name", sample: "Eclipse" },
  { key: "local_time", label: "Raid time", sample: "Wed, 8 Jan, 20:00" },
  { key: "timezone", label: "Timezone", sample: "Europe/London" },
  { key: "event_url", label: "Event link", sample: "https://your-site/…/calendar" },
];

/** Built-in nudge email, used when a team hasn't customized it. */
export const DEFAULT_NUDGE_SUBJECT =
  "Please sign up: {{ raid_title }} — {{ team_name }}";
export const DEFAULT_NUDGE_BODY =
  "You haven't responded to an upcoming raid yet — let your team know if you " +
  "can make it.\n\n" +
  "{{ raid_title }} — {{ team_name }}\n" +
  "When: {{ local_time }} ({{ timezone }})\n\n" +
  "Set your attendance here:\n{{ event_url }}\n";

// Matches {{ key }} (letters/digits/underscore, whitespace tolerated). Unknown
// keys still match the SHAPE so they're stripped (resolved to ""), never left
// as literal "{{ ... }}" in a recipient's inbox.
const PLACEHOLDER_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/** Resolve `{{ key }}` tokens against `vars`; unknown/missing → empty string. */
export function renderNudgeTemplate(
  template: string,
  vars: Partial<Record<NudgeVarKey, string>>,
): string {
  const map = vars as Record<string, string | undefined>;
  return template.replace(PLACEHOLDER_RE, (_match, key: string) => map[key] ?? "");
}

/** Sample var map for the settings-modal preview (mirrors NUDGE_PLACEHOLDERS). */
export const NUDGE_SAMPLE_VARS: Record<NudgeVarKey, string> = Object.fromEntries(
  NUDGE_PLACEHOLDERS.map((p) => [p.key, p.sample]),
) as Record<NudgeVarKey, string>;
