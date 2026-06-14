import { describe, expect, it } from "vitest";

import { decodeRoute, encodeRoute, type ComponentRoute } from "./custom-id";

describe("custom-id codec", () => {
  const cases: ComponentRoute[] = [
    { kind: "att", eventId: "cmabc123", state: "CONFIRM" },
    { kind: "att", eventId: "cmabc123", state: "TENTATIVE" },
    { kind: "att", eventId: "cmabc123", state: "LATE" },
    { kind: "att", eventId: "cmabc123", state: "ABSENT" },
    { kind: "refresh", eventId: "cmabc123" },
    { kind: "eta", eventId: "cmabc123" },
    { kind: "reason", eventId: "cmabc123" },
  ];

  it("round-trips every route", () => {
    for (const route of cases) {
      const enc = encodeRoute(route);
      expect(enc.length).toBeLessThanOrEqual(100); // Discord custom_id cap
      expect(decodeRoute(enc)).toEqual(route);
    }
  });

  it("rejects malformed / unknown ids", () => {
    expect(decodeRoute("")).toBeNull();
    expect(decodeRoute("att")).toBeNull(); // no eventId
    expect(decodeRoute("att|cmabc123")).toBeNull(); // no state
    expect(decodeRoute("att|cmabc123|BOGUS")).toBeNull(); // bad state
    expect(decodeRoute("nope|cmabc123")).toBeNull(); // unknown kind
  });
});
