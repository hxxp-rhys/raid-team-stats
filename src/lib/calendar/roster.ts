/**
 * Pure roster + comp-readiness logic for a raid event, shared by the tRPC
 * router (server) and the event-detail UI (client). No DB / React imports.
 *
 * Inputs are already-resolved per-member rows (role pre-computed via
 * lib/wow.inferRole) and their signup rows; output is the role-grouped roster
 * with per-state ordering and a readiness meter against a comp target.
 */

import type { WowRole } from "@/lib/wow";

export type AttendanceState =
  | "CONFIRM"
  | "TENTATIVE"
  | "LATE"
  | "ABSENT"
  | "NO_RESPONSE";

/** One roster entry = an active member + their signup (or none). */
export type RosterMember = {
  userId: string;
  characterId: string;
  name: string;
  classId: number | null;
  role: WowRole | null;
  state: AttendanceState;
  etaMinutes: number | null;
  reason: string | null;
  selection: "STARTER" | "BENCH" | "CUT" | null;
  source: "WEBSITE" | "DISCORD" | "ADDON" | "LEADER" | null;
  updatedAt: string | null; // ISO
};

export type CompTemplate = { tanks: number; healers: number; dps: number };

export const DEFAULT_COMP: CompTemplate = { tanks: 2, healers: 5, dps: 13 };

/** Display + sort order for states within a role column. */
export const STATE_ORDER: AttendanceState[] = [
  "CONFIRM",
  "LATE",
  "TENTATIVE",
  "ABSENT",
  "NO_RESPONSE",
];

const STATE_RANK: Record<AttendanceState, number> = Object.fromEntries(
  STATE_ORDER.map((s, i) => [s, i]),
) as Record<AttendanceState, number>;

/** A confirmed or late raider counts toward readiness (they'll be there). */
export function countsAsPresent(state: AttendanceState): boolean {
  return state === "CONFIRM" || state === "LATE";
}

export type RoleGroup = {
  role: WowRole;
  members: RosterMember[]; // ordered by STATE_ORDER then name
  present: number; // confirm + late
};

export type Readiness = {
  byRole: { TANK: number; HEAL: number; DPS: number };
  target: CompTemplate;
  present: number; // total confirm+late across roles
  total: number; // active roster size
  /** Per-role shortfall, e.g. { healers: 1 } — empty when comp is met. */
  gaps: Partial<{ tanks: number; healers: number; dps: number }>;
  met: boolean;
};

export type RosterView = {
  groups: RoleGroup[]; // TANK, HEAL, DPS (+ an "unknown role" bucket folded into DPS)
  unknownRole: RosterMember[]; // role couldn't be inferred (missing spec)
  readiness: Readiness;
  counts: Record<AttendanceState, number>;
};

const byStateThenName = (a: RosterMember, b: RosterMember) =>
  STATE_RANK[a.state] - STATE_RANK[b.state] || a.name.localeCompare(b.name);

/**
 * Build the role-grouped roster + readiness. `members` must already include a
 * row for EVERY active roster member (NO_RESPONSE where there's no signup).
 */
export function buildRoster(
  members: RosterMember[],
  comp: CompTemplate = DEFAULT_COMP,
): RosterView {
  const groups: Record<WowRole, RosterMember[]> = {
    TANK: [],
    HEAL: [],
    DPS: [],
  };
  const unknownRole: RosterMember[] = [];
  const counts: Record<AttendanceState, number> = {
    CONFIRM: 0,
    TENTATIVE: 0,
    LATE: 0,
    ABSENT: 0,
    NO_RESPONSE: 0,
  };

  for (const m of members) {
    counts[m.state] += 1;
    if (m.role) groups[m.role].push(m);
    else {
      unknownRole.push(m);
      // Fold unknown-role into DPS for readiness counting (best guess) but
      // keep them visible in their own bucket in the UI.
    }
  }

  for (const role of ["TANK", "HEAL", "DPS"] as const) {
    groups[role].sort(byStateThenName);
  }
  unknownRole.sort(byStateThenName);

  const presentBy = (rows: RosterMember[]) =>
    rows.filter((m) => countsAsPresent(m.state)).length;

  const tankP = presentBy(groups.TANK);
  const healP = presentBy(groups.HEAL);
  const dpsP = presentBy(groups.DPS) + presentBy(unknownRole);
  const present = tankP + healP + dpsP;
  const total = members.length;

  const gaps: Readiness["gaps"] = {};
  if (tankP < comp.tanks) gaps.tanks = comp.tanks - tankP;
  if (healP < comp.healers) gaps.healers = comp.healers - healP;
  if (dpsP < comp.dps) gaps.dps = comp.dps - dpsP;

  return {
    groups: (["TANK", "HEAL", "DPS"] as const).map((role) => ({
      role,
      members: groups[role],
      present: presentBy(groups[role]),
    })),
    unknownRole,
    readiness: {
      byRole: { TANK: tankP, HEAL: healP, DPS: dpsP },
      target: comp,
      present,
      total,
      gaps,
      met: Object.keys(gaps).length === 0,
    },
    counts,
  };
}

/** Parse a stored comp-template JSON into a concrete CompTemplate. */
export function parseComp(raw: unknown): CompTemplate {
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const n = (v: unknown, d: number) =>
      typeof v === "number" && v >= 0 && Number.isFinite(v) ? Math.round(v) : d;
    return {
      tanks: n(o.tanks, DEFAULT_COMP.tanks),
      healers: n(o.healers, DEFAULT_COMP.healers),
      dps: n(o.dps, DEFAULT_COMP.dps),
    };
  }
  return DEFAULT_COMP;
}
