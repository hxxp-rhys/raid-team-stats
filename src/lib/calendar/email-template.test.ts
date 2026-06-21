import { describe, expect, it } from "vitest";

import {
  DEFAULT_NUDGE_BODY,
  DEFAULT_NUDGE_SUBJECT,
  NUDGE_SAMPLE_VARS,
  renderNudgeTemplate,
} from "./email-template";

describe("renderNudgeTemplate", () => {
  it("resolves known placeholders, whitespace-tolerant", () => {
    expect(renderNudgeTemplate("Hi {{ char_name }}!", { char_name: "Anduin" })).toBe(
      "Hi Anduin!",
    );
    expect(renderNudgeTemplate("Hi {{char_name}}!", { char_name: "Anduin" })).toBe(
      "Hi Anduin!",
    );
  });

  it("renders unknown / mistyped / wrong-case tokens as blank (never literal)", () => {
    expect(renderNudgeTemplate("X {{ char_naem }} Y", { char_name: "A" })).toBe("X  Y");
    expect(renderNudgeTemplate("X {{ Char_Name }} Y", { char_name: "A" })).toBe("X  Y");
    expect(renderNudgeTemplate("X {{ foo1 }} Y", {})).toBe("X  Y");
  });

  it("leaves a missing value blank but keeps surrounding text", () => {
    expect(renderNudgeTemplate("{{ char_name }} — {{ team_name }}", { team_name: "Eclipse" })).toBe(
      " — Eclipse",
    );
  });

  it("renders the default subject + body with no leftover tokens", () => {
    const subject = renderNudgeTemplate(DEFAULT_NUDGE_SUBJECT, NUDGE_SAMPLE_VARS);
    const body = renderNudgeTemplate(DEFAULT_NUDGE_BODY, NUDGE_SAMPLE_VARS);
    expect(subject).not.toMatch(/\{\{/);
    expect(body).not.toMatch(/\{\{/);
    expect(subject).toContain(NUDGE_SAMPLE_VARS.raid_title);
    expect(body).toContain(NUDGE_SAMPLE_VARS.team_name);
    expect(body).toContain(NUDGE_SAMPLE_VARS.event_url);
  });
});
