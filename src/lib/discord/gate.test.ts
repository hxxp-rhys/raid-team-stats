import { describe, expect, it } from "vitest";

import {
  memberHasRole,
  memberIsAdmin,
  passesButtonGate,
  passesCommandGate,
  type GateMember,
} from "./gate";

const ADMIN_PERMS = "8"; // ADMINISTRATOR bit set
const PLAIN_PERMS = "2147483648"; // some non-admin perm, no ADMINISTRATOR

const withRole = (roleId: string): GateMember => ({ roles: [roleId], permissions: PLAIN_PERMS });
const noRoles: GateMember = { roles: [], permissions: PLAIN_PERMS };
const admin: GateMember = { roles: [], permissions: ADMIN_PERMS };

describe("memberIsAdmin", () => {
  it("detects the ADMINISTRATOR bit", () => {
    expect(memberIsAdmin({ permissions: "8" })).toBe(true);
    expect(memberIsAdmin({ permissions: "9" })).toBe(true); // 0b1001 incl. admin
    expect(memberIsAdmin({ permissions: "2147483648" })).toBe(false);
  });
  it("is safe on missing/garbage permissions", () => {
    expect(memberIsAdmin({})).toBe(false);
    expect(memberIsAdmin({ permissions: "not-a-number" })).toBe(false);
  });
});

describe("memberHasRole", () => {
  it("matches an exact role snowflake", () => {
    expect(memberHasRole({ roles: ["111", "222"] }, "222")).toBe(true);
    expect(memberHasRole({ roles: ["111"] }, "222")).toBe(false);
    expect(memberHasRole({}, "222")).toBe(false);
  });
});

describe("passesButtonGate", () => {
  const link = "111"; // requiredRoleId (link role)
  const button = "222"; // buttonRoleId

  it("no button role → buttons open to everyone", () => {
    expect(passesButtonGate({ requiredRoleId: null, buttonRoleId: null }, noRoles)).toBe(true);
    // open even if a LINK role is set — only buttonRoleId gates the buttons
    expect(passesButtonGate({ requiredRoleId: link, buttonRoleId: null }, noRoles)).toBe(true);
  });

  it("button role set → blocks members with neither role", () => {
    expect(passesButtonGate({ requiredRoleId: link, buttonRoleId: button }, noRoles)).toBe(false);
    expect(passesButtonGate({ requiredRoleId: link, buttonRoleId: button }, withRole("999"))).toBe(false);
  });

  it("button role set → allows the BUTTON role OR the LINK role OR admin", () => {
    const gate = { requiredRoleId: link, buttonRoleId: button };
    expect(passesButtonGate(gate, withRole(button))).toBe(true);
    expect(passesButtonGate(gate, withRole(link))).toBe(true);
    expect(passesButtonGate(gate, admin)).toBe(true);
  });

  it("button role set with no link role → only the button role (or admin) passes", () => {
    const gate = { requiredRoleId: null, buttonRoleId: button };
    expect(passesButtonGate(gate, withRole(button))).toBe(true);
    expect(passesButtonGate(gate, withRole(link))).toBe(false);
    expect(passesButtonGate(gate, admin)).toBe(true);
  });
});

describe("passesCommandGate (guild-wide, multiple teams)", () => {
  const member = withRole("B");

  it("open when no team in the guild gates the command", () => {
    expect(passesCommandGate([null, null], noRoles)).toBe(true);
    expect(passesCommandGate([], noRoles)).toBe(true);
  });

  it("passes if the member holds ANY gating role", () => {
    expect(passesCommandGate(["A", "B"], member)).toBe(true);
    expect(passesCommandGate(["A", "C"], member)).toBe(false);
  });

  it("admins bypass regardless of role", () => {
    expect(passesCommandGate(["A", "C"], admin)).toBe(true);
  });
});
