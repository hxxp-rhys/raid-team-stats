/**
 * Pure role-gate logic for Discord interactions. A team can require a Discord
 * role to use `/statsmith link` (and, opt-in, the signup buttons). The gate
 * config lives on DiscordIntegration; this module decides — given the member's
 * roles/permissions from the interaction payload — whether they pass.
 *
 * Kept pure (no DB/IO) so it's exhaustively unit-testable; the handler loads the
 * gate from the DB and calls these.
 */

/** The slice of a Discord guild-member object we need to evaluate a gate. */
export type GateMember = {
  /** Role snowflakes the member holds (Discord omits the @everyone role). */
  roles?: string[];
  /** Computed permission bitmask in the channel, as a decimal string. */
  permissions?: string;
};

export type GateConfig = {
  /** Role required to run `/statsmith link` (null = open). */
  requiredRoleId: string | null;
  /** Role required to use the signup buttons (null = open). */
  buttonRoleId: string | null;
};

// Discord permission bit: ADMINISTRATOR (0x8). Admins always bypass a role gate
// so a leader can never lock themselves (or the server owner) out of linking.
// `BigInt(...)` (not an `8n` literal) so we don't require an ES2020 target while
// still handling the full 50+-bit permission bitmask exactly.
const ADMINISTRATOR = BigInt(8);
const ZERO = BigInt(0);

/** Does the member have the Discord Administrator permission? */
export function memberIsAdmin(member: GateMember): boolean {
  try {
    return (BigInt(member.permissions ?? "0") & ADMINISTRATOR) !== ZERO;
  } catch {
    return false; // malformed/absent → treat as non-admin (safe default)
  }
}

/** Does the member hold the given role snowflake? */
export function memberHasRole(member: GateMember, roleId: string): boolean {
  return Array.isArray(member.roles) && member.roles.includes(roleId);
}

/**
 * Does `member` pass the SIGNUP-BUTTON gate?
 *  - No `buttonRoleId` → buttons open to everyone.
 *  - Otherwise pass if the member is an admin, holds the button role, OR holds
 *    the link role (`requiredRoleId`) — so anyone allowed to link can also tap.
 */
export function passesButtonGate(
  gate: GateConfig,
  member: GateMember,
): boolean {
  if (!gate.buttonRoleId) return true;
  if (memberIsAdmin(member)) return true;
  if (memberHasRole(member, gate.buttonRoleId)) return true;
  return !!gate.requiredRoleId && memberHasRole(member, gate.requiredRoleId);
}

/**
 * Command-surface gate across all of a guild's bound teams: if ANY team in the
 * guild requires a role, the member must be an admin or hold at least one of
 * those roles. (A guild is normally one team, so this is usually a single role.)
 */
export function passesCommandGate(
  requiredRoleIds: (string | null)[],
  member: GateMember,
): boolean {
  const roles = requiredRoleIds.filter((r): r is string => !!r);
  if (roles.length === 0) return true; // no team in the guild gates the command
  if (memberIsAdmin(member)) return true;
  return roles.some((r) => memberHasRole(member, r));
}
