/**
 * custom_id routing for interaction components + modals. Discord echoes the
 * custom_id of the tapped button / submitted modal back to us, so we encode the
 * route there. Format: `<kind>|<eventId>[|<arg>]`. eventId is a cuid (no "|"),
 * and the whole string stays well under Discord's 100-char custom_id limit.
 */

export type AttendanceState = "CONFIRM" | "TENTATIVE" | "LATE" | "ABSENT";
const STATES: AttendanceState[] = ["CONFIRM", "TENTATIVE", "LATE", "ABSENT"];

export type ComponentRoute =
  | { kind: "att"; eventId: string; state: AttendanceState } // a state button
  | { kind: "refresh"; eventId: string } // re-render ephemeral
  | { kind: "eta"; eventId: string } // LATE → ETA modal submit
  | { kind: "reason"; eventId: string }; // ABSENT → reason modal submit

export function encodeRoute(route: ComponentRoute): string {
  switch (route.kind) {
    case "att":
      return `att|${route.eventId}|${route.state}`;
    case "refresh":
      return `rf|${route.eventId}`;
    case "eta":
      return `eta|${route.eventId}`;
    case "reason":
      return `rsn|${route.eventId}`;
  }
}

export function decodeRoute(customId: string): ComponentRoute | null {
  const parts = customId.split("|");
  const [kind, eventId, arg] = parts;
  if (!eventId) return null;
  switch (kind) {
    case "att":
      if (arg && (STATES as string[]).includes(arg)) {
        return { kind: "att", eventId, state: arg as AttendanceState };
      }
      return null;
    case "rf":
      return { kind: "refresh", eventId };
    case "eta":
      return { kind: "eta", eventId };
    case "rsn":
      return { kind: "reason", eventId };
    default:
      return null;
  }
}
